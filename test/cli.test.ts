import { describe, expect, it } from 'vitest';
import { formatEvent, run, type Deps } from '../src/cli/main.ts';

function deps(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const lines: string[] = [];
  const urls: string[] = [];
  const warnings: string[] = [];
  const value: Deps = {
    apiUrl: 'https://agent-idea.example',
    token: 't',
    out: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    now: () => new Date('2027-11-01T00:00:00Z'),
    fetch: async (input) => {
      urls.push(input);
      const route = routes[new URL(input).pathname];
      return Response.json(route?.body ?? { error: 'Not found' }, {
        status: route?.status ?? 404,
        headers: route?.headers,
      });
    },
  };
  return { value, lines, urls, warnings };
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
    expect(formatEvent(event)).toBe(
      '2026-11-14 17:51:41Z  ERROR  pairflix-api  /api/households/:param/pick 500 78ms  pick failed',
    );
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

  it('passes --env to the API', async () => {
    const { value, urls } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [] } } });
    await run(['logs', 'pairflix', '--env', 'staging'], value);
    expect(new URL(urls[0] ?? '').searchParams.get('env')).toBe('staging');
  });

  it('sends no env without --env', async () => {
    const { value, urls } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [] } } });
    await run(['logs', 'pairflix'], value);
    expect(new URL(urls[0] ?? '').searchParams.has('env')).toBe(false);
  });

  it('rejects an unknown environment before calling the API', async () => {
    const { value, urls } = deps({});
    await expect(run(['logs', 'pairflix', '--env', 'dev'], value)).rejects.toThrow(
      "--env must be staging or production, not 'dev'",
    );
    expect(urls).toEqual([]);
  });

  it('prints JSON with --json', async () => {
    const { value, lines } = deps({ '/v1/logs/pairflix': { status: 200, body: { events: [event] } } });
    await run(['logs', 'pairflix', '--json'], value);
    expect(JSON.parse(lines[0] ?? '')).toEqual([event]);
  });

  it("shows the API's reason when access is refused", async () => {
    const { value } = deps({
      '/v1/logs/pairflix': { status: 403, body: { error: 'You need to be in the ideaSquared/pairflix team' } },
    });
    await expect(run(['logs', 'pairflix'], value)).rejects.toThrow('You need to be in the ideaSquared/pairflix team');
  });

  it('asks you to sign in when there is no token', async () => {
    const { value } = deps({});
    await expect(run(['logs', 'pairflix'], { ...value, token: undefined })).rejects.toThrow('gh auth login');
  });
});

describe('idea access', () => {
  it('confirms team membership', async () => {
    const { value, lines } = deps({
      '/v1/access/ads': { status: 200, body: { login: 'octocat', team: 'ideaSquared/adoptdontshop' } },
    });
    await run(['access', 'ads'], value);
    expect(lines).toEqual(['octocat is in the ideaSquared/adoptdontshop team.']);
  });
});

describe('token expiry warning', () => {
  const access = (expiresAt?: string) => ({
    '/v1/access/ads': {
      status: 200,
      body: { login: 'octocat', team: 'ideaSquared/adoptdontshop' },
      headers: expiresAt ? { 'x-token-expires-at': expiresAt } : undefined,
    },
  });

  it('warns when the token expires within 30 days, naming the date and the days left', async () => {
    const { value, lines, warnings } = deps(access('2027-11-21T13:20:00.000Z'));
    await run(['access', 'ads'], value);
    expect(warnings).toEqual([
      'Warning: your GitHub token expires on 2027-11-21 (in 20 days). Create a new one and replace it where you set it (GH_TOKEN, gh auth login or the cloud environment secret).',
    ]);
    expect(lines).toEqual(['octocat is in the ideaSquared/adoptdontshop team.']);
  });

  it('says "in less than a day" when the token expires within hours', async () => {
    const { value, warnings } = deps(access('2027-11-01T12:00:00.000Z'));
    await run(['access', 'ads'], value);
    expect(warnings[0]).toContain('expires on 2027-11-01 (in less than a day)');
  });

  it('stays quiet when the token has more than 30 days left, or never expires', async () => {
    for (const expiresAt of ['2027-12-01T12:00:00.000Z', '2027-12-15T00:00:00.000Z', undefined]) {
      const { value, warnings } = deps(access(expiresAt));
      await run(['access', 'ads'], value);
      expect(warnings).toEqual([]);
    }
  });
});

it('prints usage with no command', async () => {
  const { value, lines } = deps({});
  await run([], value);
  expect(lines[0]).toContain('idea logs <project>');
});

