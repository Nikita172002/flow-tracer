/**
 * LLM integration — supports both Claude CLI and Anthropic API.
 *
 * Mode selection:
 *   - If ANTHROPIC_API_KEY is set → uses Anthropic SDK (works for anyone)
 *   - Otherwise → uses `claude` CLI (works with Claude Code Pro subscription)
 *
 * Token optimization:
 *   - Follow-ups strip code blocks from history (saves ~80% tokens)
 *   - File selection uses cheaper model (Haiku via API, same CLI otherwise)
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import crypto from "crypto";

const TMP_DIR = join(dirname(new URL(import.meta.url).pathname), "../.tmp");
mkdirSync(TMP_DIR, { recursive: true });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const FILE_SELECT_MODEL = process.env.FILE_SELECT_MODEL || "claude-haiku-4-5-20251001";
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "claude-sonnet-4-20250514";

if (API_KEY) {
  console.log(`[llm] Using Anthropic API (file selection: ${FILE_SELECT_MODEL}, analysis: ${ANALYSIS_MODEL})`);
} else {
  console.log("[llm] Using Claude CLI (no ANTHROPIC_API_KEY set)");
}

// ── System Prompt ───────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software architect who deeply understands codebases.
Your job is to analyze code from multiple repositories and answer questions about how code flows work.

CRITICAL — CROSS-REPO TRACING (this is the CORE purpose of this tool):

You are given code from MULTIPLE repositories. Your #1 job is to show how they CONNECT.

RULES:
1. ALWAYS start from the USER-FACING entry point — the page, route, or API endpoint that a user/browser/client calls first. Trace what happens on load (onMount, useEffect, init, etc.).
2. Trace the FULL call chain across repos. If Repo A calls an API in Repo B, show BOTH repos in the diagram with the actual endpoint/function name on the edge.
3. When you find a function that dispatches/delegates to multiple implementations (e.g. a switch/case, pattern match, or if-else on a type), show ALL branches — not just one or two.
4. EVERY repo that has relevant code MUST appear in the diagram. If code from 3 repos is provided, all 3 should be in the diagram.
5. Show the actual function/endpoint names that connect the repos — these are what developers search for.

MULTIPLE IMPLEMENTATIONS:
If a central function routes to multiple handlers based on type/config/platform:
- For generic questions ("how does X work?"), show ONE overview diagram with ALL branches, then a SEPARATE detailed diagram for each branch.
- For specific questions ("how does X work for Y?"), show that specific branch's full chain but still start from the entry point.

MULTIPLE ENTRY POINTS:
If multiple entry points converge on the same backend logic, show ALL entry points as separate starting nodes converging to the common function.

RESPONSE FORMAT (follow this strictly for EVERY flow):
1. ALWAYS include a Mermaid diagram for each flow. Use \`\`\`mermaid blocks.
2. IMMEDIATELY after EACH mermaid diagram, add a "### Step-by-Step" section that explains EVERY node and edge in the diagram:
   - Number each step (Step 1, Step 2, ...)
   - For each step: what function is called, which file it's in, what it does, and what it passes to the next step
   - Include the actual file path (e.g. \`src/routes/api/order/+server.ts\`)
   - Mention the data being passed between steps (request body, response shape, etc.)
3. Show API calls between services as labeled edges.
4. If you're unsure about something, say so — don't guess.
5. Keep explanations clear enough for a new developer to understand.
6. NEVER skip the step-by-step explanation. A diagram without explanation is useless.

CRITICAL mermaid syntax rules (violations cause render failures):
- Every \`end\` keyword MUST be alone on its own line
- NEVER put \`end\` and \`subgraph\` on the same line
- NEVER use \`%%\` comments — they break rendering
- Every node definition and every edge must be on its own line
- Node labels MUST be on a single line — use \`<br/>\` for line breaks, NOT actual newlines
- Keep edge labels under 50 characters
- NEVER put two edges or two statements on the same line

For mermaid diagrams:
- Use graph TD (top-down) for flows
- Use subgraph to group by repo/service
- Label edges with API paths, function calls, or data being passed
- Use different node shapes: ["UI"] for frontend, [["API"]] for backend, [("DB")] for data

Example (note: every statement on its own line, end on its own line):
\`\`\`mermaid
graph TD
    subgraph Nimble["Nimble (Frontend)"]
        A["Order Page<br/>src/routes/order/+page.svelte"]
        B["API Route<br/>src/routes/api/order/+server.ts"]
    end
    subgraph Vayu["Vayu (Backend)"]
        C[["Order Handler<br/>src/Order/Handler.hs"]]
        D[("Orders DB")]
    end
    A -->|"onMount → getOrderStatus()"| B
    B -->|"POST /api/v1/order"| C
    C -->|"INSERT order"| D
\`\`\`

Always ground your answers in the actual code provided. Reference specific files.`;

// ── Claude CLI Backend ─────────────────────────────────

function callCLI(prompt) {
  return new Promise((resolve, reject) => {
    mkdirSync(TMP_DIR, { recursive: true });
    const tmpFile = join(TMP_DIR, `prompt-${crypto.randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt);

    const proc = spawn("sh", ["-c", `cat "${tmpFile}" | claude -p --output-format text`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      try { unlinkSync(tmpFile); } catch {}
      if (code !== 0) reject(new Error(`Claude CLI error (code ${code}): ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      try { unlinkSync(tmpFile); } catch {}
      reject(new Error(`Failed to run claude CLI: ${err.message}`));
    });
  });
}

// ── Anthropic API Backend ──────────────────────────────

async function callAPI(prompt, model) {
  // Dynamic import so the SDK is only loaded if API key is set
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: API_KEY });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ── Unified Call Function ──────────────────────────────

export async function callClaude(prompt, model = ANALYSIS_MODEL) {
  const sizeKB = (prompt.length / 1024).toFixed(0);
  console.log(`[llm] Sending ${sizeKB}KB to ${API_KEY ? model : "claude CLI"}`);

  if (API_KEY) {
    return callAPI(prompt, model);
  }
  return callCLI(prompt);
}

// ── History Compression ────────────────────────────────

/**
 * Strip code blocks from a message to reduce history size.
 * Keeps the text around them so the LLM remembers what was discussed.
 */
