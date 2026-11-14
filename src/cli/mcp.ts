import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, call, PROJECT_NAMES, type ApiDeps } from './client.ts';

// Each tool is a thin wrapper over one Agent Idea API route. The API checks access and sanitises; this only asks.
export type Tool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  handle: (args: unknown, api: ApiDeps) => Promise<CallToolResult>;
};

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown, api: ApiDeps): CallToolResult {
  if (error instanceof ApiError) return text(error.message, true);
  // Only the error's type, never its message: a local failure (such as a bad header) can quote the Authorization token.
  const kind = error instanceof Error ? error.name : 'unknown error';
  return text(`Could not reach Agent Idea at ${api.apiUrl} (${kind}).`, true);
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams(
    Object.fromEntries(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]]))),
  ).toString();
  return search ? `?${search}` : '';
}

export function tool<S extends z.ZodRawShape>(definition: {
  name: string;
  description: string;
  input: S;
  run: (args: z.output<z.ZodObject<S>>, api: ApiDeps) => Promise<unknown>;
}): Tool {
  const schema = z.object(definition.input);
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    handle: async (args, api) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return text(`Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, true);
      try {
        return text(JSON.stringify(await definition.run(parsed.data, api), null, 2));
      } catch (error) {
        return failure(error, api);
      }
    },
  };
}

const project = z.enum(PROJECT_NAMES).describe('The ideaSquared project. Call list_projects to see them all.');
const path = (route: string, name: string): string => `/v1/${route}/${encodeURIComponent(name)}`;

const ACCESS_NOTE =
  'You only get data for a project if the signed-in GitHub user has write access to its repo; otherwise the tool returns an error saying so. ' +
  'Everything returned has already been sanitised by the Agent Idea API: personal data and secrets are removed and ids are replaced with stable pseudonyms such as id_1a2b3c4d.';

// Add a tool here to expose a new API route.
export const TOOLS: readonly Tool[] = [
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
    description:
      `Fetches a project's recent server log events (Cloudflare Workers Logs). Returns { events, scanned }: events are newest first, each with timestamp, level, service, route, status, durationMs, errorType, message and stack (file:line only) where present. ` +
      `search matches the sanitised events only. ${ACCESS_NOTE}`,
    input: {
      project,
      since_hours: z.number().positive().max(168).optional().describe('How far back to look, in hours. Default 1, max 168 (7 days).'),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Only events at this level.'),
      search: z.string().min(1).max(100).optional().describe('Case-insensitive text to match in message, route, service or error type.'),
      limit: z.number().int().min(1).max(200).optional().describe('Most events to return. Default 50, max 200.'),
    },
    run: (args, api) =>
      call(api, `${path('logs', args.project)}${query({ since: args.since_hours, level: args.level, search: args.search, limit: args.limit })}`),
  }),
  tool({
    name: 'list_runs',
    description:
      `Lists a project's recent GitHub Actions workflow runs, newest first. Returns { runs }: each with id, number, workflow, event, status, conclusion, branch (default branch only), short sha and createdAt. ` +
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
    description:
      `Fetches one GitHub Actions run's jobs. Returns { jobs }: each with name, status, conclusion and failedSteps, plus log (the last lines of the job's log) for failed jobs. ${ACCESS_NOTE}`,
    input: {
      project,
      run_id: z.number().int().positive().describe('The run id, as list_runs returns it.'),
      tail: z.number().int().min(1).max(300).optional().describe("Lines of each failed job's log to return. Default 80, max 300."),
    },
    run: (args, api) => call(api, `${path('runs', args.project)}/${args.run_id}${query({ tail: args.tail })}`),
  }),
];

export const VERSION = '0.1.0';

export function createServer(api: ApiDeps, tools: readonly Tool[] = TOOLS): McpServer {
  const server = new McpServer({ name: 'agent-idea', version: VERSION });
  for (const item of tools) {
    server.registerTool(
      item.name,
      { description: item.description, inputSchema: item.input, annotations: { readOnlyHint: true, openWorldHint: true } },
      (args) => item.handle(args, api),
    );
  }
  return server;
}

// stdout is the MCP protocol channel: nothing else may write to it.
export async function serveStdio(api: ApiDeps): Promise<void> {
  await createServer(api).connect(new StdioServerTransport());
}
