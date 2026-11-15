import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { PROJECT_NAMES, type ApiDeps } from '../src/cli/client.ts';
import { createServer, TOOLS } from '../src/cli/mcp.ts';
import { PROJECTS } from '../src/projects.ts';

type Route = { status: number; body: unknown };

function api(routes: Record<string, Route> = {}, overrides: Partial<ApiDeps> = {}) {
  const requests: { url: URL; authorization: string | null }[] = [];
  const value: ApiDeps = {
    apiUrl: 'https://agent-idea.example',
    token: 'gho_secret',
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      const route = routes[url.pathname];
      return Response.json(route?.body ?? { error: 'Not found' }, { status: route?.status ?? 404 });
    },
    ...overrides,
  };
  return { value, requests };
}

async function callTool(name: string, args: unknown, deps: ApiDeps): Promise<CallToolResult> {
  const found = TOOLS.find((item) => item.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handle(args, deps);
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('list_projects', () => {
  it('lists every project the API knows, without calling it', async () => {
    const { value, requests } = api();
    const result = await callTool('list_projects', {}, value);
    expect(JSON.parse(textOf(result))).toEqual({ projects: Object.keys(PROJECTS) });
    expect(requests).toEqual([]);
  });

  it("keeps the CLI's project list in step with the API's", () => {
    expect([...PROJECT_NAMES].sort()).toEqual(Object.keys(PROJECTS).sort());
  });
});

describe('check_access', () => {
  it('asks the API with the user token and returns its answer', async () => {
    const body = { project: 'ads', repo: 'ideaSquared/adopt-dont-shop', login: 'octocat', access: 'write' };
    const { value, requests } = api({ '/v1/access/ads': { status: 200, body } });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual(body);
    expect(requests[0]?.authorization).toBe('Bearer gho_secret');
  });

  it('returns a 403 as a tool error with the reason', async () => {
    const { value } = api({ '/v1/access/ads': { status: 403, body: { error: 'You need write access to ideaSquared/adopt-dont-shop' } } });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('You need write access to ideaSquared/adopt-dont-shop');
  });

  it('returns a 401 as a tool error with the reason', async () => {
    const { value } = api({ '/v1/access/ads': { status: 401, body: { error: 'GitHub did not accept that token' } } });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('GitHub did not accept that token');
  });

  it('asks you to sign in when there is no token, without calling the API', async () => {
    const { value, requests } = api({}, { token: undefined });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('gh auth login');
    expect(requests).toEqual([]);
  });

  it('reports a network failure as a tool error, without the token', async () => {
    const { value } = api({}, { fetch: () => Promise.reject(new TypeError('fetch failed')) });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Could not reach Agent Idea at https://agent-idea.example (TypeError).');
    expect(textOf(result)).not.toContain('gho_secret');
  });

  it('never repeats an error message, which can quote the Authorization header', async () => {
    const leak = new TypeError('Invalid header value: "Bearer gho_secret\n"');
    const { value } = api({}, { fetch: () => Promise.reject(leak) });
    const result = await callTool('check_access', { project: 'ads' }, value);
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('gho_secret');
    expect(textOf(result)).not.toContain('Bearer');
  });

  it('rejects an unknown project before calling the API', async () => {
    const { value, requests } = api();
    const result = await callTool('check_access', { project: 'nope' }, value);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid input');
    expect(requests).toEqual([]);
  });
});

describe('get_logs', () => {
  it('passes the filters to the API as its query parameters', async () => {
    const { value, requests } = api({ '/v1/logs/pairflix': { status: 200, body: { events: [], scanned: 0 } } });
    await callTool('get_logs', { project: 'pairflix', since_hours: 24, level: 'error', search: 'youtube', limit: 10 }, value);
    expect(requests[0]?.url.searchParams.toString()).toBe('since=24&level=error&search=youtube&limit=10');
  });

  it('sends no query when no filters are given', async () => {
    const { value, requests } = api({ '/v1/logs/pairflix': { status: 200, body: { events: [], scanned: 0 } } });
    const result = await callTool('get_logs', { project: 'pairflix' }, value);
    expect(requests[0]?.url.search).toBe('');
    expect(JSON.parse(textOf(result))).toEqual({ events: [], scanned: 0 });
  });

  it.each([
    { since_hours: 169 },
    { since_hours: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { level: 'fatal' },
    { search: '' },
    { search: 'x'.repeat(101) },
  ])('rejects out-of-bounds input %o', async (bad) => {
    const { value, requests } = api();
    const result = await callTool('get_logs', { project: 'pairflix', ...bad }, value);
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('list_runs', () => {
  it('passes failed and limit to the API', async () => {
    const { value, requests } = api({ '/v1/runs/creatrgrid': { status: 200, body: { runs: [] } } });
    await callTool('list_runs', { project: 'creatrgrid', failed: true, limit: 5 }, value);
    expect(requests[0]?.url.searchParams.toString()).toBe('failed=true&limit=5');
  });

  it('leaves failed out when it is false', async () => {
    const { value, requests } = api({ '/v1/runs/creatrgrid': { status: 200, body: { runs: [] } } });
    await callTool('list_runs', { project: 'creatrgrid', failed: false }, value);
    expect(requests[0]?.url.search).toBe('');
  });

  it('rejects a limit over 50', async () => {
    const { value } = api();
    expect((await callTool('list_runs', { project: 'creatrgrid', limit: 51 }, value)).isError).toBe(true);
  });
});

describe('get_run', () => {
  it("fetches the run's jobs with the tail", async () => {
    const body = { jobs: [{ name: 'test', status: 'completed', conclusion: 'failure', failedSteps: ['pnpm test'], log: ['boom'] }] };
    const { value, requests } = api({ '/v1/runs/pairflix/43639019850': { status: 200, body } });
    const result = await callTool('get_run', { project: 'pairflix', run_id: 43639019850, tail: 20 }, value);
    expect(requests[0]?.url.pathname).toBe('/v1/runs/pairflix/43639019850');
    expect(requests[0]?.url.searchParams.toString()).toBe('tail=20');
    expect(JSON.parse(textOf(result))).toEqual(body);
  });

  it.each([{ run_id: -1 }, { run_id: 1.5 }, { run_id: 1, tail: 301 }])('rejects bad input %o', async (bad) => {
    const { value, requests } = api();
    expect((await callTool('get_run', { project: 'pairflix', ...bad }, value)).isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('get_errors', () => {
  it('fetches the project errors with limit and frames', async () => {
    const body = { issues: [{ shortId: 'ADS-1', level: 'error', count: 3, firstSeen: 'a', lastSeen: 'b', title: 'TypeError', frames: ['src/x.ts:1'] }] };
    const { value, requests } = api({ '/v1/errors/ads': { status: 200, body } });
    const result = await callTool('get_errors', { project: 'ads', limit: 5, frames: true }, value);
    expect(requests[0]?.url.pathname).toBe('/v1/errors/ads');
    expect(requests[0]?.url.searchParams.toString()).toBe('limit=5&frames=true');
    expect(JSON.parse(textOf(result))).toEqual(body);
  });

  it.each([{ limit: 0 }, { limit: 26 }, { frames: 'yes' }])('rejects bad input %o', async (bad) => {
    const { value, requests } = api();
    expect((await callTool('get_errors', { project: 'ads', ...bad }, value)).isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('MCP server', () => {
  async function connect(deps: ApiDeps): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(deps).connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('lists the tools, read-only, with their input schemas', async () => {
    const client = await connect(api().value);
    const { tools } = await client.listTools();
    expect(tools.map((item) => item.name)).toEqual(['list_projects', 'check_access', 'get_logs', 'list_runs', 'get_run', 'get_errors']);
    const getLogs = tools.find((item) => item.name === 'get_logs');
    expect(getLogs?.annotations?.readOnlyHint).toBe(true);
    expect(getLogs?.inputSchema.required).toEqual(['project']);
    expect(Object.keys(getLogs?.inputSchema.properties ?? {})).toEqual(['project', 'since_hours', 'level', 'search', 'limit']);
  });

  it('calls a tool through the protocol', async () => {
    const { value } = api({ '/v1/runs/pairflix': { status: 200, body: { runs: [] } } });
    const client = await connect(value);
    const result = await client.callTool({ name: 'list_runs', arguments: { project: 'pairflix' } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ runs: [] }, null, 2) }]);
  });

  it('returns an API refusal as a tool error through the protocol', async () => {
    const { value } = api({ '/v1/logs/pairflix': { status: 403, body: { error: 'You need write access to ideaSquared/pairflix' } } });
    const client = await connect(value);
    const result = await client.callTool({ name: 'get_logs', arguments: { project: 'pairflix' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'You need write access to ideaSquared/pairflix' }]);
  });
});
