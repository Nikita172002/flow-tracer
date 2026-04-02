#!/usr/bin/env node

/**
 * FlowTracer CLI entry point.
 *
 * Usage:
 *   flow-tracer              → starts MCP server (default, for Claude Code/Desktop)
 *   flow-tracer mcp          → starts MCP server (explicit)
 *   flow-tracer serve        → starts web UI server on port 3847
 *   flow-tracer serve 8080   → starts web UI on custom port
 *
 * Supports .env file in the project root for configuration.
 */

import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

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
