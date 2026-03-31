# FlowTracer

Trace code flows across multiple repos. Ask questions in English, get mermaid diagrams + step-by-step explanations.

```
You: "How does order creation work?"
FlowTracer: [mermaid diagram showing Frontend → API → Backend → DB across all repos]
            + step-by-step explanation with file paths and function names
```

Works with **any language** (TypeScript, Haskell, Python, Go, Java, Rust, etc.) and **any number of repos**.

## Quick Start

### Option A: MCP Server (recommended for Claude Code users)

```bash
# Add to Claude Code (one-time)
claude mcp add flow-tracer -- npx flow-tracer

# Then in Claude Code, just say:
#   "Register repos /path/to/frontend and /path/to/backend"
#   "How does the checkout flow work?"
```

### Option B: Web UI

```bash
npx flow-tracer serve
# Open http://localhost:3847
# Enter repo paths, ask questions, see diagrams in browser
```

### Option C: Clone and run locally

```bash
git clone <repo-url>
cd flow-tracer
npm install
node bin/flow-tracer.js serve     # web UI
# or
node bin/flow-tracer.js mcp       # MCP server
```

## Authentication

FlowTracer needs access to a Claude model. Two options:

### Option 1: Claude Code Pro (no setup needed)

If you have a Claude Code subscription, it works automatically — uses the `claude` CLI under the hood.

### Option 2: Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up / log in
3. Go to **Settings > API Keys**
4. Click **Create Key**
5. Copy the key (starts with `sk-ant-api03-...`)

```bash
# Set the key
export ANTHROPIC_API_KEY=sk-ant-api03-...

# Then run
npx flow-tracer serve
```

New accounts get **$5 free credits**. Cost per question: ~3.5 cents.

**Optional env vars:**

```bash
ANTHROPIC_API_KEY=sk-ant-...                    # Required if no Claude CLI
FILE_SELECT_MODEL=claude-haiku-4-5-20251001     # Cheap model for file picking (default)
ANALYSIS_MODEL=claude-sonnet-4-20250514         # Quality model for analysis (default)
PORT=3847                                        # Web UI port (default)
```

## How It Works

```
1. REGISTER: You give it repo paths. It scans all files and builds a
   compact manifest (function signatures + imports for each file).

2. ASK: You ask a question. Two LLM calls happen:
   Call #1 (fast): LLM reads the manifest and picks 15-25 relevant files
   Call #2 (deep): LLM reads those files and generates diagrams + explanation

3. FOLLOW UP: Ask more questions — the conversation context is preserved.
```

The key insight: instead of keyword-matching file paths (which misses critical files), we let the LLM read function signatures and imports to understand what each file does, then pick the right ones.

## MCP Tools

When used as an MCP server, FlowTracer exposes:

| Tool | Description |
|------|-------------|
| `register_repos` | Register repo paths to index. Call this first. |
| `trace_flow` | Ask a question about code flows. Returns mermaid + explanation. |
| `follow_up` | Follow-up question using previous conversation context. |
| `list_repos` | List all registered repo groups. |

## Project Structure

```
flow-tracer/
├── bin/flow-tracer.js      # CLI entry point (mcp or serve)
├── src/
│   ├── mcp.js              # MCP server (for Claude Code/Desktop)
│   ├── server.js           # Express web server (browser UI)
│   ├── indexer.js           # Repo scanner + LLM-guided file selection
│   ├── llm.js              # Claude integration (CLI + API dual mode)
│   ├── summarizer.js        # Builds file manifest (signatures + imports)
│   └── public/index.html   # Chat UI with mermaid rendering
├── package.json
└── README.md
```

## Examples

```
"How does order creation work?"
"What happens when a user clicks checkout?"
"Trace the payment flow from frontend to backend"
"How does the cart sync between Shopify and our backend?"
"What services are involved in the refund flow?"
"Show me how authentication works across repos"
```
