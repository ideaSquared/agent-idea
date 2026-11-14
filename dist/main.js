import { parseArgs } from 'node:util';
import { call, PROJECT_NAMES } from "./client.js";
export const USAGE = `Agent Idea: sanitised logs for ideaSquared products.

  idea logs <project> [--since <hours>] [--level debug|info|warn|error] [--search <text>] [--limit <n>] [--json]
  idea runs <project> [--failed] [--limit <n>] [--json]       recent GitHub Actions runs
  idea run <project> <run id> [--tail <lines>] [--json]      a run's jobs, with each failed job's log
  idea access <project>
  idea mcp                                                    MCP server over stdio, for Claude Code

Projects: ${PROJECT_NAMES.join(', ')}.
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
    throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
}
