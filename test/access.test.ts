import { describe, expect, it } from 'vitest';
import { cachedWriteAccess, checkWriteAccess } from '../src/access.ts';
import { fakeGitHub, fakeKv } from './fakes.ts';

const REPO = 'ideaSquared/creatrgrid';
const user = { status: 200, body: { login: 'octocat' } };
const repoWith = (permissions: Record<string, boolean>) => ({ status: 200, body: { permissions } });

describe('checkWriteAccess', () => {
  it('allows a user with push access', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: true, admin: false }) });
    expect(await checkWriteAccess('t', REPO, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
  });

  it('allows maintainers and admins', async () => {
    const maintain = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: false, maintain: true, admin: false }) });
    const admin = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: false, admin: true }) });
    expect((await checkWriteAccess('t', REPO, maintain.fetcher)).outcome).toBe('allowed');
    expect((await checkWriteAccess('t', REPO, admin.fetcher)).outcome).toBe('allowed');
  });

  it('denies read-only access, as on a public repo', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ pull: true, push: false, admin: false }) });
    expect(await checkWriteAccess('t', REPO, fetcher)).toEqual({ outcome: 'denied', login: 'octocat' });
  });

  it('denies when GitHub returns no permissions', async () => {
    const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: { status: 200, body: {} } });
    expect((await checkWriteAccess('t', REPO, fetcher)).outcome).toBe('denied');
  });

  it('denies a repo the user cannot see', async () => {
    const { fetcher } = fakeGitHub({ '/user': user });
    expect((await checkWriteAccess('t', REPO, fetcher)).outcome).toBe('denied');
  });

  it('reports a token GitHub rejects as unauthenticated', async () => {
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
  it('asks GitHub once, then answers from the cache', async () => {
    const kv = fakeKv();
    const { fetcher, calls } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: true, admin: false }) });
    await cachedWriteAccess('t', REPO, kv, fetcher);
    expect(await cachedWriteAccess('t', REPO, kv, fetcher)).toEqual({ outcome: 'allowed', login: 'octocat' });
    expect(calls).toHaveLength(2);
  });

  it('never stores the token', async () => {
    const kv = fakeKv();
    const { fetcher } = fakeGitHub({ '/user': user, [`/repos/${REPO}`]: repoWith({ push: true, admin: false }) });
    await cachedWriteAccess('very-secret-token', REPO, kv, fetcher);
    const everything = JSON.stringify([...kv.store.entries()]);
    expect(everything).not.toContain('very-secret-token');
  });

  it('does not cache a rejected token', async () => {
    const kv = fakeKv();
    const { fetcher } = fakeGitHub({ '/user': { status: 401 } });
    await cachedWriteAccess('t', REPO, kv, fetcher);
    expect(kv.store.size).toBe(0);
  });
});
