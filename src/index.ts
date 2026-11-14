import { z } from 'zod';
import { cachedWriteAccess } from './access.ts';
import { PROJECTS, type Project } from './projects.ts';
import { routeRules } from './route-words.ts';
import { sanitiseEvent, type SanitisedEvent } from './sanitise.ts';
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
// How many of the newest events a search looks through. Cloudflare returns a few hundred at most per query.
const SEARCH_SCAN = 1000;

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

// Search runs on sanitised events only, so it can never match data the sanitiser removed.
function matches(event: SanitisedEvent, search: string): boolean {
  const needle = search.toLowerCase();
  return [event.message, event.route, event.service, event.errorType].some((field) => field?.toLowerCase().includes(needle));
}

async function logs(url: URL, name: string, project: Project, env: Env, key: string): Promise<Response> {
  const params = LogsParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) return json({ error: 'Bad query', details: params.error.issues.map((issue) => issue.message) }, 400);
  const { since, level, search, limit } = params.data;
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return json({ error: 'Workers Logs is not configured' }, 503);

  const to = Date.now();
  const raw = await fetchWorkerLogs(
    { workers: project.workers, from: to - since * HOUR, to, level, limit: search ? SEARCH_SCAN : limit },
    { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN },
    fetch,
  );
  const rules = routeRules(name);
  const settled = await Promise.allSettled(raw.map((event) => sanitiseEvent(event, key, rules)));
  const sanitised = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const events = (search ? sanitised.filter((event) => matches(event, search)) : sanitised).slice(0, limit);
  return json({ events, scanned: sanitised.length });
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

    if (route === 'logs') return logs(url, name, project, env, key);
    return json({ project: name, repo: project.repo, login: access.login, access: 'write' });
  },
} satisfies ExportedHandler<Env>;
