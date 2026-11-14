import { z } from 'zod';
import { cachedWriteAccess } from './access.ts';
import { PROJECTS, type Project } from './projects.ts';
import { sanitiseEvent, scrubText } from './sanitise.ts';
import { fetchWorkerLogs } from './sources/workers-logs.ts';

export type Env = {
  ACCESS_CACHE: KVNamespace;
  PSEUDONYM_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
};

const HOUR = 3_600_000;
// Workers Logs keeps 7 days.
const MAX_SINCE_HOURS = 168;

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

const LogsParamsSchema = z.object({
  since: z.coerce.number().positive().max(MAX_SINCE_HOURS).default(1),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  search: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function logs(url: URL, project: Project, env: Env, key: string): Promise<Response> {
  const params = LogsParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) return json({ error: 'Bad query', details: params.error.issues.map((issue) => issue.message) }, 400);
  const { since, level, search, limit } = params.data;
  // A search term with personal data in it would tell the caller whether that person is in the logs.
  if (search !== undefined && (await scrubText(search, key)) !== search) {
    return json({ error: 'Search terms cannot contain personal data or secrets' }, 400);
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return json({ error: 'Workers Logs is not configured' }, 503);

  const to = Date.now();
  const raw = await fetchWorkerLogs(
    { workers: project.workers, from: to - since * HOUR, to, level, search, limit },
    { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN },
    fetch,
  );
  const settled = await Promise.allSettled(raw.map((event) => sanitiseEvent(event, key)));
  const events = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  return json({ events });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });

    // Without the pseudonym key nothing can be sanitised, so nothing is served.
    const key = env.PSEUDONYM_KEY;
    if (!key) return json({ error: 'Agent Idea is not configured' }, 503);

    const match = /^\/v1\/(access|logs)\/([\w-]+)$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return json({ error: 'Not found' }, 404);
    const [, route = '', name = ''] = match;

    const project = PROJECTS[name];
    if (!project) return json({ error: `Unknown project '${name}'` }, 404);

    const token = bearer(request);
    if (!token) return json({ error: 'Sign in with gh auth login' }, 401);

    const access = await cachedWriteAccess(token, project.repo, env.ACCESS_CACHE, fetch);
    const login = access.outcome === 'unauthenticated' ? undefined : access.login;
    audit({ login, project: name, route, outcome: access.outcome });
    if (access.outcome === 'unauthenticated') return json({ error: 'GitHub did not accept that token' }, 401);
    if (access.outcome === 'denied') return json({ error: `You need write access to ${project.repo}` }, 403);

    if (route === 'logs') return logs(url, project, env, key);
    return json({ project: name, repo: project.repo, login: access.login, access: 'write' });
  },
} satisfies ExportedHandler<Env>;
