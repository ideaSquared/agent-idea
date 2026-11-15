// An in-memory stand-in for the KV namespace, with only what the Worker uses.
export function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
  // Only get and put are implemented; the Worker calls nothing else.
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

type Route = { status: number; body?: unknown };

// A fetch that answers GitHub API paths from a table and records every call.
export function fakeGitHub(routes: Record<string, Route>) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, authorization: new Headers(init?.headers).get('authorization') });
    const route = routes[new URL(input).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status });
  };
  return { fetcher, calls };
}

type HttpRoute = { status: number; body?: unknown };

// A fetch that answers any host's paths from a table and records every call with its headers, for the sources
// behind Cloudflare Access (Loki, GlitchTip), where the Access headers matter.
export function fakeHttp(routes: Record<string, HttpRoute>) {
  const calls: Array<{ url: string; headers: Headers; redirect: RequestInit['redirect'] }> = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, headers: new Headers(init?.headers), redirect: init?.redirect });
    const route = routes[new URL(input).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status });
  };
  return { fetcher, calls };
}

// One line as adopt-dont-shop's @ideasquared/log writes it to Loki, with the personal data a careless log could hold.
export function adsLogLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-11-14T17:51:41.868Z',
    level: 'error',
    service: 'gateway',
    message: 'request failed for alex@example.com from 203.0.113.42',
    meta: {
      route: '/api/v1/pets/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b',
      status: 500,
      durationMs: 41.7,
      method: 'GET',
      requestId: 'req-1',
      trace_id: '0af7651916cd43dd8448eb211c80319c',
      email: 'alex@example.com',
    },
    error: {
      type: 'TypeError',
      message: 'cannot read owner of Alex Jenkins',
      stack: 'TypeError: cannot read owner of Alex Jenkins at db.internal:5432\n    at handler (/opt/ads/services/gateway/src/routes/pets.ts:42:13)\n    at run (node:internal/process:7:1)',
    },
    ...overrides,
  });
}

// A Loki query_range answer holding these lines, one stream per entry.
export function lokiBody(entries: ReadonlyArray<readonly [string, string]>, labels: Record<string, string> = { service: 'gateway', env: 'production', level: 'error' }) {
  return {
    status: 'success',
    data: { resultType: 'streams', result: entries.map(([ns, line]) => ({ stream: labels, values: [[ns, line]] })) },
  };
}

// A GlitchTip (Sentry API) issue with the fields that must never come back.
export function glitchTipIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    shortId: 'ADS-1A',
    title: 'TypeError: no pet for alex@example.com',
    culprit: 'GET /api/v1/users/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b',
    count: '17',
    userCount: 3,
    firstSeen: '2026-11-13T09:00:00.000000Z',
    lastSeen: '2026-11-14T17:00:00.000000Z',
    level: 'error',
    status: 'unresolved',
    permalink: 'https://glitchtip.example/ads/issues/42',
    metadata: { value: 'no pet for alex@example.com', filename: '/home/alex/src/x.ts' },
    project: { slug: 'ads' },
    ...overrides,
  };
}

// A GlitchTip latest event: exception frames plus the request, user, tags and breadcrumbs that must never come back.
export function glitchTipEvent() {
  return {
    eventID: 'abc',
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value: 'no pet for alex@example.com',
              stacktrace: {
                frames: [
                  { filename: 'node:internal/process', lineNo: 7, inApp: false },
                  { filename: '/opt/ads/services/gateway/src/routes/pets.ts', absPath: '/opt/ads/services/gateway/src/routes/pets.ts', lineNo: 42, colNo: 13, function: 'handler', inApp: true, context: [[42, 'const email = "alex@example.com"']], vars: { email: 'alex@example.com' } },
                  { filename: '/opt/ads/services/gateway/src/lib/owner.ts', lineNo: 9, inApp: true },
                ],
              },
            },
          ],
        },
      },
      { type: 'request', data: { url: 'https://ads.example/api/v1/users/alex', headers: [['Cookie', 'session=abc']] } },
      { type: 'breadcrumbs', data: { values: [{ message: 'login alex@example.com' }] } },
    ],
    user: { email: 'alex@example.com', ip_address: '203.0.113.42' },
    tags: [{ key: 'user', value: 'alex' }],
  };
}
