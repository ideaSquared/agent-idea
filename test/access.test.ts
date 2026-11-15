import { describe, expect, it } from 'vitest';
import { cachedTeamMembership, checkTeamMembership } from '../src/access.ts';
import { fakeGitHub, fakeKv } from './fakes.ts';

const TEAM = { org: 'ideaSquared', team: 'creatrgrid' };
const PATH = '/orgs/ideaSquared/teams/creatrgrid/memberships/octocat';
const user = { status: 200, body: { login: 'octocat' } };

describe('checkTeamMembership', () => {
  it('allows an active member', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'active' } } });
    expect(await checkTeamMembership('t', TEAM, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
  });

  it('denies a pending membership', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'pending' } } });
    expect(await checkTeamMembership('t', TEAM, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('denies a non-member (404)', async () => {
    const { fetcher } = fakeGitHub({ '/user': user });
    expect(await checkTeamMembership('t', TEAM, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('reports a token GitHub rejects as unauthenticated', async () => {
    const { fetcher } = fakeGitHub({ '/user': { status: 401 } });
    expect(await checkTeamMembership('t', TEAM, fetcher)).toEqual({ outcome: 'unauthenticated' });
  });

  it('reports a token rejected on the membership call as unauthenticated', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [PATH]: { status: 401 } });
    expect(await checkTeamMembership('t', TEAM, fetcher)).toEqual({ outcome: 'unauthenticated' });
  });

  it("asks GitHub with the caller's own token", async () => {
    const { fetcher, calls } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'active' } } });
    await checkTeamMembership('callers-token', TEAM, fetcher);
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer callers-token', 'Bearer callers-token']);
  });

  it('throws when GitHub is failing, rather than guessing', async () => {
    const user502 = fakeGitHub({ '/user': { status: 502 } });
    await expect(checkTeamMembership('t', TEAM, user502.fetcher)).rejects.toThrow();
    const team500 = fakeGitHub({ '/user': user, [PATH]: { status: 500 } });
    await expect(checkTeamMembership('t', TEAM, team500.fetcher)).rejects.toThrow();
  });

  it('refuses a malformed org or team before calling GitHub', async () => {
    const { fetcher, calls } = fakeGitHub({ '/user': user });
    await expect(checkTeamMembership('t', { org: 'ideaSquared', team: '../x' }, fetcher)).rejects.toThrow();
    await expect(checkTeamMembership('t', { org: 'a/b', team: 'ok' }, fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('cachedTeamMembership', () => {
  it('asks GitHub once, then answers from the cache', async () => {
    const kv = fakeKv();
    const { fetcher, calls } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'active' } } });
    await cachedTeamMembership('t', TEAM, kv, fetcher);
    expect(await cachedTeamMembership('t', TEAM, kv, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
    expect(calls).toHaveLength(2);
  });

  it('keeps teams apart', async () => {
    const kv = fakeKv();
    const { fetcher, calls } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'active' } } });
    await cachedTeamMembership('t', TEAM, kv, fetcher);
    const other = await cachedTeamMembership('t', { org: 'ideaSquared', team: 'pairflix' }, kv, fetcher);
    expect(other.outcome).toBe('denied');
    expect(calls).toHaveLength(4);
  });

  it('never stores the token', async () => {
    const kv = fakeKv();
    const { fetcher } = fakeGitHub({ '/user': user, [PATH]: { status: 200, body: { state: 'active' } } });
    await cachedTeamMembership('very-secret-token', TEAM, kv, fetcher);
    expect(JSON.stringify([...kv.store.entries()])).not.toContain('very-secret-token');
  });

  it('does not cache a rejected token', async () => {
    const kv = fakeKv();
    const { fetcher } = fakeGitHub({ '/user': { status: 401 } });
    await cachedTeamMembership('t', TEAM, kv, fetcher);
    expect(kv.store.size).toBe(0);
  });
});
