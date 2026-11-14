#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { run } from './main.ts';

function ghToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

run(process.argv.slice(2), {
  apiUrl: (process.env.AGENT_IDEA_URL ?? 'https://agent-idea.idea-squared.workers.dev').replace(/\/$/, ''),
  token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghToken(),
  fetch,
  out: (line) => console.log(line),
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
