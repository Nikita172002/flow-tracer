/**
 * Summarizer — builds a compact manifest of what each file does.
 *
 * At index time, reads every code file and extracts:
 *   - Exported/top-level function/class names (via regex, not AST)
 *   - Import list
 *   - First doc comment (if any)
 *
 * Produces a manifest string (~50-80 bytes per file) that an LLM can read
 * to understand the entire codebase structure and pick the right files
 * for a given question.
 */

import { readFileSync } from "fs";
import { extname } from "path";

/**
 * Extract exported/top-level function and class names from file content.
 * Language-detected by file extension. Returns short strings like:
 *   "export function findOrCreateOrder", "createOrder :: CartId -> Handler Order"
 */
function extractSignatures(content, filePath) {
  const ext = extname(filePath).toLowerCase();
  const sigs = [];

  switch (ext) {
    case ".ts":
    case ".js":
    case ".tsx":
    case ".jsx": {
      // export function/const/class/type/interface
      for (const m of content.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/gm)) {
        sigs.push(m[0].slice(0, 80));
      }
      // export default function/class
      for (const m of content.matchAll(/^export\s+default\s+(?:async\s+)?(?:function|class)\s*(\w*)/gm)) {
        sigs.push(m[0].slice(0, 80));
      }
      // HTTP handlers: app.get/post, router.get/post, GET/POST/PATCH (SvelteKit)
      for (const m of content.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/gm)) {
        sigs.push(m[0].slice(0, 80));
      }
      // Express-style routes
      for (const m of content.matchAll(/(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/gm)) {
        sigs.push(`${m[1].toUpperCase()} ${m[2]}`);
      }
      break;
    }

    case ".svelte": {
      // onMount, reactive statements, exported props
      for (const m of content.matchAll(/onMount\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g)) {
        sigs.push("onMount handler");
      }
      for (const m of content.matchAll(/export\s+let\s+(\w+)/gm)) {
        sigs.push(`prop: ${m[1]}`);
      }
      // Key function calls in script block
      for (const m of content.matchAll(/(?:await\s+)?(\w+)\s*\(/gm)) {
        if (m[1].length > 3 && /^[a-z]/.test(m[1]) && !["import", "require", "console", "window", "document", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "then", "catch", "finally", "push", "filter", "map", "reduce", "forEach", "find", "some", "every", "slice", "splice", "join", "split", "replace", "match", "test", "includes", "indexOf", "toString", "valueOf", "parse", "stringify", "assign", "keys", "values", "entries"].includes(m[1])) {
          sigs.push(`calls: ${m[1]}`);
        }
      }
      // Deduplicate calls
      break;
    }

    case ".hs": {
      // Module exports: module Foo (bar, baz) where
      const moduleMatch = content.match(/^module\s+\S+\s*\(([\s\S]*?)\)\s*where/m);
      if (moduleMatch) {
        const exports = moduleMatch[1].replace(/\s+/g, " ").trim();
        if (exports.length < 200) sigs.push(`exports: ${exports}`);
        else sigs.push(`exports: ${exports.slice(0, 200)}...`);
      }
      // Top-level type signatures: functionName :: Type
      for (const m of content.matchAll(/^(\w+)\s*::\s*(.+)$/gm)) {
        const sig = `${m[1]} :: ${m[2].slice(0, 60)}`;
        sigs.push(sig);
      }
      break;
    }

    case ".py": {
      // def and class
      for (const m of content.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
        sigs.push(`def ${m[1]}`);
      }
      for (const m of content.matchAll(/^class\s+(\w+)/gm)) {
        sigs.push(`class ${m[1]}`);
      }
      // Flask/FastAPI routes
      for (const m of content.matchAll(/@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)/gm)) {
        sigs.push(`${m[1].toUpperCase()} ${m[2]}`);
      }
      break;
    }

    case ".go": {
      // func declarations
      for (const m of content.matchAll(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm)) {
        sigs.push(`func ${m[1]}`);
      }
      break;
    }

    case ".rs": {
      // pub fn, pub struct, impl
      for (const m of content.matchAll(/^pub\s+(?:async\s+)?fn\s+(\w+)/gm)) {
        sigs.push(`pub fn ${m[1]}`);
      }
      for (const m of content.matchAll(/^pub\s+struct\s+(\w+)/gm)) {
        sigs.push(`pub struct ${m[1]}`);
      }
      break;
    }

    case ".java":
    case ".kt": {
      // public/private methods and classes
      for (const m of content.matchAll(/(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|fun|void|\w+)\s+(\w+)/gm)) {
        sigs.push(m[0].slice(0, 80));
      }
      break;
    }

    case ".rb": {
      for (const m of content.matchAll(/^\s*def\s+(\w+)/gm)) sigs.push(`def ${m[1]}`);
      for (const m of content.matchAll(/^\s*class\s+(\w+)/gm)) sigs.push(`class ${m[1]}`);
      break;
    }

    case ".php": {
      for (const m of content.matchAll(/(?:public|private|protected)\s+function\s+(\w+)/gm)) {
        sigs.push(`function ${m[1]}`);
      }
      break;
    }
  }

  // Deduplicate
  return [...new Set(sigs)].slice(0, 20); // Cap at 20 signatures per file
}

/**
 * Extract the first doc comment from a file (first 150 chars).
 */
