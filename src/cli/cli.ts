#!/usr/bin/env node
import { apiFromEnv } from './client.ts';
import { run } from './main.ts';
import { serveStdio } from './mcp.ts';

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const argv = process.argv.slice(2);
const api = apiFromEnv();

if (argv[0] === 'mcp') {
  // stdout carries the MCP protocol, so diagnostics go to stderr only.
  if (!api.token) console.error('idea mcp: not signed in, so every tool will fail. Run `gh auth login` or set GH_TOKEN, then restart.');
  serveStdio(api).catch(fail);
} else {
  run(argv, { ...api, out: (line) => console.log(line) }).catch(fail);
}
