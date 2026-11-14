import { createLogger } from '@ideasquared/log';
import { z } from 'zod';
import { cachedWriteAccess } from './access.ts';
import { PROJECTS, type Project } from './projects.ts';
import { routeRules } from './route-words.ts';
import { sanitiseEvent, scrubText, type SanitisedEvent } from './sanitise.ts';
import { jobLogTail, listRuns, runJobs } from './sources/github-actions.ts';
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

const log = createLogger({ service: 'agent-idea', fields: ['actor', 'project', 'route', 'outcome'] });

// Who asked for what, and the outcome. Never the results. The staff member's GitHub login is the audit `actor`.
function audit(entry: { login?: string; project: string; route: string; outcome: string }): void {
  log.info('access checked', { actor: entry.login ?? null, project: entry.project, route: entry.route, outcome: entry.outcome });
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

const RunsParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  failed: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

const RunParamsSchema = z.object({
  tail: z.coerce.number().int().min(1).max(300).default(80),
});

const MAX_LINE = 500;

function badQuery(error: z.ZodError): Response {
  return json({ error: 'Bad query', details: error.issues.map((issue) => issue.message) }, 400);
}

// Workflow, job and step names come from workflow files and can hold expression results, so they are scrubbed too.
async function runs(url: URL, name: string, project: Project, token: string, key: string): Promise<Response> {
  const params = RunsParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) return badQuery(params.error);
  const rules = routeRules(name);
  const list = await listRuns(project.repo, token, params.data, fetch);
  const scrubbed = await Promise.all(list.map(async (item) => ({ ...item, workflow: await scrubText(item.workflow, key, rules) })));
  return json({ runs: scrubbed });
}

// Failed jobs' logs are fetched a few at a time, and only for the first few failed jobs, to bound memory and time.
const LOG_BATCH = 3;
const MAX_LOGGED_JOBS = 10;

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const done = await Promise.all(items.slice(0, size).map(work));
  return [...done, ...(await inBatches(items.slice(size), size, work))];
}

// One run's jobs, with the sanitised tail of each failed job's log.
async function run(url: URL, name: string, project: Project, token: string, runId: number, key: string): Promise<Response> {
  const params = RunParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) return badQuery(params.error);
  const rules = routeRules(name);
  const scrub = async (text: string): Promise<string> => (await scrubText(text, key, rules)).slice(0, MAX_LINE);
  const jobs = await runJobs(project.repo, token, runId, fetch);
  const named = await Promise.all(
    jobs.map(async (job) => ({ ...job, name: await scrub(job.name), failedSteps: await Promise.all(job.failedSteps.map(scrub)) })),
  );
  const failedIds = new Set(named.filter((job) => job.conclusion === 'failure').slice(0, MAX_LOGGED_JOBS).map((job) => job.id));
  const logs = new Map(
    await inBatches([...failedIds], LOG_BATCH, async (id) => {
      const lines = await jobLogTail(project.repo, token, id, params.data.tail, fetch);
      return [id, await Promise.all(lines.map(scrub))] as const;
    }),
  );
  return json({
    jobs: named.map((job) => {
      const log = logs.get(job.id);
      if (log) return { ...job, log };
      return job.conclusion === 'failure' ? { ...job, logOmitted: true } : job;
    }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });

    // Without the pseudonym key nothing can be sanitised, so nothing is served.
    const key = env.PSEUDONYM_KEY;
    if (!key) return json({ error: 'Agent Idea is not configured' }, 503);

    const match = /^\/v1\/(access|logs|runs)\/([\w-]+)(?:\/(\d+))?$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return json({ error: 'Not found' }, 404);
    const [, route = '', name = '', runId] = match;
    if (runId !== undefined && route !== 'runs') return json({ error: 'Not found' }, 404);

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
    if (route === 'runs' && runId !== undefined) return run(url, name, project, token, Number(runId), key);
    if (route === 'runs') return runs(url, name, project, token, key);
    return json({ project: name, repo: project.repo, login: access.login, access: 'write' });
  },
} satisfies ExportedHandler<Env>;
