import { describe, expect, it } from 'vitest';
import { latestFrames, listIssues } from '../src/sources/glitchtip.ts';
import { fakeHttp, glitchTipEvent, glitchTipIssue } from './fakes.ts';

const config = {
  url: 'https://errors.ads.example',
  org: 'ideasquared',
  project: 'ads-staging',
  token: 'gt-token',
  accessClientId: 'cid.access',
  accessClientSecret: 'csecret',
};
const ISSUES = '/api/0/projects/ideasquared/ads-staging/issues/';

describe('listIssues', () => {
  it('asks for unresolved issues with the GlitchTip token and the Access service token', async () => {
    const { fetcher, calls } = fakeHttp({ [ISSUES]: { status: 200, body: [glitchTipIssue()] } });
    await listIssues(config, 10, fetcher);
    const call = calls[0];
    const url = new URL(call?.url ?? '');
    expect(url.searchParams.get('query')).toBe('is:unresolved');
    expect(call?.headers.get('authorization')).toBe('Bearer gt-token');
    expect(call?.headers.get('cf-access-client-id')).toBe('cid.access');
    expect(call?.headers.get('cf-access-client-secret')).toBe('csecret');
    expect(call?.redirect).toBe('manual');
  });

  it('keeps only the summary fields, most frequent first', async () => {
    const { fetcher } = fakeHttp({
      [ISSUES]: { status: 200, body: [glitchTipIssue({ id: '7', shortId: 'ADS-7', count: 2 }), glitchTipIssue()] },
    });
    const issues = await listIssues(config, 1, fetcher);
    expect(issues).toEqual([
      {
        id: '42',
        shortId: 'ADS-1A',
        title: 'TypeError: no pet for alex@example.com',
        culprit: 'GET /api/v1/users/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b',
        count: 17,
        firstSeen: '2026-11-13T09:00:00.000Z',
        lastSeen: '2026-11-14T17:00:00.000Z',
        level: 'error',
      },
    ]);
  });

  it('replaces a short id that is not a plain id', async () => {
    const { fetcher } = fakeHttp({ [ISSUES]: { status: 200, body: [glitchTipIssue({ shortId: 'https://x.example/alex' })] } });
    expect((await listIssues(config, 5, fetcher))[0]?.shortId).toBe('42');
  });

  it('fails when Access turns the request away', async () => {
    const { fetcher } = fakeHttp({ [ISSUES]: { status: 403 } });
    await expect(listIssues(config, 5, fetcher)).rejects.toThrow('GlitchTip answered 403');
  });
});

describe('latestFrames', () => {
  it("returns the latest event's in-app frames as file:line, innermost first, and nothing else", async () => {
    const { fetcher } = fakeHttp({ '/api/0/issues/42/events/latest/': { status: 200, body: glitchTipEvent() } });
    const frames = await latestFrames(config, '42', fetcher);
    expect(frames).toEqual(['src/lib/owner.ts:9', 'src/routes/pets.ts:42']);
  });

  it('returns no frames for an event without an exception', async () => {
    const { fetcher } = fakeHttp({ '/api/0/issues/42/events/latest/': { status: 200, body: { entries: [] } } });
    expect(await latestFrames(config, '42', fetcher)).toEqual([]);
  });
});
