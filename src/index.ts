import { cachedWriteAccess } from './access.ts';
import { PROJECTS } from './projects.ts';

export type Env = {
  ACCESS_CACHE: KVNamespace;
  PSEUDONYM_KEY?: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function bearer(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1];
}

// Who asked for what, and the outcome. Never the results.
function audit(entry: { login?: string; project: string; route: string; outcome: string }): void {
  console.log(JSON.stringify({ audit: true, ...entry }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });

    // Without the pseudonym key nothing can be sanitised, so nothing is served.
    if (!env.PSEUDONYM_KEY) return json({ error: 'Agent Idea is not configured' }, 503);

    const match = /^\/v1\/access\/([\w-]+)$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return json({ error: 'Not found' }, 404);

    const project = match[1] ?? '';
    const repo = PROJECTS[project];
    if (!repo) return json({ error: `Unknown project '${project}'` }, 404);

    const token = bearer(request);
    if (!token) return json({ error: 'Sign in with gh auth login' }, 401);

    const access = await cachedWriteAccess(token, repo, env.ACCESS_CACHE, fetch);
    const login = access.outcome === 'unauthenticated' ? undefined : access.login;
    audit({ login, project, route: 'access', outcome: access.outcome });
    if (access.outcome === 'unauthenticated') return json({ error: 'GitHub did not accept that token' }, 401);
    if (access.outcome === 'denied') return json({ error: `You need write access to ${repo}` }, 403);
    return json({ project, repo, login: access.login, access: 'write' });
  },
} satisfies ExportedHandler<Env>;
