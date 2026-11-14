import { parseArgs } from 'node:util';
export const USAGE = `Agent Idea: sanitised logs for ideaSquared products.

  idea logs <project> [--since <hours>] [--level debug|info|warn|error] [--search <text>] [--limit <n>] [--json]
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
            json: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [command, project] = positionals;
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
    throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
}
