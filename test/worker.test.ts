import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { fakeGitHub, fakeKv } from './fakes.ts';

const env = (overrides: Partial<Env> = {}): Env => ({ ACCESS_CACHE: fakeKv(), PSEUDONYM_KEY: 'k', ...overrides });

function request(path: string, token?: string): Request {
  return new Request(`https://agent-idea.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function stubGitHub(push: boolean) {
  const { fetcher } = fakeGitHub({
    '/user': { status: 200, body: { login: 'octocat' } },
    '/repos/ideaSquared/pairflix': { status: 200, body: { permissions: { push, admin: false } } },
  });
  vi.stubGlobal('fetch', fetcher);
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.fetch(request('/v1/access/pairflix', 'secret-token'), env());
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([expect.stringContaining('"login":"octocat"')]);
    expect(lines.join()).not.toContain('secret-token');
    log.mockRestore();
  });
});

it('answers /health without a token', async () => {
  const response = await worker.fetch(request('/health'), env({ PSEUDONYM_KEY: undefined }));
  expect(response.status).toBe(200);
});
