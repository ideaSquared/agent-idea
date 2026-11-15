import { describe, expect, it } from 'vitest';
import { cachedWriteAccess, checkTeamMembership, checkWriteAccess } from '../src/index.ts';
import { fakeCache, fakeGitHub, ORG, REPO, TEAM, teamMember } from './fakes.ts';

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

describe('checkTeamMembership', () => {
  const team = { org: ORG, team: TEAM };

  it('allows an active member', async () => {
    const { fetcher } = teamMember({ status: 200, body: { state: 'active', role: 'member' } });
    expect(await checkTeamMembership('t', team, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
  });

  it('denies a pending invitation', async () => {
    const { fetcher } = teamMember({ status: 200, body: { state: 'pending' } });
    expect(await checkTeamMembership('t', team, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('denies a 404, as for a non-member', async () => {
    const { fetcher } = teamMember({ status: 404 });
    expect(await checkTeamMembership('t', team, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('is unauthenticated when GitHub rejects the token, at either call', async () => {
    const atUser = fakeGitHub({ '/user': { status: 401 } });
    const atMembership = teamMember({ status: 401 });
    expect(await checkTeamMembership('t', team, atUser.fetcher)).toEqual({ outcome: 'unauthenticated' });
    expect(await checkTeamMembership('t', team, atMembership.fetcher)).toEqual({ outcome: 'unauthenticated' });
  });

  it('throws on any other status, without the token in the message', async () => {
    const user = fakeGitHub({ '/user': { status: 502 } });
    const membership = teamMember({ status: 500 });
    const forbidden = teamMember({ status: 403 });
    for (const { fetcher } of [user, membership, forbidden]) {
      const failure = await checkTeamMembership('gh-secret-token', team, fetcher).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('gh-secret-token');
    }
  });

  it('throws on a membership body that is not a membership', async () => {
    const { fetcher } = teamMember({ status: 200, body: { nope: true } });
    await expect(checkTeamMembership('t', team, fetcher)).rejects.toThrow();
  });

  it('sends the caller token and the same headers as the repo check', async () => {
    const { fetcher, calls } = teamMember({ status: 200, body: { state: 'active' } });
    const seen: Array<Headers> = [];
    const spy = async (input: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return fetcher(input, init);
    };
    await checkTeamMembership('tok', team, spy);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/user',
      `/orgs/${ORG}/teams/${TEAM}/memberships/octocat`,
    ]);
    for (const headers of seen) {
      expect(headers.get('authorization')).toBe('Bearer tok');
      expect(headers.get('user-agent')).toBe('ideasquared-ops');
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    }
  });

  it('rejects malformed org and team slugs before asking GitHub', async () => {
    const { fetcher, calls } = teamMember({ status: 200, body: { state: 'active' } });
    for (const bad of [
      { org: '', team: TEAM },
      { org: 'a/b', team: TEAM },
      { org: ORG, team: '../x' },
      { org: ORG, team: 'a b' },
      { org: ORG, team: '' },
      { org: ORG, team: 'x?y' },
    ]) {
      await expect(checkTeamMembership('t', bad, fetcher)).rejects.toThrow('slug');
    }
    expect(calls).toHaveLength(0);
  });
});
