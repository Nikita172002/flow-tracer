# FlowTracer: Cross-Repo Code Flow Intelligence

## What It Does

Ask questions about code flows in plain English → get mermaid diagrams + detailed explanations.

Works across **any repos** — just point it at your repo paths and ask.

```
You:   "How does the order flow work for magento?"
Tool:  [mermaid diagram] + step-by-step explanation with file references

You:   "What happens if the payment fails?"
Tool:  [error handling flow diagram] + code-level detail (follows conversation context)
```

---

## Problem

- A new developer asks "how does order placement work?" → answer spans 5+ repos, nobody can explain without a 2-hour walkthrough
- Critical flow knowledge lives in 2-3 senior engineers' heads
- Making changes requires manually tracing code across repos
- Impact analysis is guesswork

## Solution

A deployable web service with a chat UI that:
1. Indexes any repos you give it (auto-detects language/framework)
2. Answers flow questions using LLM with actual code context
3. Generates mermaid diagrams for every answer
4. Supports follow-up questions (conversational)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  FlowTracer Server                   │
│                                                     │
│  POST /repos ──→ Indexer ──→ File Metadata Store    │
│    (give repo paths)   (scans files, NO content     │
│                         loaded — lightweight)        │
│                                                     │
│  POST /ask ──→ Relevance Selector ──→ LLM (Claude) │
│    (question)   (picks relevant files,  (generates  │
│                  reads only those)       diagrams +  │
│                                         explanation) │
│                                                     │
│  POST /ask/:session ──→ Follow-up with context      │
│    (follow-up question)                             │
│                                                     │
│  GET / ──→ Chat UI (mermaid rendering built-in)     │
└─────────────────────────────���───────────────────────┘
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **Lazy file loading** | Index stores only file paths + metadata. Content read on-demand per query. Handles 10k+ files without memory issues. |
| **Claude CLI backend** | Works with Claude Code Pro plan — no API key needed. Zero extra cost. |
| **Repo-agnostic** | Auto-detects: TypeScript, Haskell, Python, Go, Rust, Java, PHP, Ruby. No hardcoded repo names. |
| **Conversational** | Session-based follow-ups. LLM remembers previous context. New code injected when follow-up covers new areas. |

---

## Proven Results (Tested on Our Repos)

Tested with nimble + vayu + magento + atoms (9,274 files total):

| Query | Result |
|-------|--------|
| "How does the order flow work for magento?" | Full mermaid diagram: GraphQL mutations → Backend services → DB tables → Admin panel. Referenced 20 specific files. |
| "What happens if payment fails?" (follow-up) | Error handling flow across Nimble frontend + Vayu backend + Shopify gateway. Mapped status codes to UI error messages. |

Both queries returned mermaid diagrams that render correctly in the built-in UI.

---

## How to Use

### 1. Start the server
```bash
cd flow-tracer
pnpm install
node src/server.js
# → http://localhost:3847
```

### 2. Register repos (API or UI)
```bash
curl -X POST http://localhost:3847/repos \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-platform",
    "paths": ["/path/to/frontend", "/path/to/backend", "/path/to/shared-lib"]
  }'
```

### 3. Ask questions
```bash
curl -X POST http://localhost:3847/ask \
  -H "Content-Type: application/json" \
  -d '{"repos": "my-platform", "question": "How does checkout work end to end?"}'

# Follow up:
curl -X POST http://localhost:3847/ask/<sessionId> \
  -H "Content-Type: application/json" \
  -d '{"question": "What if the user's address is invalid?"}'
```

### 4. Or just use the web UI
Open http://localhost:3847 → enter repo paths → ask questions → see mermaid diagrams rendered inline.

---

## Deployment

Works anywhere Node.js runs:
- **Local**: `node src/server.js` (requires `claude` CLI installed)
- **Team server**: Deploy behind VPN, share URL with team
- **Cloud**: For production, swap Claude CLI backend with Anthropic API (just set `ANTHROPIC_API_KEY`)

---

## File Structure

```
flow-tracer/
├── src/
│   ├��─ server.js     # Express API server + static file serving
│   ├── indexer.js     # Repo scanner + relevance-based file selector
│   ├── llm.js        # Claude CLI integration + conversation management
│   └── public/
│       └── index.html # Chat UI with mermaid rendering
├── package.json
└── PROPOSAL.md
```

Total: ~600 lines of code. 4 files. No database. No external dependencies beyond Express + glob.

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| New dev onboarding time | 2-3 weeks | 3-5 days |
| "How does X work?" questions to seniors | 5-10/week | 1-2/week |
| Time to understand a cross-repo flow | 1-2 hours | 5 minutes |

---

## Future Enhancements

1. **Git URL support** — clone repos from git URLs instead of requiring local paths
2. **Vector embeddings** — replace keyword-based file selection with semantic search for better relevance
3. **Auto-reindex** — watch repos for changes, re-index on push
4. **Export** — save diagrams + explanations as markdown docs
5. **PR impact mode** — "what flows does this PR affect?" with diff-aware analysis
