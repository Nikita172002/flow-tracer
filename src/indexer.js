/**
 * Repo-agnostic code indexer.
 *
 * ZERO hardcoded repo names, file patterns, or framework-specific logic.
 *
 * Strategy:
 *   1. Index: scan repos, store file paths (no content loaded)
 *   2. At query time: LLM reads a manifest of all files and picks the right ones
 */

import { readFileSync, existsSync, statSync } from "fs";
import { glob } from "glob";
import { join, extname, basename, dirname } from "path";

const CODE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".svelte", ".vue",
  ".py", ".go", ".rs", ".hs", ".java", ".kt", ".rb",
  ".php", ".cs", ".swift", ".dart", ".scala",
  ".json", ".yaml", ".yml", ".toml",
]);

const IGNORE_DIRS = [
  "**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**",
  "**/.svelte-kit/**", "**/target/**", "**/__pycache__/**",
  "**/vendor/**", "**/.git/**", "**/coverage/**", "**/generated/**",
  "**/test/**", "**/tests/**", "**/__tests__/**", "**/playwright*/**",
  "**/*.min.js", "**/*.bundle.js",
];

const MAX_FILE_SIZE = 50_000;

function detectRepoInfo(repoPath) {
  const info = { name: basename(repoPath), languages: [], frameworks: [], type: "unknown" };
  const checks = [
    { file: "package.json", detect: (c) => {
      const pkg = JSON.parse(c);
      info.languages.push("typescript/javascript");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [k] of Object.entries(deps || {})) {
        if (k === "svelte") info.frameworks.push("svelte");
        if (k === "@sveltejs/kit") info.frameworks.push("sveltekit");
        if (k === "react") info.frameworks.push("react");
        if (k === "next") info.frameworks.push("next.js");
        if (k === "express") info.frameworks.push("express");
        if (k === "vue") info.frameworks.push("vue");
        if (k === "@nestjs/core") info.frameworks.push("nestjs");
      }
    }},
    { file: "go.mod",           detect: () => info.languages.push("go") },
    { file: "Cargo.toml",       detect: () => info.languages.push("rust") },
    { file: "stack.yaml",       detect: () => info.languages.push("haskell") },
    { file: "package.yaml",     detect: () => info.languages.push("haskell") },
    { file: "requirements.txt", detect: () => info.languages.push("python") },
    { file: "pyproject.toml",   detect: () => info.languages.push("python") },
    { file: "pom.xml",          detect: () => info.languages.push("java") },
    { file: "build.gradle",     detect: () => info.languages.push("java/kotlin") },
    { file: "Gemfile",          detect: () => info.languages.push("ruby") },
    { file: "composer.json",    detect: () => info.languages.push("php") },
  ];
  for (const { file, detect } of checks) {
    try { if (existsSync(join(repoPath, file))) detect(readFileSync(join(repoPath, file), "utf-8")); } catch {}
  }
  return info;
}

export function indexRepo(repoPath) {
  if (!existsSync(repoPath)) throw new Error(`Repo not found: ${repoPath}`);
  const repoInfo = detectRepoInfo(repoPath);
  const allFiles = glob.sync("**/*", { cwd: repoPath, nodir: true, ignore: IGNORE_DIRS });
  const codeFiles = [];
  for (const file of allFiles) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue;
    const fullPath = join(repoPath, file);
    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      codeFiles.push({ file, size: stat.size, fullPath });
    } catch {}
  }
  return { repo: repoInfo, repoPath, files: codeFiles, stats: { totalFiles: codeFiles.length } };
}

export function indexRepos(repoPaths) {
  const results = [];
  for (const p of repoPaths) {
    console.log(`[index] Scanning ${p}...`);
    const r = indexRepo(p);
    console.log(`[index] ${r.repo.name}: ${r.stats.totalFiles} files`);
    results.push(r);
  }
  return results;
}

// ── File selection (LLM-guided) ─────────────────────────

/**
 * Select relevant code files using LLM-guided selection.
 *
 * Step 1: Ask Claude to read the manifest and pick 15-25 files
 * Step 2: Load those files, respecting 120KB budget
 * Step 3: If LLM fails, fall back to keyword matching
 */