function extractFirstComment(content) {
  // JS/TS/Java block comment: /** ... */ or /* ... */
  const blockMatch = content.match(/\/\*\*?([\s\S]*?)\*\//);
  if (blockMatch) {
    const text = blockMatch[1].replace(/^\s*\*\s?/gm, "").trim();
    return text.slice(0, 150);
  }

  // Haskell: {- ... -} or -- | ... lines
  const hsBlock = content.match(/\{-([\s\S]*?)-\}/);
  if (hsBlock) return hsBlock[1].trim().slice(0, 150);

  // Python: """...""" or '''...'''
  const pyMatch = content.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/m);
  if (pyMatch) return (pyMatch[1] || pyMatch[2]).trim().slice(0, 150);

  // Leading // or # comments
  const lines = content.split("\n");
  const commentLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) {
      commentLines.push(trimmed.replace(/^(?:\/\/|#|--)\s?/, ""));
    } else if (trimmed && !trimmed.startsWith("import") && !trimmed.startsWith("module")) {
      break;
    }
  }
  if (commentLines.length > 0) return commentLines.join(" ").slice(0, 150);

  return "";
}

/**
 * Extract import module names from content (short form, not full paths).
 * Returns compact import list like: ["OrderProcessing", "Cart.Main", "Platform.Order"]
 */
function extractImportNames(content, filePath) {
  const ext = extname(filePath).toLowerCase();
  const imports = [];

  if ([".ts", ".js", ".tsx", ".jsx", ".svelte"].includes(ext)) {
    // from './foo/bar' → bar
    // from '$lib/server/vayu' → vayu
    for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/gm)) {
      const imp = m[1];
      // Get last meaningful segment
      const segments = imp.split("/").filter(s => !s.startsWith(".") && !s.startsWith("$"));
      const last = segments[segments.length - 1] || imp.split("/").pop();
      if (last && last.length > 1 && !last.startsWith("@")) imports.push(last);
    }
  }

  if (ext === ".hs") {
    for (const m of content.matchAll(/^import\s+(?:qualified\s+)?(\S+)/gm)) {
      // Shorten: Vayu.Services.Internal.Order.Main → Order.Main
      const parts = m[1].split(".");
      imports.push(parts.slice(-2).join("."));
    }
  }

  if (ext === ".py") {
    for (const m of content.matchAll(/^(?:from|import)\s+([\w.]+)/gm)) {
      const parts = m[1].split(".");
      imports.push(parts.slice(-2).join("."));
    }
  }

  if (ext === ".go") {
    for (const m of content.matchAll(/import\s+(?:\w+\s+)?"([^"]+)"/gm)) {
      imports.push(m[1].split("/").pop());
    }
  }

  return [...new Set(imports)].slice(0, 15);
}

/**
 * Build a compact manifest of all files across all repos.
 * This is what the LLM reads to decide which files to select for a question.
 */
/**
 * Build a compact manifest. Target: under 120KB so it fits in one Claude call.
 *
 * Format per file (single line, very compact):
 *   [repo] path/to/file.ts | sigs: fn1, fn2 | imports: mod1, mod2
 */
/**
 * Check if a file is likely to contain meaningful business logic
 * (not just utilities, config, types, or boilerplate).
 */
function isLikelyRelevant(filePath, sigCount) {
  // Keep any file with at least 1 exported function/signature
  if (sigCount >= 1) return true;

  // Drop files with zero signatures (config, data, pure type defs)
  return false;
}

export function buildManifest(indexedRepos) {
  const entries = [];

  for (const repoIndex of indexedRepos) {
    const repoName = repoIndex.repo.name;

    for (const fileInfo of repoIndex.files) {
      try {
        const content = readFileSync(fileInfo.fullPath, "utf-8");
        if (content.trim().length === 0) continue;

        const sigs = extractSignatures(content, fileInfo.file).slice(0, 5);
        const imports = extractImportNames(content, fileInfo.file).slice(0, 6);

        // Pre-filter: skip files with no exported functions
        if (!isLikelyRelevant(fileInfo.file, sigs.length)) continue;

        let line = `[${repoName}] ${fileInfo.file}`;
        if (sigs.length > 0) line += ` | ${sigs.join(", ")}`;
        if (imports.length > 0) line += ` | imports: ${imports.join(", ")}`;

        // Hard cap line length to 140 chars
        if (line.length > 140) line = line.slice(0, 137) + "...";

        entries.push(line);
      } catch {
        // Skip unreadable files entirely (no point listing path-only entries)
      }
    }
  }

  let manifest = entries.join("\n");
  console.log(`[manifest] ${entries.length} files, ${(manifest.length / 1024).toFixed(0)}KB`);

  // If still too large, progressively compress
  if (manifest.length > 120_000) {
    // First: truncate long lines
    manifest = manifest.split("\n").map(l => l.length > 120 ? l.slice(0, 117) + "..." : l).join("\n");
    console.log(`[manifest] Truncated lines → ${(manifest.length / 1024).toFixed(0)}KB`);
  }

  if (manifest.length > 120_000) {
    // Last resort: hard cap
    const lines = manifest.split("\n");
    let total = 0;
    const kept = [];
    for (const line of lines) {
      if (total + line.length + 1 > 120_000) break;
      kept.push(line);
      total += line.length + 1;
    }
    manifest = kept.join("\n");
    console.log(`[manifest] Hard capped: ${kept.length}/${lines.length} files → ${(manifest.length / 1024).toFixed(0)}KB`);
  }

  return manifest;
}
