import { describe, expect, it } from 'vitest';
import { routeRules } from '../src/route-words.ts';
import { sanitiseEvent } from '../src/sanitise.ts';
import { buildQuery, fetchWorkerLogs, toRawEvent } from '../src/sources/workers-logs.ts';
import { fakeGitHub } from './fakes.ts';

// Shaped like a real Workers Logs event, with the personal data Cloudflare includes.
const cloudflareEvent = {
  source: { level: 'info', message: 'GET https://api.creatrgrid.com/api/v1/creators/paragonjenko' },
  dataset: 'cloudflare-workers',
  timestamp: 1794678701868,
  $workers: {
    event: {
      request: {
        cf: { city: 'Des Moines', postalCode: '50309', latitude: '41.60054', asOrganization: 'Microsoft Limited' },
        headers: { 'cf-connecting-ip': '9.234.106.55', 'user-agent': 'Mozilla/5.0', cookie: 'session=abc' },
        url: 'https://api.creatrgrid.com/api/v1/creators/paragonjenko?ref=alex@example.com',
      },
      path: '/api/v1/creators/paragonjenko',
      response: { status: 200 },
    },
    scriptName: 'creatorgrid-api',
    wallTimeMs: 78,
  },
  $metadata: {
    service: 'creatorgrid-api',
    level: 'info',
    message: 'GET https://api.creatrgrid.com/api/v1/creators/paragonjenko',
    trigger: 'GET /api/v1/creators/paragonjenko',
  },
};

describe('buildQuery', () => {
  it('filters to the project workers and the level, with no raw text search', () => {
    expect(buildQuery({ workers: ['a', 'b'], from: 1, to: 2, level: 'error', limit: 50 })).toEqual({
      queryId: 'agent-idea',
      timeframe: { from: 1, to: 2 },
      view: 'events',
      limit: 50,
      parameters: {
        filterCombination: 'and',
        filters: [
          { key: '$metadata.service', operation: 'in', type: 'string', value: 'a,b' },
          { key: '$metadata.level', operation: 'eq', type: 'string', value: 'error' },
        ],
      },
    });
  });
});

describe('toRawEvent', () => {
  it('reads only the fields Agent Idea uses', () => {
    expect(toRawEvent(cloudflareEvent)).toEqual({
      timestamp: 1794678701868,
      level: 'info',
      service: 'creatorgrid-api',
      route: '/api/v1/creators/paragonjenko',
      status: 200,
      durationMs: 78,
      message: 'GET https://api.creatrgrid.com/api/v1/creators/paragonjenko',
    });
  });

  it('skips events without a timestamp', () => {
    expect(toRawEvent({ $metadata: { message: 'x' } })).toBeUndefined();
  });

  it('leaves nothing personal once sanitised', async () => {
    const event = toRawEvent(cloudflareEvent);
    const serialised = JSON.stringify(await sanitiseEvent(event, 'k', routeRules('creatrgrid')));
    ['paragonjenko', 'Des Moines', '50309', '9.234.106.55', 'Mozilla', 'session', 'alex', 'Microsoft'].forEach((leak) =>
      expect(serialised).not.toContain(leak),
    );
  });
});

describe('fetchWorkerLogs', () => {
  const path = '/client/v4/accounts/acc/workers/observability/telemetry/query';

  it('returns raw events from Cloudflare', async () => {
    const { fetcher, calls } = fakeGitHub({
      [path]: { status: 200, body: { success: true, result: { events: { events: [cloudflareEvent] } } } },
    });
    const events = await fetchWorkerLogs(
      { workers: ['creatorgrid-api'], from: 1, to: 2, limit: 10 },
      { accountId: 'acc', apiToken: 'cf-token' },
      fetcher,
    );
    expect(events).toHaveLength(1);
    expect(calls[0]?.authorization).toBe('Bearer cf-token');
  });

  it('asks nothing for a project with no workers', async () => {
    const { fetcher, calls } = fakeGitHub({});
    expect(
      await fetchWorkerLogs({ workers: [], from: 1, to: 2, limit: 10 }, { accountId: 'a', apiToken: 't' }, fetcher),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws when Cloudflare refuses', async () => {
    const { fetcher } = fakeGitHub({ [path]: { status: 403 } });
    await expect(
      fetchWorkerLogs({ workers: ['x'], from: 1, to: 2, limit: 10 }, { accountId: 'acc', apiToken: 't' }, fetcher),
    ).rejects.toThrow('403');
  });
});
