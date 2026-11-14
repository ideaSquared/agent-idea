import { parseArgs } from 'node:util';
export const USAGE = `Agent Idea: sanitised logs for ideaSquared products.

  idea logs <project> [--since <hours>] [--level debug|info|warn|error] [--search <text>] [--limit <n>] [--json]
  idea runs <project> [--failed] [--limit <n>] [--json]       recent GitHub Actions runs
  idea run <project> <run id> [--tail <lines>] [--json]      a run's jobs, with each failed job's log
  idea errors <project> [--limit <n>] [--frames] [--json]    top unresolved errors (ads only), --frames adds file:line
  idea access <project>

Projects: ads, creatrgrid, gaminginit, gaminginit-bot, ideasquared-bot, pairflix.
You need write access to the project's repo. Sign-in: GH_TOKEN, GITHUB_TOKEN or your gh login.
API: AGENT_IDEA_URL (default https://agent-idea.idea-squared.workers.dev).`;
// One line per event: time, level, service, the request, then the message.
export function formatEvent(event) {
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
const MARK = { success: '✓', failure: '✗', cancelled: '⊘', skipped: '-' };
// One line per run: result, workflow, event, branch, commit, time, then the id to pass to `idea run`.
export function formatRun(run) {
    const result = run.status === 'completed' ? (run.conclusion ?? 'done') : run.status;
    const time = run.createdAt.replace('T', ' ').replace(/:\d{2}Z$/, 'Z');
    return [MARK[result] ?? '…', `${run.workflow} #${run.number}`, run.event, run.branch, run.sha, time, `id ${run.id}`]
        .filter(Boolean)
        .join('  ');
}
export function formatJob(job) {
    const result = job.status === 'completed' ? (job.conclusion ?? 'done') : job.status;
    const head = `${MARK[result] ?? '…'} ${job.name}${job.failedSteps.length > 0 ? `  (failed: ${job.failedSteps.join(', ')})` : ''}`;
    return job.log ? `${head}\n${job.log.map((line) => `    ${line}`).join('\n')}` : head;
}
function shortTime(timestamp) {
    return timestamp.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');
}
// One line per issue: short id, level, count, last and first seen, title, then the culprit; frames underneath.
export function formatIssue(issue) {
    const culprit = issue.culprit ? `  (${issue.culprit})` : '';
    const head = [issue.shortId, issue.level.toUpperCase(), `${issue.count}x`, `last ${shortTime(issue.lastSeen)}`, `first ${shortTime(issue.firstSeen)}`, `${issue.title}${culprit}`].join('  ');
    return `${head}${(issue.frames ?? []).map((frame) => `\n    at ${frame}`).join('')}`;
}
async function call(deps, path) {
    if (!deps.token)
        throw new Error('Not signed in. Run `gh auth login` or set GH_TOKEN.');
    const response = await deps.fetch(`${deps.apiUrl}${path}`, { headers: { authorization: `Bearer ${deps.token}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
        throw new Error(error || `Agent Idea answered ${response.status}`);
    }
    return body;
}
export async function run(argv, deps) {
    const { positionals, values } = parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
            since: { type: 'string' },
            level: { type: 'string' },
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
    if (values.help || !command)
        return deps.out(USAGE);
    if (!project)
        throw new Error(`Which project?\n\n${USAGE}`);
    if (command === 'access') {
        const body = (await call(deps, `/v1/access/${encodeURIComponent(project)}`));
        return deps.out(`${body.login} has write access to ${body.repo}.`);
    }
    if (command === 'logs') {
        const query = new URLSearchParams(Object.entries({ since: values.since, level: values.level, search: values.search, limit: values.limit }).filter((entry) => entry[1] !== undefined));
        const body = (await call(deps, `/v1/logs/${encodeURIComponent(project)}?${query}`));
        if (values.json)
            return deps.out(JSON.stringify(body.events, null, 2));
        if (body.events.length === 0)
            return deps.out('No log events in that window.');
        // Oldest first, like a log file.
        return [...body.events].reverse().forEach((event) => deps.out(formatEvent(event)));
    }
    if (command === 'runs') {
        const query = new URLSearchParams({ ...(values.limit ? { limit: values.limit } : {}), ...(values.failed ? { failed: 'true' } : {}) });
        const body = (await call(deps, `/v1/runs/${encodeURIComponent(project)}?${query}`));
        if (values.json)
            return deps.out(JSON.stringify(body.runs, null, 2));
        if (body.runs.length === 0)
            return deps.out('No runs.');
        return body.runs.forEach((run) => deps.out(formatRun(run)));
    }
    if (command === 'run') {
        if (!runId || !/^\d+$/.test(runId))
            throw new Error(`Which run? Pass its id, as \`idea runs\` shows.\n\n${USAGE}`);
        const query = new URLSearchParams(values.tail ? { tail: values.tail } : {});
        const body = (await call(deps, `/v1/runs/${encodeURIComponent(project)}/${runId}?${query}`));
        if (values.json)
            return deps.out(JSON.stringify(body.jobs, null, 2));
        return body.jobs.forEach((job) => deps.out(formatJob(job)));
    }
    if (command === 'errors') {
        const query = new URLSearchParams({ ...(values.limit ? { limit: values.limit } : {}), ...(values.frames ? { frames: 'true' } : {}) });
        const body = (await call(deps, `/v1/errors/${encodeURIComponent(project)}?${query}`));
        if (values.json)
            return deps.out(JSON.stringify(body.issues, null, 2));
        if (body.issues.length === 0)
            return deps.out('No unresolved issues.');
        return body.issues.forEach((issue) => deps.out(formatIssue(issue)));
    }
    throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
}
