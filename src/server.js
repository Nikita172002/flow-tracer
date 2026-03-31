/**
 * FlowTracer Server
 *
 * POST /repos          — Register repos to index
 * GET  /repos          — List registered repos
 * POST /ask            — Ask a question (returns mermaid + explanation)
 * POST /ask/:sessionId — Follow-up question on an existing conversation
 * GET  /sessions       — List active sessions
 *
 * Deploy anywhere that runs Node.js.
 * Auth: set ANTHROPIC_API_KEY env var, OR have `claude` CLI installed (Pro plan).
 */

import express from "express";
import crypto from "crypto";
import { dirname, join } from "path";
import { indexRepos, selectRelevantCode } from "./indexer.js";
import { askQuestion } from "./llm.js";
import { buildManifest } from "./summarizer.js";

const __dirname = dirname(new URL(import.meta.url).pathname);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── State ───────────────────────────────────────────────

/** @type {Map<string, { paths: string[], indexed: Array, indexedAt: string }>} */
const repoStore = new Map();

/** @type {Map<string, { history: Array, repoGroup: string, createdAt: string, lastQuestion: string }>} */
const sessions = new Map();

// ── Routes ──────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "FlowTracer",
    description: "Ask questions about code flows across any repos — get mermaid diagrams and conversational answers",
    endpoints: {
      "POST /repos": "Register repos to index. Body: { name: string, paths: string[] }",
      "GET /repos": "List registered repo groups",
      "POST /ask": "Ask a question. Body: { repos: string, question: string }",
      "POST /ask/:sessionId": "Follow-up question. Body: { question: string }",
      "GET /sessions": "List active conversation sessions",
    },
  });
});

/**
 * POST /repos — Register and index a group of repos.
 *
 * Body: { name: "my-platform", paths: ["/path/to/repo1", "/path/to/repo2"] }
 *
 * Indexes all repos and stores the result. Re-posting the same name re-indexes.
 */
app.post("/repos", async (req, res) => {
  const { name, paths } = req.body;

  if (!name || !paths?.length) {
    return res.status(400).json({ error: "Required: { name: string, paths: string[] }" });
  }

  try {
    console.log(`[repos] Indexing "${name}" with ${paths.length} repos...`);
    const indexed = indexRepos(paths);
    const totalFiles = indexed.reduce((sum, r) => sum + r.stats.totalFiles, 0);

    console.log(`[repos] Building manifest...`);
    const manifest = buildManifest(indexed);

    repoStore.set(name, { paths, indexed, manifest, indexedAt: new Date().toISOString() });

    console.log(`[repos] "${name}" indexed: ${totalFiles} files`);
    res.json({
      message: `Indexed ${paths.length} repos as "${name}"`,
      repos: indexed.map((r) => ({
        name: r.repo.name,
        type: r.repo.type,
        languages: r.repo.languages,
        frameworks: r.repo.frameworks,
        files: r.stats.totalFiles,
      })),
      totals: { files: totalFiles },
    });
  } catch (err) {
    console.error(`[repos] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /repos — List all registered repo groups.
 */
app.get("/repos", (_req, res) => {
  const groups = [];
  for (const [name, data] of repoStore) {
    groups.push({
      name,
      paths: data.paths,
      indexedAt: data.indexedAt,
      repos: data.indexed.map((r) => ({
        name: r.repo.name,
        type: r.repo.type,
        files: r.stats.totalFiles,
      })),
    });
  }
  res.json(groups);
});

/**
 * POST /ask — Ask a new question about a repo group.
 *
 * Body: { repos: "my-platform", question: "How does order flow work for magento?" }
 *
 * Returns: { sessionId, answer (with mermaid diagram), repos used }
 */
app.post("/ask", async (req, res) => {
  const { repos: repoGroupName, question } = req.body;

  if (!repoGroupName || !question) {
    return res.status(400).json({ error: "Required: { repos: string, question: string }" });
  }

  const repoGroup = repoStore.get(repoGroupName);
  if (!repoGroup) {
    return res.status(404).json({
      error: `Repo group "${repoGroupName}" not found. Register repos first via POST /repos.`,
      available: [...repoStore.keys()],
    });
  }

  try {
    console.log(`[ask] Question: "${question}" (repos: ${repoGroupName})`);

    const relevantCode = await selectRelevantCode(repoGroup.indexed, question, repoGroup.manifest);
    const repoInfos = repoGroup.indexed.map((r) => r.repo);

    console.log(`[ask] Selected ${relevantCode.length} relevant files`);

    const { answer, history } = await askQuestion(question, relevantCode, repoInfos);

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      history,
      repoGroup: repoGroupName,
      createdAt: new Date().toISOString(),
      lastQuestion: question,
    });

    console.log(`[ask] Session ${sessionId} created`);

    res.json({
      sessionId,
      answer,
      filesUsed: relevantCode.length,
      repos: repoInfos.map((r) => r.name),
    });
  } catch (err) {
    console.error(`[ask] Error:`, err.message);
    console.error(`[ask] Stack:`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /ask/:sessionId — Follow-up question on an existing conversation.
 *
 * Body: { question: "What happens if the payment fails?" }
 *
 * The LLM already has the code context and previous answers in memory.
 */
app.post("/ask/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: "Required: { question: string }" });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: `Session "${sessionId}" not found. Start a new conversation via POST /ask.` });
  }

  const repoGroup = repoStore.get(session.repoGroup);

  try {
    console.log(`[follow-up] Session ${sessionId}: "${question}"`);

    const repoInfos = repoGroup.indexed.map((r) => r.repo);

    // For follow-ups, check if we need additional code context
    const additionalCode = await selectRelevantCode(repoGroup.indexed, question, repoGroup.manifest);
    let enrichedQuestion = question;

    // Inject new files not already in conversation
    const newFiles = additionalCode
      .filter((c) => !session.history.some((m) =>
        typeof m.content === "string" && m.content.includes(c.file)
      ))
      .slice(0, 15);

    if (newFiles.length > 0) {
      let extra = "\n\n[Additional code context for this follow-up]\n\n";
      for (const f of newFiles) {
        extra += `**${f.repo}/${f.file}**:\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
      }
      enrichedQuestion = extra + question;
    }

    const { answer, history } = await askQuestion(enrichedQuestion, [], repoInfos, session.history);

    session.history = history;
    session.lastQuestion = question;

    res.json({
      sessionId,
      answer,
      conversationLength: history.length,
    });
  } catch (err) {
    console.error(`[follow-up] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions — List active conversation sessions.
 */
app.get("/sessions", (_req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      repoGroup: session.repoGroup,
      createdAt: session.createdAt,
      lastQuestion: session.lastQuestion,
      messages: session.history.length,
    });
  }
  res.json(list);
});

// ── Start ───────────────────────────────────────────────

const PORT = process.env.PORT || 3847;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║           FlowTracer Server                  ║
║          http://localhost:${PORT}              ║
╚══════════════════════════════════════════════╝

Ready. Usage:

1. Register repos:
   curl -X POST http://localhost:${PORT}/repos \\
     -H "Content-Type: application/json" \\
     -d '{"name": "my-platform", "paths": ["/path/to/repo1", "/path/to/repo2"]}'

2. Ask a question:
   curl -X POST http://localhost:${PORT}/ask \\
     -H "Content-Type: application/json" \\
     -d '{"repos": "my-platform", "question": "How does the order flow work?"}'

3. Follow up:
   curl -X POST http://localhost:${PORT}/ask/<sessionId> \\
     -H "Content-Type: application/json" \\
     -d '{"question": "What happens if payment fails?"}'
  `);
});
