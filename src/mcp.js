/**
 * FlowTracer MCP Server
 *
 * Exposes code flow tracing as MCP tools for Claude Code / Claude Desktop.
 *
 * Setup:
 *   claude mcp add flow-tracer -- npx flow-tracer
 *   # or
 *   claude mcp add flow-tracer -- node /path/to/flow-tracer/bin/flow-tracer.js
 *
 * Tools:
 *   - register_repos:  Register repo paths to index
 *   - trace_flow:      Ask a question about code flows
 *   - follow_up:       Follow-up question on previous trace
 *   - list_repos:      List registered repo groups
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexRepos, selectRelevantCode } from "./indexer.js";
import { askQuestion } from "./llm.js";
import { buildManifest } from "./summarizer.js";

// ── State (same as server.js but in-process) ───────────

const repoStore = new Map();
const sessions = new Map();

// ── MCP Server ──────────────────────────────────────────

const server = new McpServer({
  name: "flow-tracer",
  version: "0.2.0",
  description: "Trace code flows across repos — get mermaid diagrams and step-by-step explanations",
});

// ── Tool: register_repos ────────────────────────────────

server.tool(
  "register_repos",
  "Register local repo paths to index. Must be called before trace_flow.",
  {
    name: z.string().describe("Group name for this set of repos (e.g. 'my-platform')"),
    paths: z.array(z.string()).describe("Array of absolute paths to repo directories"),
  },
  async ({ name, paths }) => {
    try {
      const indexed = indexRepos(paths);
      const totalFiles = indexed.reduce((sum, r) => sum + r.stats.totalFiles, 0);
      const manifest = buildManifest(indexed);

      repoStore.set(name, { paths, indexed, manifest, indexedAt: new Date().toISOString() });

      const repoSummary = indexed.map((r) =>
        `${r.repo.name}: ${r.stats.totalFiles} files (${r.repo.languages.join(", ")})`
      ).join("\n");

      return {
        content: [{
          type: "text",
          text: `Indexed ${paths.length} repos as "${name}" (${totalFiles} files total).\n\n${repoSummary}\n\nManifest: ${(manifest.length / 1024).toFixed(0)}KB\n\nYou can now use trace_flow with repos="${name}".`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error indexing: ${err.message}` }] };
    }
  }
);

// ── Tool: trace_flow ────────────────────────────────────

server.tool(
  "trace_flow",
  "Trace a code flow across repositories. Returns mermaid diagrams and step-by-step explanation. Call register_repos first.",
  {
    repos: z.string().describe("Repo group name (from register_repos)"),
    question: z.string().describe("Question about the code flow (e.g. 'How does order creation work?', 'What happens when a user clicks checkout?')"),
  },
  async ({ repos: repoGroupName, question }) => {
    const repoGroup = repoStore.get(repoGroupName);
    if (!repoGroup) {
      const available = [...repoStore.keys()];
      return {
        content: [{
          type: "text",
          text: `Repo group "${repoGroupName}" not found. ${available.length ? `Available: ${available.join(", ")}` : "Call register_repos first."}`,
        }],
      };
    }

    try {
      const relevantCode = await selectRelevantCode(repoGroup.indexed, question, repoGroup.manifest);
      const repoInfos = repoGroup.indexed.map((r) => r.repo);
      const { answer, history } = await askQuestion(question, relevantCode, repoInfos);

      // Store session for follow-ups
      const sessionId = `session-${Date.now()}`;
      sessions.set(sessionId, {
        history,
        repoGroup: repoGroupName,
        lastQuestion: question,
      });

      // Keep only last 5 sessions
      if (sessions.size > 5) {
        const oldest = sessions.keys().next().value;
        sessions.delete(oldest);
      }

      return {
        content: [{
          type: "text",
          text: `${answer}\n\n---\n_Session: ${sessionId} | Files analyzed: ${relevantCode.length} | Use follow_up tool to ask more._`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// ── Tool: follow_up ─────────────────────────────────────

server.tool(
  "follow_up",
  "Ask a follow-up question about a previous trace. Uses conversation context from the last trace_flow call.",
  {
    question: z.string().describe("Follow-up question (e.g. 'What happens if payment fails?', 'Show me the refund flow')"),
    session_id: z.string().optional().describe("Session ID from a previous trace_flow. If omitted, uses the most recent session."),
  },
  async ({ question, session_id }) => {
    // Find session
    let session;
    if (session_id) {
      session = sessions.get(session_id);
    } else {
      // Use most recent session
      const entries = [...sessions.entries()];
      if (entries.length > 0) {
        [, session] = entries[entries.length - 1];
      }
    }

    if (!session) {
      return {
        content: [{
          type: "text",
          text: "No previous session found. Use trace_flow first to start a conversation.",
        }],
      };
    }

    const repoGroup = repoStore.get(session.repoGroup);
    if (!repoGroup) {
      return { content: [{ type: "text", text: `Repo group "${session.repoGroup}" no longer registered.` }] };
    }

    try {
      const repoInfos = repoGroup.indexed.map((r) => r.repo);

      // Check if follow-up needs new code context
      const additionalCode = await selectRelevantCode(repoGroup.indexed, question, repoGroup.manifest);
      let enrichedQuestion = question;

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

      return {
        content: [{
          type: "text",
          text: `${answer}\n\n---\n_Conversation: ${session.history.length} messages | Use follow_up for more questions._`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// ── Tool: list_repos ────────────────────────────────────

server.tool(
  "list_repos",
  "List all registered repo groups and their contents.",
  {},
  async () => {
    if (repoStore.size === 0) {
      return {
        content: [{
          type: "text",
          text: "No repos registered. Use register_repos to add repo paths.",
        }],
      };
    }

    let output = "# Registered Repo Groups\n\n";
    for (const [name, data] of repoStore) {
      output += `## ${name}\n`;
      output += `Indexed: ${data.indexedAt}\n\n`;
      for (const r of data.indexed) {
        output += `- **${r.repo.name}**: ${r.stats.totalFiles} files (${r.repo.languages.join(", ")})\n`;
      }
      output += "\n";
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// ── Start ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
