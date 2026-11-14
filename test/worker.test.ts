import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { fakeGitHub, fakeKv } from './fakes.ts';

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
