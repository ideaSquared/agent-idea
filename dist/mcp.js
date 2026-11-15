import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, call, ENVIRONMENTS, PROJECT_NAMES } from "./client.js";
function text(value, isError = false) {
    return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
function failure(error, api) {
    if (error instanceof ApiError)
        return text(error.message, true);
    // Only the error's type, never its message: a local failure (such as a bad header) can quote the Authorization token.
    const kind = error instanceof Error ? error.name : 'unknown error';
    return text(`Could not reach Agent Idea at ${api.apiUrl} (${kind}).`, true);
}
function query(params) {
    const search = new URLSearchParams(Object.fromEntries(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])))).toString();
    return search ? `?${search}` : '';
}
export function tool(definition) {
    const schema = z.object(definition.input);
    return {
        name: definition.name,
        description: definition.description,
        input: definition.input,
        handle: async (args, api) => {
            const parsed = schema.safeParse(args);
            if (!parsed.success)
                return text(`Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, true);
            try {
                return text(JSON.stringify(await definition.run(parsed.data, api), null, 2));
            }
            catch (error) {
                return failure(error, api);
            }
        },
    };
}
const project = z.enum(PROJECT_NAMES).describe('The ideaSquared project. Call list_projects to see them all.');
const env = z
    .enum(ENVIRONMENTS)
    .optional()
    .describe('Only this environment. Omit for all. A project that cannot tell environments apart (ads today) returns an error instead.');
const path = (route, name) => `/v1/${route}/${encodeURIComponent(name)}`;
const ACCESS_NOTE = 'You only get data for a project if the signed-in GitHub user has write access to its repo; otherwise the tool returns an error saying so. ' +
    'Everything returned has already been sanitised by the Agent Idea API: personal data and secrets are removed and ids are replaced with stable pseudonyms such as id_1a2b3c4d.';
// Add a tool here to expose a new API route.
export const TOOLS = [
    tool({
        name: 'list_projects',
        description: 'Lists the ideaSquared projects whose logs and CI runs Agent Idea can serve. Returns { projects: string[] }. Does not check access; use check_access for that.',
        input: {},
        run: async () => ({ projects: PROJECT_NAMES }),
    }),
    tool({
        name: 'check_access',
        description: `Checks whether the signed-in GitHub user has write access to a project's repo. Returns { project, repo, login, access: "write" } on success. ${ACCESS_NOTE}`,
        input: { project },
        run: (args, api) => call(api, path('access', args.project)),
    }),
    tool({
        name: 'get_logs',
        description: `Fetches a project's recent server log events (Cloudflare Workers Logs). Returns { events, scanned }: events are newest first, each with timestamp, level, service, route, status, durationMs, errorType, message and stack (file:line only) where present. ` +
            `search matches the sanitised events only. ${ACCESS_NOTE}`,
        input: {
            project,
            since_hours: z.number().positive().max(168).optional().describe('How far back to look, in hours. Default 1, max 168 (7 days).'),
            level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Only events at this level.'),
            env,
            search: z.string().min(1).max(100).optional().describe('Case-insensitive text to match in message, route, service or error type.'),
            limit: z.number().int().min(1).max(200).optional().describe('Most events to return. Default 50, max 200.'),
        },
        run: (args, api) => call(api, `${path('logs', args.project)}${query({ since: args.since_hours, level: args.level, env: args.env, search: args.search, limit: args.limit })}`),
    }),
    tool({
        name: 'list_runs',
        description: `Lists a project's recent GitHub Actions workflow runs, newest first. Returns { runs }: each with id, number, workflow, event, status, conclusion, branch (default branch only), short sha and createdAt. ` +
            `Pass a run's id to get_run for its jobs and failed-job logs. ${ACCESS_NOTE}`,
        input: {
            project,
            failed: z.boolean().optional().describe('Only failed runs.'),
            limit: z.number().int().min(1).max(50).optional().describe('Most runs to return. Default 10, max 50.'),
        },
        run: (args, api) => call(api, `${path('runs', args.project)}${query({ failed: args.failed ? true : undefined, limit: args.limit })}`),
    }),
    tool({
        name: 'get_run',
        description: `Fetches one GitHub Actions run's jobs. Returns { jobs }: each with name, status, conclusion and failedSteps, plus log (the last lines of the job's log) for failed jobs. ${ACCESS_NOTE}`,
        input: {
            project,
            run_id: z.number().int().positive().describe('The run id, as list_runs returns it.'),
            tail: z.number().int().min(1).max(300).optional().describe("Lines of each failed job's log to return. Default 80, max 300."),
        },
        run: (args, api) => call(api, `${path('runs', args.project)}/${args.run_id}${query({ tail: args.tail })}`),
    }),
    tool({
        name: 'get_errors',
        description: `Lists the busiest unresolved errors from the project's error tracker (GlitchTip; only ads has one). Returns { issues }: each with shortId, level, count, firstSeen, lastSeen, a scrubbed title and culprit, and with frames=true the latest event's stack frames as file:line. Projects without an error tracker return an error. ${ACCESS_NOTE}`,
        input: {
            project,
            env,
            limit: z.number().int().min(1).max(25).optional().describe('Issues to return. Default 10, max 25.'),
            frames: z.boolean().optional().describe("Add each issue's latest stack frames (file:line)."),
        },
        run: (args, api) => call(api, `${path('errors', args.project)}${query({ env: args.env, limit: args.limit, frames: args.frames })}`),
    }),
];
export const VERSION = '0.1.0';
export function createServer(api, tools = TOOLS) {
    const server = new McpServer({ name: 'agent-idea', version: VERSION });
    for (const item of tools) {
        server.registerTool(item.name, { description: item.description, inputSchema: item.input, annotations: { readOnlyHint: true, openWorldHint: true } }, (args) => item.handle(args, api));
    }
    return server;
}
// stdout is the MCP protocol channel: nothing else may write to it.
export async function serveStdio(api) {
    await createServer(api).connect(new StdioServerTransport());
}