export async function selectRelevantCode(indexedRepos, question, manifest) {
  // Build lookup map
  const fileMap = new Map();
  for (const repoIndex of indexedRepos) {
    for (const fileInfo of repoIndex.files) {
      fileMap.set(`${repoIndex.repo.name}::${fileInfo.file}`, {
        ...fileInfo,
        repo: repoIndex.repo.name,
      });
    }
  }

  let selectedPaths = [];

  // ── Step 1: LLM pre-pass ──
  if (manifest) {
    try {
      const { selectFilesViaLLM } = await import("./llm.js");
      console.log(`[select] Asking LLM to pick files from manifest (${(manifest.length / 1024).toFixed(0)}KB)...`);
      selectedPaths = await selectFilesViaLLM(manifest, question);
      console.log(`[select] LLM selected ${selectedPaths.length} files`);
    } catch (err) {
      console.error(`[select] LLM pre-pass failed: ${err.message}`);
    }
  }

  // ── Step 2: Load LLM-selected files ──
  if (selectedPaths.length > 0) {
    const selected = [];
    let totalChars = 0;

    for (const entry of selectedPaths) {
      const key = `${entry.repo}::${entry.file}`;
      let fileInfo = fileMap.get(key);

      // Fuzzy match if exact key not found
      if (!fileInfo) {
        const fuzzy = [...fileMap.entries()].find(([k]) =>
          k.endsWith(entry.file) || k.includes(entry.file)
        );
        if (fuzzy) fileInfo = fuzzy[1];
      }

      if (!fileInfo) continue;

      try {
        const content = readFileSync(fileInfo.fullPath, "utf-8");
        if (content.trim().length === 0) continue;
        if (totalChars + content.length > 120_000) continue;
        totalChars += content.length;
        selected.push({ repo: fileInfo.repo, file: fileInfo.file, content, score: 100 - selected.length });
      } catch {}
    }

    if (selected.length >= 5) {
      const byRepo = {};
      for (const s of selected) byRepo[s.repo] = (byRepo[s.repo] || 0) + 1;
      console.log(`[select] Loaded ${selected.length} files (${(totalChars / 1024).toFixed(0)}KB): ${Object.entries(byRepo).map(([r, c]) => `${r}(${c})`).join(", ")}`);
      return selected;
    }

    console.log(`[select] LLM returned too few (${selected.length}), falling back`);
  }

  // ── Step 3: Fallback — keyword matching ──
  console.log("[select] Using keyword fallback");
  const stopWords = new Set([
    "how", "does", "the", "work", "works", "for", "what", "show", "give",
    "can", "you", "tell", "explain", "flow", "complete", "from", "frontend",
    "backend", "with", "mermaid", "diagram", "end", "start", "and", "all",
    "me", "please", "this", "that", "are", "is", "a", "an", "to", "in",
    "of", "do", "get", "make", "create", "each", "different", "between",
  ]);
  const keywords = question.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

  const scored = [];
  for (const repoIndex of indexedRepos) {
    for (const fileInfo of repoIndex.files) {
      const pathLower = fileInfo.file.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (pathLower.includes(kw)) score += 10;
      }
      if (score > 0) scored.push({ ...fileInfo, repo: repoIndex.repo.name, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = [];
  let totalChars = 0;
  for (const fileInfo of scored.slice(0, 80)) {
    try {
      const content = readFileSync(fileInfo.fullPath, "utf-8");
      if (content.trim().length === 0) continue;
      if (totalChars + content.length > 120_000) continue;
      totalChars += content.length;
      selected.push({ repo: fileInfo.repo, file: fileInfo.file, content, score: fileInfo.score });
    } catch {}
  }

  const byRepo = {};
  for (const s of selected) byRepo[s.repo] = (byRepo[s.repo] || 0) + 1;
  console.log(`[select] Fallback: ${selected.length} files (${(totalChars / 1024).toFixed(0)}KB): ${Object.entries(byRepo).map(([r, c]) => `${r}(${c})`).join(", ")}`);
  return selected;
}
