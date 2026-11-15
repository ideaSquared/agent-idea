import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { adsLogLine, fakeGitHub, fakeHttp, fakeKv, glitchTipEvent, glitchTipIssue, lokiBody } from './fakes.ts';

const env = (overrides: Partial<Env> = {}): Env => ({
  ACCESS_CACHE: fakeKv(),
  PSEUDONYM_KEY: 'k',
  CF_ACCOUNT_ID: 'acc',
  CF_API_TOKEN: 'cf',
  ...overrides,
});

const LOGS_PATH = '/client/v4/accounts/acc/workers/observability/telemetry/query';

function request(path: string, token?: string): Request {
  return new Request(`https://agent-idea.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function stubGitHub(push: boolean, cloudflareEvents: unknown[] = []) {
  const stub = fakeGitHub({
    '/user': { status: 200, body: { login: 'octocat' } },
    '/repos/ideaSquared/pairflix': { status: 200, body: { permissions: { push, admin: false } } },
    [LOGS_PATH]: { status: 200, body: { success: true, result: { events: { events: cloudflareEvents } } } },
  });
  vi.stubGlobal('fetch', stub.fetcher);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /v1/access/:project', () => {
  it('confirms write access', async () => {
    stubGitHub(true);
    const response = await worker.fetch(request('/v1/access/pairflix', 't'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project: 'pairflix',
      repo: 'ideaSquared/pairflix',
      login: 'octocat',
      access: 'write',
    });
  });

  it('refuses without write access', async () => {
    stubGitHub(false);
    const response = await worker.fetch(request('/v1/access/pairflix', 't'), env());
    expect(response.status).toBe(403);
  });

  it('asks for a sign-in when there is no token', async () => {
    const response = await worker.fetch(request('/v1/access/pairflix'), env());
    expect(response.status).toBe(401);
  });

  it('rejects an unknown project', async () => {
    const response = await worker.fetch(request('/v1/access/nope', 't'), env());
    expect(response.status).toBe(404);
  });

  it('serves nothing until the pseudonym key is set', async () => {
    stubGitHub(true);
    const response = await worker.fetch(request('/v1/access/pairflix', 't'), env({ PSEUDONYM_KEY: undefined }));
    expect(response.status).toBe(503);
  });

  it('records who asked, without the token', async () => {
    stubGitHub(true);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await worker.fetch(request('/v1/access/pairflix', 'secret-token'), env());
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ message: 'access checked', meta: { actor: 'octocat', project: 'pairflix', route: 'access', outcome: 'allowed' } }),
    ]);
    expect(lines.join()).not.toContain('secret-token');
    log.mockRestore();
  });
});

it('answers /health without a token', async () => {
  const response = await worker.fetch(request('/health'), env({ PSEUDONYM_KEY: undefined }));
  expect(response.status).toBe(200);
});

describe('GET /v1/logs/:project', () => {
  const event = {
    timestamp: 1794678701868,
    $metadata: { service: 'pairflix-api', level: 'error', message: 'pick failed for alex@example.com' },
    $workers: { event: { path: '/api/households/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b/pick', response: { status: 500 } } },
  };

  it('returns sanitised events', async () => {
    stubGitHub(true, [event]);
    const response = await worker.fetch(request('/v1/logs/pairflix?level=error', 't'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [
        {
          timestamp: '2026-11-14T17:51:41.868Z',
          level: 'error',
          service: 'pairflix-api',
          route: '/api/households/:param/pick',
          status: 500,
          message: 'pick failed for [email]',
        },
      ],
      scanned: 1,
    });
  });

  it('searches only sanitised events, so hidden data cannot be found', async () => {
    const slugEvent = { ...event, $metadata: { ...event.$metadata, message: 'GET https://x.example/api/creators/paragonjenko' } };
    stubGitHub(true, [slugEvent, event]);
    const hidden = await worker.fetch(request('/v1/logs/pairflix?search=paragonjenko', 't'), env());
    expect(await hidden.json()).toEqual({ events: [], scanned: 2 });
    const visible = await worker.fetch(request('/v1/logs/pairflix?search=pick%20failed', 't'), env());
    expect(((await visible.json()) as { events: unknown[] }).events).toHaveLength(1);
  });

  it('refuses without write access, before asking Cloudflare', async () => {
    const { calls } = stubGitHub(false, [event]);
    const response = await worker.fetch(request('/v1/logs/pairflix', 't'), env());
    expect(response.status).toBe(403);
    expect(calls.some((call) => call.url.includes('cloudflare'))).toBe(false);
  });

  it('rejects a window longer than Workers Logs keeps', async () => {
    stubGitHub(true);
    const response = await worker.fetch(request('/v1/logs/pairflix?since=500', 't'), env());
    expect(response.status).toBe(400);
  });

  it('says so when Cloudflare is not configured', async () => {
    stubGitHub(true);
    const response = await worker.fetch(request('/v1/logs/pairflix', 't'), env({ CF_API_TOKEN: undefined }));
    expect(response.status).toBe(503);
  });
});

describe('GET /v1/runs/:project', () => {
  function stubRuns(
    push: boolean,
    { workflowName = 'CI', jobName = 'test', stepName = 'Test', extraJobs = [] as unknown[] } = {},
  ) {
    const signed = 'https://pipelines.example.net/logs/10?sig=abc';
    const routes: Record<string, { status: number; body?: unknown; text?: string; location?: string }> = {
      '/user': { status: 200, body: { login: 'octocat' } },
      '/repos/ideaSquared/pairflix': { status: 200, body: { permissions: { push, admin: false }, default_branch: 'master' } },
      '/repos/ideaSquared/pairflix/actions/runs': {
        status: 200,
        body: { workflow_runs: [{ id: 5, run_number: 9, name: workflowName, event: 'push', status: 'completed', conclusion: 'failure', head_branch: 'master', head_sha: '1234567abcdef', created_at: '2026-11-14T20:00:00Z', html_url: 'https://github.com/ideaSquared/pairflix/actions/runs/5' }] },
      },
      '/repos/ideaSquared/pairflix/actions/runs/5/jobs': {
        status: 200,
        body: { jobs: [{ id: 10, name: jobName, status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, steps: [{ name: stepName, conclusion: 'failure' }] }, ...extraJobs] },
      },
      '/repos/ideaSquared/pairflix/actions/jobs/10/logs': { status: 302, location: signed },
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`/repos/ideaSquared/pairflix/actions/jobs/${100 + i}/logs`, { status: 200, text: `job ${100 + i} failed` }]),
      ),
      [signed]: { status: 200, text: 'login failed for alex@example.com\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123\nGET https://api.example.com/api/households/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b/pick 500' },
    };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      calls.push(input);
      const parsed = new URL(input);
      const route = routes[input] ?? routes[parsed.pathname];
      if (!route) return new Response('not found', { status: 404 });
      const headers = route.location ? { location: route.location } : undefined;
      return new Response(route.text ?? (route.body === undefined ? null : JSON.stringify(route.body)), { status: route.status, headers });
    });
    return calls;
  }

  it('lists recent runs', async () => {
    stubRuns(true);
    const response = await worker.fetch(request('/v1/runs/pairflix?limit=5', 't'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runs: [{ id: 5, number: 9, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', branch: 'master', sha: '1234567', createdAt: '2026-11-14T20:00:00Z', url: 'https://github.com/ideaSquared/pairflix/actions/runs/5' }],
    });
  });

  it('returns a run with the sanitised log tail of each failed job', async () => {
    stubRuns(true);
    const response = await worker.fetch(request('/v1/runs/pairflix/5', 't'), env());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: Array<{ name: string; failedSteps: string[]; log: string[] }> };
    expect(body.jobs[0]).toMatchObject({ name: 'test', failedSteps: ['Test'] });
    const log = body.jobs[0]?.log.join('\n') ?? '';
    expect(log).toContain('login failed for [email]');
    expect(log).toContain('/api/households/:param/pick');
    ['alex@example.com', 'ghp_', '3f2b8c1e'].forEach((leak) => expect(log).not.toContain(leak));
  });

  it('refuses without write access, before asking for runs', async () => {
    const calls = stubRuns(false);
    const response = await worker.fetch(request('/v1/runs/pairflix', 't'), env());
    expect(response.status).toBe(403);
    expect(calls.some((url) => url.includes('/actions/'))).toBe(false);
  });

  it('scrubs workflow, job and step names', async () => {
    stubRuns(true, { workflowName: 'CI for alex@example.com', jobName: 'deploy to 203.0.113.42', stepName: 'notify bob@example.com' });
    const runsBody = JSON.stringify(await (await worker.fetch(request('/v1/runs/pairflix', 't'), env())).json());
    const runBody = JSON.stringify(await (await worker.fetch(request('/v1/runs/pairflix/5', 't'), env())).json());
    ['alex@example.com', '203.0.113.42', 'bob@example.com'].forEach((leak) => {
      expect(runsBody).not.toContain(leak);
      expect(runBody).not.toContain(leak);
    });
    expect(runsBody).toContain('CI for [email]');
  });

  it('fetches logs for at most ten failed jobs and marks the rest', async () => {
    const extraJobs = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `shard ${i}`, status: 'completed', conclusion: 'failure', started_at: null, completed_at: null }));
    stubRuns(true, { extraJobs });
    const body = (await (await worker.fetch(request('/v1/runs/pairflix/5', 't'), env())).json()) as { jobs: Array<{ log?: string[]; logOmitted?: boolean }> };
    expect(body.jobs.filter((job) => job.log)).toHaveLength(10);
    expect(body.jobs.filter((job) => job.logOmitted)).toHaveLength(3);
  });

  it('rejects a run id on other routes', async () => {
    stubRuns(true);
    const response = await worker.fetch(request('/v1/logs/pairflix/5', 't'), env());
    expect(response.status).toBe(404);
  });
});

describe('adopt-dont-shop (Loki and GlitchTip behind Cloudflare Access)', () => {
  const adsEnv = (overrides: Partial<Env> = {}): Env =>
    env({
      ADS_LOKI_URL: 'https://loki.ads.example',
      ADS_GLITCHTIP_URL: 'https://errors.ads.example',
      ADS_GLITCHTIP_ORG: 'ideasquared',
      ADS_GLITCHTIP_PROJECT: 'ads-staging',
      ADS_GLITCHTIP_TOKEN: 'gt-token',
      ADS_ACCESS_CLIENT_ID: 'cid.access',
      ADS_ACCESS_CLIENT_SECRET: 'csecret',
      ...overrides,
    });

  function stubAds(push: boolean, { lines = [adsLogLine()], issues = [glitchTipIssue()], lokiStatus = 200, event = glitchTipEvent() as unknown } = {}) {
    const stub = fakeHttp({
      '/user': { status: 200, body: { login: 'octocat' } },
      '/repos/ideaSquared/adopt-dont-shop': { status: 200, body: { permissions: { push, admin: false } } },
      '/repos/ideaSquared/pairflix': { status: 200, body: { permissions: { push, admin: false } } },
      '/loki/api/v1/query_range': { status: lokiStatus, body: lokiBody(lines.map((line, i) => [`179467870${i}000000000`, line] as const)) },
      '/api/0/projects/ideasquared/ads-staging/issues/': { status: 200, body: issues },
      '/api/0/issues/42/events/latest/': { status: 200, body: event },
    });
    vi.stubGlobal('fetch', stub.fetcher);
    return stub;
  }

  const LEAKS = ['alex', 'Alex Jenkins', '203.0.113.42', '3f2b8c1e', 'permalink', 'glitchtip.example', 'userCount', 'session=abc', 'breadcrumbs'];

  describe('GET /v1/logs/ads', () => {
    it('returns sanitised Loki events', async () => {
      stubAds(true);
      const response = await worker.fetch(request('/v1/logs/ads?level=error', 't'), adsEnv());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        events: [
          {
            timestamp: '2026-11-14T17:51:41.868Z',
            level: 'error',
            service: 'gateway',
            route: '/api/v1/pets/:param',
            status: 500,
            durationMs: 42,
            errorType: 'TypeError',
            message: 'request failed for [email] from [ip]',
            stack: ['src/routes/pets.ts:42', 'process:7'],
          },
        ],
        scanned: 1,
      });
      LEAKS.forEach((leak) => expect(JSON.stringify(body)).not.toContain(leak));
    });

    it('searches only sanitised events', async () => {
      stubAds(true);
      const hidden = await worker.fetch(request('/v1/logs/ads?search=alex', 't'), adsEnv());
      expect(await hidden.json()).toEqual({ events: [], scanned: 1 });
      const visible = await worker.fetch(request('/v1/logs/ads?search=request%20failed', 't'), adsEnv());
      expect(((await visible.json()) as { events: unknown[] }).events).toHaveLength(1);
    });

    it('says so when ADS logs are not configured, without asking Loki', async () => {
      const { calls } = stubAds(true);
      const response = await worker.fetch(request('/v1/logs/ads', 't'), adsEnv({ ADS_LOKI_URL: '', ADS_ACCESS_CLIENT_SECRET: undefined }));
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: 'ADS logs are not configured' });
      expect(calls.some((call) => call.url.includes('loki'))).toBe(false);
    });

    it('refuses without write access, before asking Loki', async () => {
      const { calls } = stubAds(false);
      const response = await worker.fetch(request('/v1/logs/ads', 't'), adsEnv());
      expect(response.status).toBe(403);
      expect(calls.some((call) => call.url.includes('loki'))).toBe(false);
    });

    it('answers 502 with a fixed message when Access turns the Worker away', async () => {
      stubAds(true, { lokiStatus: 403 });
      const response = await worker.fetch(request('/v1/logs/ads', 't'), adsEnv());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'Loki could not be read' });
    });
  });

  describe('GET /v1/errors/:project', () => {
    it('returns scrubbed unresolved issues, without links or event bodies', async () => {
      stubAds(true);
      const response = await worker.fetch(request('/v1/errors/ads', 't'), adsEnv());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { issues: Array<Record<string, unknown>> };
      expect(body.issues).toEqual([
        {
          shortId: 'ADS-1A',
          title: 'TypeError',
          culprit: expect.stringMatching(/^GET \/api\/v1\/users\/:param$/),
          count: 17,
          firstSeen: '2026-11-13T09:00:00.000Z',
          lastSeen: '2026-11-14T17:00:00.000Z',
          level: 'error',
        },
      ]);
      LEAKS.forEach((leak) => expect(JSON.stringify(body)).not.toContain(leak));
    });

    it('adds the latest stack frames, file:line only, when asked', async () => {
      stubAds(true);
      const response = await worker.fetch(request('/v1/errors/ads?frames=true', 't'), adsEnv());
      const body = (await response.json()) as { issues: Array<{ frames?: string[] }> };
      expect(body.issues[0]?.frames).toEqual(['src/lib/owner.ts:9', 'src/routes/pets.ts:42']);
      LEAKS.forEach((leak) => expect(JSON.stringify(body)).not.toContain(leak));
    });

    const firstIssue = async (overrides: Record<string, unknown>, query = '') => {
      stubAds(true, { issues: [glitchTipIssue(overrides)] });
      const response = await worker.fetch(request(`/v1/errors/ads${query}`, 't'), adsEnv());
      return ((await response.json()) as { issues: Array<{ title: string; culprit: string; frames?: string[] }> }).issues[0];
    };

    it('returns only the exception type of a title, never its free-text message', async () => {
      expect((await firstIssue({ title: 'TypeError: cannot read owner of Alex Jenkins' }))?.title).toBe('TypeError');
      expect((await firstIssue({ title: 'Alex Jenkins could not log in' }))?.title).toBe('Error');
    });

    it('templates a bare-path culprit and drops one it cannot read', async () => {
      expect((await firstIssue({ culprit: '/api/v1/users/alex-jenkins?view=profile' }))?.culprit).toBe('/api/v1/users/:param');
      expect((await firstIssue({ culprit: 'Alex Jenkins pressed save twice' }))?.culprit).toBe('');
    });

    it('clips a culprit only after scrubbing it, so a secret across the limit is still removed', async () => {
      const issue = await firstIssue({ culprit: `${'h'.repeat(284)} in src/alex@example.org.ts` });
      expect(issue?.culprit).not.toContain('alex');
      expect(issue?.culprit.length).toBeLessThanOrEqual(300);
    });

    it('scrubs stack frame paths', async () => {
      const event = glitchTipEvent();
      const values = (event.entries[0]?.data as { values: Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }> }).values;
      values[0]?.stacktrace.frames.push({ filename: '/opt/ads/src/alex@example.org.ts', lineNo: 9, inApp: true });
      stubAds(true, { event });
      const response = await worker.fetch(request('/v1/errors/ads?frames=true', 't'), adsEnv());
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain('alex');
    });

    it('says so when ADS errors are not configured', async () => {
      const { calls } = stubAds(true);
      const response = await worker.fetch(request('/v1/errors/ads', 't'), adsEnv({ ADS_GLITCHTIP_TOKEN: undefined }));
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: 'ADS errors are not configured' });
      expect(calls.some((call) => call.url.includes('/api/0/'))).toBe(false);
    });

    it('says a project has no error tracker', async () => {
      stubAds(true);
      const response = await worker.fetch(request('/v1/errors/pairflix', 't'), adsEnv());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'No error tracker for pairflix' });
    });

    it('refuses without write access, before asking GlitchTip', async () => {
      const { calls } = stubAds(false);
      const response = await worker.fetch(request('/v1/errors/ads', 't'), adsEnv());
      expect(response.status).toBe(403);
      expect(calls.some((call) => call.url.includes('/api/0/'))).toBe(false);
    });

    it('records the audit line for the errors route', async () => {
      stubAds(true);
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      await worker.fetch(request('/v1/errors/ads', 't'), adsEnv());
      const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(lines).toEqual([
        expect.objectContaining({ message: 'access checked', meta: { actor: 'octocat', project: 'ads', route: 'errors', outcome: 'allowed' } }),
      ]);
      log.mockRestore();
    });

    it('rejects a limit over 25', async () => {
      stubAds(true);
      const response = await worker.fetch(request('/v1/errors/ads?limit=26', 't'), adsEnv());
      expect(response.status).toBe(400);
    });
  });
});
