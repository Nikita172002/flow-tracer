#!/usr/bin/env node

/**
 * FlowTracer CLI entry point.
 *
 * Usage:
 *   flow-tracer              → starts MCP server (default, for Claude Code/Desktop)
 *   flow-tracer mcp          → starts MCP server (explicit)
 *   flow-tracer serve        → starts web UI server on port 3847
 *   flow-tracer serve 8080   → starts web UI on custom port
 */

const [,, command, ...args] = process.argv;

switch (command) {
  case "serve": {
    if (args[0]) process.env.PORT = args[0];
    await import("../src/server.js");
    break;
  }

  case "mcp":
  default: {
    await import("../src/mcp.js");
    break;
  }
}