function compressHistoryMessage(content) {
  if (typeof content !== "string") return content;

  // Replace code blocks with a placeholder showing the file path
  return content.replace(/\*\*([^*]+)\*\*:\n```[\s\S]*?```/g, "[code: $1]")
    .replace(/```[\s\S]*?```/g, "[code block omitted]");
}

/**
 * Compress conversation history for follow-ups.
 * Keeps questions and answers readable but strips the large code context.
 */
function compressHistory(history) {
  return history.map((msg) => {
    if (msg.role === "user") {
      const compressed = compressHistoryMessage(msg.content);
      // For user messages that contain code context, keep only the question
      if (compressed.length > 500) {
        // Extract just the question part (after the --- separator)
        const questionPart = msg.content.match(/\*\*Question:\*\*\s*(.*)/s);
        if (questionPart) return { role: "user", content: questionPart[1].slice(0, 300) };
        return { role: "user", content: compressed.slice(0, 500) };
      }
      return { role: "user", content: compressed };
    }
    // Keep assistant responses (they contain the analysis the user wants to build on)
    // but strip any code blocks from them too
    return { role: "assistant", content: compressHistoryMessage(msg.content) };
  });
}

// ── Code Context Builder ───────────────────────────────

function buildCodeContext(codeFiles, repoInfos) {
  let context = "## Repositories\n\n";
  for (const info of repoInfos) {
    context += `- **${info.name}**: ${info.type} (${info.languages.join(", ")}`;
    if (info.frameworks.length) context += `, ${info.frameworks.join(", ")}`;
    context += ")\n";
  }

  context += "\n## Relevant Code\n\n";
  const byRepo = {};
  for (const file of codeFiles) {
    (byRepo[file.repo] ??= []).push(file);
  }
  for (const [repo, files] of Object.entries(byRepo)) {
    context += `### ${repo}\n\n`;
    for (const f of files) {
      context += `**${f.file}**:\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
    }
  }
  return context;
}

// ── Main Question Function ─────────────────────────────

export async function askQuestion(question, relevantCode, repoInfos, conversationHistory = []) {
  const isFollowUp = conversationHistory.length > 0;
  let fullPrompt;

  if (isFollowUp) {
    // OPTIMIZED: compress history to strip code blocks (~80% smaller)
    const compressed = compressHistory(conversationHistory);
    fullPrompt = `${SYSTEM_PROMPT}\n\n[Previous conversation — code was already analyzed]\n\n`;
    for (const msg of compressed) {
      const role = msg.role === "user" ? "User" : "Assistant";
      fullPrompt += `${role}: ${msg.content}\n\n`;
    }
    fullPrompt += `User: ${question}`;
  } else {
    const codeContext = buildCodeContext(relevantCode, repoInfos);
    fullPrompt = `${SYSTEM_PROMPT}\n\n${codeContext}\n\n---\n\n**Question:** ${question}`;
  }

  const answer = await callClaude(fullPrompt, ANALYSIS_MODEL);

  // Store uncompressed history (compression happens on next follow-up)
  const userMessage = isFollowUp
    ? question
    : `${buildCodeContext(relevantCode, repoInfos)}\n\n---\n\n**Question:** ${question}`;

  const updatedHistory = [
    ...conversationHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: answer },
  ];

  return { answer, history: updatedHistory };
}

// ── File Selection (LLM Pre-Pass) ──────────────────────

export async function selectFilesViaLLM(manifest, question) {
  const prompt = `You are a code navigation expert. Select files needed to trace the code flow.

RULES:
1. Select 15-25 files maximum.
2. Start from entry points (routes, pages, HTTP handlers).
3. Follow call chain: entry → orchestrator → dispatcher → implementations.
4. Include files from EVERY repository involved.
5. Include ALL branch implementations if a dispatcher routes to multiple.
6. EXCLUDE utilities (logging, formatting, error helpers).
7. Order by importance.

Return ONLY a JSON array: [{"repo":"name","file":"path"},...]

## Files
${manifest}

## Question
${question}`;

  // Use cheaper model for file selection when using API
  const response = await callClaude(prompt, FILE_SELECT_MODEL);

  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("[llm-select] No JSON in response:", response.slice(0, 200));
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[llm-select] JSON parse error:", err.message);
    return [];
  }
}