describe('idea runs', () => {
  const sampleRun = {
    id: 5,
    number: 9,
    workflow: 'CI',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    branch: 'main',
    sha: '1234567',
    createdAt: '2026-11-14T20:00:00Z',
  };

  it('prints one line per run with the id to look at', async () => {
    const { value, lines } = deps({ '/v1/runs/pairflix': { status: 200, body: { runs: [sampleRun] } } });
    await run(['runs', 'pairflix'], value);
    expect(lines).toEqual(['✗  CI #9  push  main  1234567  2026-11-14 20:00Z  id 5']);
  });

  it('passes --failed and --limit', async () => {
    const { value, urls } = deps({ '/v1/runs/pairflix': { status: 200, body: { runs: [] } } });
    await run(['runs', 'pairflix', '--failed', '--limit', '3'], value);
    expect(new URL(urls[0] ?? '').searchParams.toString()).toBe('limit=3&failed=true');
  });
});

describe('idea run', () => {
  it("prints each job, and a failed job's log underneath", async () => {
    const { value, lines } = deps({
      '/v1/runs/pairflix/5': {
        status: 200,
        body: {
          jobs: [
            { name: 'test', status: 'completed', conclusion: 'failure', failedSteps: ['Test'], log: ['boom'] },
            { name: 'deploy', status: 'completed', conclusion: 'skipped', failedSteps: [] },
          ],
        },
      },
    });
    await run(['run', 'pairflix', '5'], value);
    expect(lines).toEqual(['✗ test  (failed: Test)\n    boom', '- deploy']);
  });

  it('asks for the run id', async () => {
    const { value } = deps({});
    await expect(run(['run', 'pairflix'], value)).rejects.toThrow('Which run?');
  });
});

describe('idea errors', () => {
  const issue = {
    shortId: 'ADS-1A',
    title: 'TypeError: no pet for [email]',
    culprit: 'GET /api/v1/users/:param',
    count: 17,
    firstSeen: '2026-11-13T09:00:00.000Z',
    lastSeen: '2026-11-14T17:00:00.000Z',
    level: 'error',
  };

  it('prints one issue per line, busiest first, with frames underneath', async () => {
    const { value, lines } = deps({
      '/v1/errors/ads': { status: 200, body: { issues: [{ ...issue, frames: ['src/routes/pets.ts:42'] }] } },
    });
    await run(['errors', 'ads', '--frames'], value);
    expect(lines).toEqual([
      'ADS-1A  ERROR  17x  last 2026-11-14 17:00Z  first 2026-11-13 09:00Z  TypeError: no pet for [email]  (GET /api/v1/users/:param)\n    at src/routes/pets.ts:42',
    ]);
  });

  it('passes --limit and --frames', async () => {
    const { value, urls } = deps({ '/v1/errors/ads': { status: 200, body: { issues: [] } } });
    await run(['errors', 'ads', '--limit', '5', '--frames'], value);
    expect(new URL(urls[0] ?? '').searchParams.toString()).toBe('limit=5&frames=true');
  });

  it('prints JSON with --json', async () => {
    const { value, lines } = deps({ '/v1/errors/ads': { status: 200, body: { issues: [issue] } } });
    await run(['errors', 'ads', '--json'], value);
    expect(JSON.parse(lines[0] ?? '')).toEqual([issue]);
  });

  it('says when there are none', async () => {
    const { value, lines } = deps({ '/v1/errors/ads': { status: 200, body: { issues: [] } } });
    await run(['errors', 'ads'], value);
    expect(lines).toEqual(['No unresolved issues.']);
  });

  it("shows the API's reason for a project with no error tracker", async () => {
    const { value } = deps({
      '/v1/errors/pairflix': { status: 404, body: { error: 'No error tracker for pairflix' } },
    });
    await expect(run(['errors', 'pairflix'], value)).rejects.toThrow('No error tracker for pairflix');
  });
});

describe('idea errors --env', () => {
  it('passes --env to the API and shows its refusal', async () => {
    const { value, urls } = deps({
      '/v1/errors/ads': {
        status: 400,
        body: { error: "Project 'ads' has no way to tell environments apart, so --env is not available" },
      },
    });
    await expect(run(['errors', 'ads', '--env', 'production'], value)).rejects.toThrow(
      "Project 'ads' has no way to tell environments apart",
    );
    expect(new URL(urls[0] ?? '').searchParams.get('env')).toBe('production');
  });
});
