import { z } from 'zod';
import type { Environment } from '../projects.ts';
import { accessHeaders, type AccessToken } from './cf-access.ts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LokiConfig = AccessToken & { url: string };

export type LokiQuery = {
  from: number;
  to: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  // One of the fixed environment names, never user text: it goes straight into the selector.
  env?: Environment;
  limit: number;
};

// Every stream adopt-dont-shop's Loki sink writes carries `service`, `env` (DEPLOY_ENV) and `level` labels. There is
// deliberately no line filter: searching raw lines would reveal whether data the sanitiser removes (a name, an
// email) is in them. Only the two enums reach the selector.
export function buildLogQL(level?: LokiQuery['level'], env?: Environment): string {
  const matchers = ['service=~".+"', ...(env ? [`env="${env}"`] : []), ...(level ? [`level="${level}"`] : [])];
  return `{${matchers.join(', ')}}`;
}

// Only the fields we read from an @ideasquared/log line. Everything else (other meta fields, the error message,
// trace ids) is never touched.
const LineSchema = z.object({
  timestamp: z.string().optional(),
  level: z.string().optional(),
  service: z.string().optional(),
  message: z.string().optional(),
  meta: z
    .object({ route: z.string().optional(), status: z.number().optional(), durationMs: z.number().optional() })
    .optional(),
  error: z.object({ type: z.string().optional(), stack: z.string().optional() }).optional(),
});

const ResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(z.object({ values: z.array(z.tuple([z.string().regex(/^\d{1,20}$/), z.string()])) })),
  }),
});

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// A Loki line as the raw shape sanitiseEvent takes. Not yet safe to return. The error message is left out: it is
// free text from a library or a throw site and the likeliest place for a name. Of the stack, only the `at` lines
// are kept, because the first line repeats that message.
export function toRawEvent(line: string, nanoseconds: string): Record<string, unknown> | undefined {
  const parsed = LineSchema.safeParse(parseJson(line));
  if (!parsed.success) return undefined;
  const { timestamp, level, service, message, meta, error } = parsed.data;
  const frames = error?.stack
    ?.split('\n')
    .filter((frame) => /^\s*at\s/.test(frame))
    .join('\n');
  return {
    timestamp: timestamp ?? Math.floor(Number(nanoseconds) / 1_000_000),
    level,
    service,
    route: meta?.route,
    status: meta?.status,
    durationMs: meta?.durationMs,
    errorType: error?.type,
    message,
    ...(frames ? { stack: frames } : {}),
  };
}

export async function fetchLokiLogs(query: LokiQuery, config: LokiConfig, fetcher: Fetch): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    query: buildLogQL(query.level, query.env),
    // Loki reads a decimal as seconds, so the millisecond bounds must be whole numbers before adding the zeros.
    start: `${Math.floor(query.from)}000000`,
    end: `${Math.ceil(query.to)}000000`,
    limit: String(query.limit),
    direction: 'backward',
  });
  // Access answers a bad service token with a redirect to its login page, so redirects are not followed.
  const response = await fetcher(`${config.url.replace(/\/+$/, '')}/loki/api/v1/query_range?${params}`, {
    headers: accessHeaders(config),
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`Loki answered ${response.status}`);
  const body = ResponseSchema.parse(await response.json());
  if (body.status !== 'success') throw new Error('Loki query failed');
  return body.data.result
    .flatMap((stream) => stream.values)
    // Nanosecond timestamps are too big for a number; padded to one width, they sort as strings.
    .sort(([a], [b]) => b.padStart(20, '0').localeCompare(a.padStart(20, '0')))
    .slice(0, query.limit)
    .map(([nanoseconds, line]) => toRawEvent(line, nanoseconds))
    .filter((event) => event !== undefined);
}
