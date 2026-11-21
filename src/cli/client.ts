import { execFileSync } from 'node:child_process';

// The projects the API knows (src/projects.ts). The CLI ships on its own, so it keeps a copy; a test checks they match.
export const PROJECT_NAMES = ['ads', 'creatrgrid', 'gaminginit', 'gaminginit-bot', 'ideasquared-bot', 'pairflix'] as const;

export const ENVIRONMENTS = ['staging', 'production'] as const;

export type ApiDeps = {
  apiUrl: string;
  token: string | undefined;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  // Where warnings go (stderr in the CLI and the MCP server) and the clock they are judged by.
  warn?: (line: string) => void;
  now?: () => Date;
};

const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// A warning when the token expires within WARN_DAYS, from the API's x-token-expires-at header. undefined otherwise.
export function expiryWarning(expiresAt: string | null, now: Date): string | undefined {
  if (!expiresAt) return undefined;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return undefined;
  const remaining = expires.getTime() - now.getTime();
  if (remaining > WARN_DAYS * DAY_MS) return undefined;
  const days = Math.floor(remaining / DAY_MS);
  const when = remaining <= 0 ? 'today' : days === 0 ? 'in less than a day' : `in ${days} day${days === 1 ? '' : 's'}`;
  return `Warning: your GitHub token expires on ${expires.toISOString().slice(0, 10)} (${when}). Create a new one and replace it where you set it (GH_TOKEN, gh auth login or the cloud environment secret).`;
}

export class ApiError extends Error {}

function ghToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// The API to talk to and the user's own GitHub token: GH_TOKEN, GITHUB_TOKEN or their gh login.
export function apiFromEnv(): ApiDeps {
  return {
    apiUrl: (process.env.AGENT_IDEA_URL ?? 'https://agent-idea.idea-squared.workers.dev').replace(/\/$/, ''),
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ghToken(),
    fetch,
    warn: (line) => console.error(line),
  };
}

// GET an API path with the user's token. Throws an ApiError carrying the API's own reason when it refuses.
export async function call(deps: ApiDeps, path: string): Promise<unknown> {
  if (!deps.token) throw new ApiError('Not signed in. Run `gh auth login` or set GH_TOKEN.');
  const response = await deps.fetch(`${deps.apiUrl}${path}`, { headers: { authorization: `Bearer ${deps.token}` } });
  const warning = expiryWarning(response.headers.get('x-token-expires-at'), (deps.now ?? (() => new Date()))());
  if (warning) deps.warn?.(warning);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
    throw new ApiError(error || `Agent Idea answered ${response.status}`);
  }
  return body;
}
