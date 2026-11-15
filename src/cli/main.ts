import { parseArgs } from 'node:util';
import { call, ENVIRONMENTS, PROJECT_NAMES, type ApiDeps } from './client.ts';

export const USAGE = `Agent Idea: sanitised logs for ideaSquared products.

  idea logs <project> [--since <hours>] [--level debug|info|warn|error] [--env staging|production] [--search <text>] [--limit <n>] [--json]
  idea runs <project> [--failed] [--limit <n>] [--json]       recent GitHub Actions runs
  idea run <project> <run id> [--tail <lines>] [--json]      a run's jobs, with each failed job's log
  idea errors <project> [--env staging|production] [--limit <n>] [--frames] [--json]    top unresolved errors (ads only), --frames adds file:line
  idea access <project>
  idea mcp                                                    MCP server over stdio, for Claude Code

Projects: ${PROJECT_NAMES.join(', ')}.
You need write access to the project's repo. Sign-in: GH_TOKEN, GITHUB_TOKEN or your gh login.
API: AGENT_IDEA_URL (default https://agent-idea.idea-squared.workers.dev).`;

export type Event = {
  timestamp: string;
  level: string;
  service?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  errorType?: string;
  message: string;
  stack?: string[];
};

type Run = {
  id: number;
  number: number;
  workflow: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch?: string;
  sha: string;
  createdAt: string;
};

type Issue = {
  shortId: string;
  title: string;
  culprit: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  level: string;
  frames?: string[];
};

type Job = { name: string; status: string; conclusion: string | null; failedSteps: string[]; log?: string[] };

export type Deps = ApiDeps & {
  out: (line: string) => void;
};

// One line per event: time, level, service, the request, then the message.
export function formatEvent(event: Event): string {
  const time = event.timestamp.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const request = [event.route, event.status, event.durationMs !== undefined ? `${event.durationMs}ms` : undefined]
    .filter((part) => part !== undefined)
    .join(' ');
  const head = [time, event.level.toUpperCase().padEnd(5), event.service, request, event.errorType]
    .filter(Boolean)
    .join('  ');
  const stack = (event.stack ?? []).map((frame) => `\n    at ${frame}`).join('');
  return `${head}  ${event.message}${stack}`;
}

const MARK: Record<string, string> = { success: '✓', failure: '✗', cancelled: '⊘', skipped: '-' };

// One line per run: result, workflow, event, branch, commit, time, then the id to pass to `idea run`.
export function formatRun(run: Run): string {
  const result = run.status === 'completed' ? (run.conclusion ?? 'done') : run.status;
  const time = run.createdAt.replace('T', ' ').replace(/:\d{2}Z$/, 'Z');
  return [MARK[result] ?? '…', `${run.workflow} #${run.number}`, run.event, run.branch, run.sha, time, `id ${run.id}`]
    .filter(Boolean)
    .join('  ');
}

export function formatJob(job: Job): string {
  const result = job.status === 'completed' ? (job.conclusion ?? 'done') : job.status;
  const head = `${MARK[result] ?? '…'} ${job.name}${job.failedSteps.length > 0 ? `  (failed: ${job.failedSteps.join(', ')})` : ''}`;
  return job.log ? `${head}\n${job.log.map((line) => `    ${line}`).join('\n')}` : head;
}

function shortTime(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');
}

// One line per issue: short id, level, count, last and first seen, title, then the culprit; frames underneath.
export function formatIssue(issue: Issue): string {
  const culprit = issue.culprit ? `  (${issue.culprit})` : '';
  const head = [issue.shortId, issue.level.toUpperCase(), `${issue.count}x`, `last ${shortTime(issue.lastSeen)}`, `first ${shortTime(issue.firstSeen)}`, `${issue.title}${culprit}`].join('  ');
  return `${head}${(issue.frames ?? []).map((frame) => `\n    at ${frame}`).join('')}`;
}

export async function run(argv: readonly string[], deps: Deps): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      level: { type: 'string' },
      env: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string' },
      failed: { type: 'boolean' },
      tail: { type: 'string' },
      frames: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, project, runId] = positionals;
  if (values.help || !command) return deps.out(USAGE);
  if (!project) throw new Error(`Which project?\n\n${USAGE}`);

  if (command === 'access') {
    const body = (await call(deps, `/v1/access/${encodeURIComponent(project)}`)) as { login: string; repo: string };
    return deps.out(`${body.login} has write access to ${body.repo}.`);
  }

  if (values.env !== undefined && !ENVIRONMENTS.some((environment) => environment === values.env)) {
    throw new Error(`--env must be staging or production, not '${values.env}'.\n\n${USAGE}`);
  }

  if (command === 'logs') {
    const query = new URLSearchParams(
      Object.entries({ since: values.since, level: values.level, env: values.env, search: values.search, limit: values.limit }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const body = (await call(deps, `/v1/logs/${encodeURIComponent(project)}?${query}`)) as { events: Event[] };
    if (values.json) return deps.out(JSON.stringify(body.events, null, 2));
    if (body.events.length === 0) return deps.out('No log events in that window.');
    // Oldest first, like a log file.
    return [...body.events].reverse().forEach((event) => deps.out(formatEvent(event)));
  }

  if (command === 'runs') {
    const query = new URLSearchParams({ ...(values.limit ? { limit: values.limit } : {}), ...(values.failed ? { failed: 'true' } : {}) });
    const body = (await call(deps, `/v1/runs/${encodeURIComponent(project)}?${query}`)) as { runs: Run[] };
    if (values.json) return deps.out(JSON.stringify(body.runs, null, 2));
    if (body.runs.length === 0) return deps.out('No runs.');
    return body.runs.forEach((run) => deps.out(formatRun(run)));
  }

  if (command === 'run') {
    if (!runId || !/^\d+$/.test(runId)) throw new Error(`Which run? Pass its id, as \`idea runs\` shows.\n\n${USAGE}`);
    const query = new URLSearchParams(values.tail ? { tail: values.tail } : {});
    const body = (await call(deps, `/v1/runs/${encodeURIComponent(project)}/${runId}?${query}`)) as { jobs: Job[] };
    if (values.json) return deps.out(JSON.stringify(body.jobs, null, 2));
    return body.jobs.forEach((job) => deps.out(formatJob(job)));
  }

  if (command === 'errors') {
    const query = new URLSearchParams({ ...(values.env ? { env: values.env } : {}), ...(values.limit ? { limit: values.limit } : {}), ...(values.frames ? { frames: 'true' } : {}) });
    const body = (await call(deps, `/v1/errors/${encodeURIComponent(project)}?${query}`)) as { issues: Issue[] };
    if (values.json) return deps.out(JSON.stringify(body.issues, null, 2));
    if (body.issues.length === 0) return deps.out('No unresolved issues.');
    return body.issues.forEach((issue) => deps.out(formatIssue(issue)));
  }

  throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
}
