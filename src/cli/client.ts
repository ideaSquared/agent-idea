import { execFileSync } from 'node:child_process';

// The projects the API knows (src/projects.ts). The CLI ships on its own, so it keeps a copy; a test checks they match.
export const PROJECT_NAMES = ['ads', 'creatrgrid', 'gaminginit', 'gaminginit-bot', 'ideasquared-bot', 'pairflix'] as const;

export type ApiDeps = {
  apiUrl: string;
  token: string | undefined;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

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
  };
}

// GET an API path with the user's token. Throws an ApiError carrying the API's own reason when it refuses.
export async function call(deps: ApiDeps, path: string): Promise<unknown> {
  if (!deps.token) throw new ApiError('Not signed in. Run `gh auth login` or set GH_TOKEN.');
  const response = await deps.fetch(`${deps.apiUrl}${path}`, { headers: { authorization: `Bearer ${deps.token}` } });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
    throw new ApiError(error || `Agent Idea answered ${response.status}`);
  }
  return body;
}
