import { z } from 'zod';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LogQuery = {
  workers: readonly string[];
  from: number;
  to: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  search?: string;
  limit: number;
};

type Filter = { key: string; operation: string; type: 'string'; value: string };

// The body for Cloudflare's Workers Observability telemetry query.
export function buildQuery(query: LogQuery): Record<string, unknown> {
  const filters: Filter[] = [
    { key: '$metadata.service', operation: 'in', type: 'string', value: query.workers.join(',') },
    ...(query.level ? [{ key: '$metadata.level', operation: 'eq', type: 'string' as const, value: query.level }] : []),
  ];
  return {
    queryId: 'agent-idea',
    timeframe: { from: query.from, to: query.to },
    view: 'events',
    limit: query.limit,
    parameters: {
      filterCombination: 'and',
      filters,
      ...(query.search ? { needle: { value: query.search, isRegex: false, matchCase: false } } : {}),
    },
  };
}

// Only the fields we read. Everything else Cloudflare sends (client IP, location, headers, TLS
// details) is never touched.
const CloudflareEventSchema = z.object({
  timestamp: z.number(),
  $metadata: z
    .object({ service: z.string().optional(), level: z.string().optional(), message: z.string().optional() })
    .optional(),
  $workers: z
    .object({
      wallTimeMs: z.number().optional(),
      event: z
        .object({ path: z.string().optional(), response: z.object({ status: z.number().optional() }).optional() })
        .optional(),
    })
    .optional(),
});

const ResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({ events: z.object({ events: z.array(z.unknown()) }).optional() }).optional(),
});

// A Cloudflare event as the raw shape sanitiseEvent takes. Not yet safe to return.
export function toRawEvent(event: unknown): Record<string, unknown> | undefined {
  const parsed = CloudflareEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const { timestamp, $metadata, $workers } = parsed.data;
  return {
    timestamp,
    level: $metadata?.level,
    service: $metadata?.service,
    route: $workers?.event?.path,
    status: $workers?.event?.response?.status,
    durationMs: $workers?.wallTimeMs,
    message: $metadata?.message,
  };
}

export async function fetchWorkerLogs(
  query: LogQuery,
  cloudflare: { accountId: string; apiToken: string },
  fetcher: Fetch,
): Promise<Array<Record<string, unknown>>> {
  if (query.workers.length === 0) return [];
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cloudflare.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildQuery(query)),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare logs query answered ${response.status}`);
  const body = ResponseSchema.parse(await response.json());
  if (!body.success) throw new Error('Cloudflare logs query failed');
  return (body.result?.events?.events ?? []).map(toRawEvent).filter((event) => event !== undefined);
}
