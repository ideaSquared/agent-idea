import { describe, expect, it } from 'vitest';
import { cachedWriteAccess, checkWriteAccess } from '../src/index.ts';
import { fakeCache, fakeGitHub, REPO } from './fakes.ts';

const user = { status: 200, body: { login: 'octocat' } };
const repoWith = (permissions: Record<string, boolean>) => ({ status: 200, body: { permissions } });

describe('checkWriteAccess', () => {
  it('allows push, maintain and admin', async () => {
    const cases: Array<Record<string, boolean>> = [
      { push: true, admin: false },
      { push: false, maintain: true, admin: false },
      { push: false, admin: true },
    ];
    for (const permissions of cases) {
      const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith(permissions) });
      expect(await checkWriteAccess('t', REPO, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
    }
  });

  it('denies read-only access, as on a public repo', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ pull: true, push: false, admin: false }) });
    expect(await checkWriteAccess('t', REPO, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('denies when GitHub returns no permissions or the repo is hidden', async () => {
    const none = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: { status: 200, body: {} } });
    const hidden = fakeGitHub({ '/user': user });
    expect((await checkWriteAccess('t', REPO, none.fetcher)).outcome).toBe('denied');
    expect((await checkWriteAccess('t', REPO, hidden.fetcher)).outcome).toBe('denied');
  });

  it('reports a rejected token as unauthenticated', async () => {
    const { fetcher } = fakeGitHub({ '/user': { status: 401 } });
    expect(await checkWriteAccess('t', REPO, fetcher)).toEqual({ outcome: 'unauthenticated' });
  });

  it("asks GitHub with the caller's own token", async () => {
    const { fetcher, calls } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: true, admin: false }) });
    await checkWriteAccess('callers-token', REPO, fetcher);
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer callers-token', 'Bearer callers-token']);
  });

  it('throws when GitHub is failing, rather than guessing', async () => {
    const { fetcher } = fakeGitHub({ '/user': { status: 502 } });
    await expect(checkWriteAccess('t', REPO, fetcher)).rejects.toThrow();
  });
});

describe('cachedWriteAccess', () => {
  const routes = { '/user': user, [`/repos/${REPO}`]: repoWith({ push: true, admin: false }) };

  it('asks GitHub once, then answers from the cache', async () => {
    const cache = fakeCache();
    const { fetcher, calls } = fakeGitHub(routes);
    await cachedWriteAccess('t', REPO, cache, fetcher);
    expect(await cachedWriteAccess('t', REPO, cache, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
    expect(calls).toHaveLength(2);
  });

  it('keys the cache by a hash of the token and never stores the token', async () => {
    const cache = fakeCache();
    await cachedWriteAccess('very-secret-token', REPO, cache, fakeGitHub(routes).fetcher);
    expect(JSON.stringify([...cache.store.entries()])).not.toContain('very-secret-token');
    expect([...cache.store.keys()][0]).toMatch(/^ops-access:[0-9a-f]{64}:/);
  });

  it('does not cache a rejected token', async () => {
    const cache = fakeCache();
    await cachedWriteAccess('t', REPO, cache, fakeGitHub({ '/user': { status: 401 } }).fetcher);
    expect(cache.store.size).toBe(0);
  });

  it('still answers when the cache is failing', async () => {
    const broken = {
      get: async () => Promise.reject(new Error('kv down')),
      put: async () => Promise.reject(new Error('kv down')),
    };
    const access = await cachedWriteAccess('t', REPO, broken, fakeGitHub(routes).fetcher);
    expect(access.outcome).toBe('allowed');
  });
});
