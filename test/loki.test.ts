import { describe, expect, it } from 'vitest';
import { routeRules } from '../src/route-words.ts';
import { sanitiseEvent } from '../src/sanitise.ts';
import { buildLogQL, fetchLokiLogs, toRawEvent } from '../src/sources/loki.ts';
import { adsLogLine, fakeHttp, lokiBody } from './fakes.ts';

const config = { url: 'https://loki.ads.example/', accessClientId: 'cid.access', accessClientSecret: 'csecret' };
const PATH = '/loki/api/v1/query_range';

describe('buildLogQL', () => {
  it('selects every service, and the level when given, with no raw text filter', () => {
    expect(buildLogQL()).toBe('{service=~".+"}');
    expect(buildLogQL('warn')).toBe('{service=~".+", level="warn"}');
  });

  it('adds an env matcher from the fixed environment names', () => {
    expect(buildLogQL(undefined, 'staging')).toBe('{service=~".+", env="staging"}');
    expect(buildLogQL('error', 'staging')).toBe('{service=~".+", env="staging", level="error"}');
  });
});

describe('toRawEvent', () => {
  it('reads only the allowlisted fields of an @ideasquared/log line', () => {
    expect(toRawEvent(adsLogLine(), '1794678701868000000')).toEqual({
      timestamp: '2026-11-14T17:51:41.868Z',
      level: 'error',
      service: 'gateway',
      route: '/api/v1/pets/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b',
      status: 500,
      durationMs: 41.7,
      errorType: 'TypeError',
      message: 'request failed for alex@example.com from 203.0.113.42',
      stack: '    at handler (/opt/ads/services/gateway/src/routes/pets.ts:42:13)\n    at run (node:internal/process:7:1)',
    });
  });

  it("falls back to Loki's timestamp", () => {
    const line = JSON.stringify({ level: 'info', service: 'pets', message: 'pet archived' });
    expect(toRawEvent(line, '1794678701868000000')).toMatchObject({ timestamp: 1794678701868 });
  });

  it('drops a line that is not JSON', () => {
    expect(toRawEvent('plain text from alex@example.com', '1')).toBeUndefined();
  });

  it('is safe once sanitised: no email, IP, id, error text or undeclared meta', async () => {
    const raw = toRawEvent(adsLogLine(), '1');
    const event = await sanitiseEvent(raw, 'k', routeRules('ads'));
    expect(event).toEqual({
      timestamp: '2026-11-14T17:51:41.868Z',
      level: 'error',
      service: 'gateway',
      route: '/api/v1/pets/:param',
      status: 500,
      durationMs: 42,
      errorType: 'TypeError',
      message: 'request failed for [email] from [ip]',
      stack: ['src/routes/pets.ts:42', 'process:7'],
    });
    const serialised = JSON.stringify(event);
    ['alex', 'Alex Jenkins', '203.0.113.42', '3f2b8c1e', 'db.internal', 'req-1', '0af76519'].forEach((leak) =>
      expect(serialised).not.toContain(leak),
    );
  });
});

describe('fetchLokiLogs', () => {
  it('sends whole nanosecond bounds when the window is a fraction of an hour', async () => {
    const { fetcher, calls } = fakeHttp({ [PATH]: { status: 200, body: lokiBody([]) } });
    await fetchLokiLogs({ from: 1000.4567, to: 2000.2, limit: 50 }, config, fetcher);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('start')).toBe('1000000000');
    expect(url.searchParams.get('end')).toBe('2001000000');
  });

  it('sends the Access service token and a bounded query, newest first', async () => {
    const { fetcher, calls } = fakeHttp({
      [PATH]: { status: 200, body: lokiBody([['1794678701000000000', adsLogLine({ message: 'older' })], ['1794678702000000000', adsLogLine({ message: 'newer' })]]) },
    });
    const events = await fetchLokiLogs({ from: 1000, to: 2000, level: 'error', limit: 50 }, config, fetcher);
    expect(events.map((event) => event.message)).toEqual(['newer', 'older']);
    const call = calls[0];
    expect(call?.headers.get('cf-access-client-id')).toBe('cid.access');
    expect(call?.headers.get('cf-access-client-secret')).toBe('csecret');
    expect(call?.redirect).toBe('manual');
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe(`https://loki.ads.example${PATH}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '{service=~".+", level="error"}',
      start: '1000000000',
      end: '2000000000',
      limit: '50',
      direction: 'backward',
    });
  });

  it('fails when Access turns the request away', async () => {
    const { fetcher } = fakeHttp({ [PATH]: { status: 302 } });
    await expect(fetchLokiLogs({ from: 1, to: 2, limit: 1 }, config, fetcher)).rejects.toThrow('Loki answered 302');
  });
});
