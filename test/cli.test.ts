import { describe, expect, it } from 'vitest';
import { formatEvent, run, type Deps } from '../src/cli/main.ts';

function deps(routes: Record<string, { status: number; body: unknown }>) {
  const lines: string[] = [];
  const urls: string[] = [];
  const value: Deps = {
    apiUrl: 'https://agent-idea.example',
    token: 't',
    out: (line) => lines.push(line),
    fetch: async (input) => {
      urls.push(input);
      const route = routes[new URL(input).pathname];
      return Response.json(route?.body ?? { error: 'Not found' }, { status: route?.status ?? 404 });
    },
  };
  return { value, lines, urls };
}

const event = {
  timestamp: '2026-11-14T17:51:41.868Z',
  level: 'error',
  service: 'pairflix-api',
  route: '/api/households/:param/pick',
  status: 500,
  durationMs: 78,
  message: 'pick failed',
};

describe('formatEvent', () => {
  it('puts time, level, service and request on one line', () => {
    expect(formatEvent(event)).toBe('2026-11-14 17:51:41Z  ERROR  pairflix-api  /api/households/:param/pick 500 78ms  pick failed');
  });

  it('prints stack frames underneath', () => {
    expect(formatEvent({ ...event, stack: ['src/lib/pick.ts:12'] })).toContain('\n    at src/lib/pick.ts:12');
  });
});

describe('idea logs', () => {
  it('prints events oldest first', async () => {
    const newer = { ...event, timestamp: '2026-11-14T18:00:00.000Z', message: 'newer' };
    const { value, lines } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [newer, event] } } });
    await run(['logs', 'pairflix'], value);
    expect(lines.map((line) => line.split('  ').pop())).toEqual(['pick failed', 'newer']);
  });

  it('passes the filters to the API', async () => {
    const { value, urls } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [] } } });
    await run(['logs', 'pairflix', '--since', '24', '--level', 'error', '--search', 'youtube'], value);
    expect(new URL(urls[0] ?? '').searchParams.toString()).toBe('since=24&level=error&search=youtube');
  });

  it('prints JSON with --json', async () => {
    const { value, lines } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [event] } } });
    await run(['logs', 'pairflix', '--json'], value);
    expect(JSON.parse(lines[0] ?? '')).toEqual([event]);
  });

  it("shows the API's reason when access is refused", async () => {
    const { value } = deps({ '/v1/logs/pairflix': { status: 403, body: { error: 'You need write access to ideaSquared/pairflix' } } });
    await expect(run(['logs', 'pairflix'], value)).rejects.toThrow('You need write access to ideaSquared/pairflix');
  });

  it('asks you to sign in when there is no token', async () => {
    const { value } = deps({});
    await expect(run(['logs', 'pairflix'], { ...value, token: undefined })).rejects.toThrow('gh auth login');
  });
});

describe('idea access', () => {
  it('confirms write access', async () => {
    const { value, lines } = deps({
      '/v1/access/ads': { status: 200, body: { login: 'octocat', repo: 'ideaSquared/adopt-dont-shop' } },
    });
    await run(['access', 'ads'], value);
    expect(lines).toEqual(['octocat has write access to ideaSquared/adopt-dont-shop.']);
  });
});

it('prints usage with no command', async () => {
  const { value, lines } = deps({});
  await run([], value);
  expect(lines[0]).toContain('idea logs <project>');
});
