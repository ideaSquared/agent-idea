import { z } from 'zod';

// A log event as a source adapter hands it over. Only these fields are read: anything else on the
// object (bodies, headers, cookies, IPs, user agents, query strings) is dropped by the schema.
const RawEventSchema = z.object({
  timestamp: z.union([z.string(), z.number()]),
  level: z.string().optional(),
  service: z.string().optional(),
  route: z.string().optional(),
  status: z.number().int().optional(),
  durationMs: z.number().optional(),
  errorType: z.string().optional(),
  message: z.string().optional(),
  stack: z.string().optional(),
});

export type SanitisedEvent = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  errorType?: string;
  message: string;
  stack?: string[];
};

const MAX_MESSAGE = 500;
const MAX_FRAMES = 10;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

async function tag(prefix: string, value: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value.toLowerCase()));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 8)}`;
}

async function replaceAsync(text: string, pattern: RegExp, replace: (match: string) => Promise<string>): Promise<string> {
  const matches = [...text.matchAll(pattern)].map((match) => match[0]);
  const replacements = await Promise.all(matches.map(replace));
  let index = 0;
  return text.replace(pattern, () => replacements[index++] ?? '');
}

// Fixed replacements, applied in order. Secrets first, so a token is never half-matched as something else.
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [token]'],
  [/\b(sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|whsec_|rk_live_|pk_live_)[\w-]{8,}/g, '[key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[key]'],
  [/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|cookie|session)(["']?\s*[=:]\s*)["']?[^\s"',;&]+/gi, '$1$2[redacted]'],
  [/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[creds]@'],
  [/(\w+:\/\/[^\s?#]+)[?#][^\s"']*/g, '$1?[query]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
];

const LATE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b/gi, '[ip]'],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
  [/(?:\+44\s?|\b0)(?:[\s-]?\d){9,10}\b/g, '[phone]'],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[postcode]'],
  [/\b\d{6,}\b/g, '[number]'],
];

// Free text with secrets and personal data removed. UUIDs and Steam IDs become stable tags, so one
// user can be followed through the logs without being identified.
export async function scrubText(text: string, key: string): Promise<string> {
  const redacted = REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
  const withIds = await replaceAsync(
    redacted,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    (uuid) => tag('id', uuid, key),
  );
  const withSteam = await replaceAsync(withIds, /\b7656119\d{10}\b/g, (steamId) => tag('steam', steamId, key));
  return LATE_REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), withSteam);
}

const ROUTE_WORD = /^[a-z]+(?:[-_][a-z]+)*$/;
const ROUTE_PARAM = /^(?::\w+|\{\w+\}|\*|v\d{1,2})$/;

// The route as a template: no query string, and every segment that is not a plain word, a version (v1) or an
// existing parameter (ids, numbers, emails, anything mixed) becomes :param.
function templateRoute(route: string): string {
  const path = route.replace(/^\w+:\/\/[^/]+/, '').split(/[?#]/)[0] ?? '';
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => (ROUTE_PARAM.test(segment) || (ROUTE_WORD.test(segment) && segment.length <= 24) ? segment : ':param'));
  return `/${segments.join('/')}`;
}

function shortPath(file: string): string {
  const path = file.split(/[?#]/)[0] ?? '';
  const fromSrc = /(?:^|\/)(src\/.*)$/.exec(path);
  return fromSrc?.[1] ?? path.split(/[/\\]/).pop() ?? '';
}

// Stack frames as file:line only, with the path cut to after src/ (or the file name). Frames that
// do not look like frames are dropped.
function stackFrames(stack: string): string[] {
  return stack
    .split('\n')
    .map((line) => /\(?([^\s()]+?):(\d+)(?::\d+)?\)?\s*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, file = '', line]) => `${shortPath(file)}:${line}`)
    .slice(0, MAX_FRAMES);
}

function level(value: string | undefined): SanitisedEvent['level'] {
  const lower = value?.toLowerCase();
  if (lower === 'warning') return 'warn';
  if (lower === 'fatal' || lower === 'critical') return 'error';
  return LEVELS.find((candidate) => candidate === lower) ?? 'info';
}

// The only shape that leaves the Worker. Throws on input with no usable timestamp, so a malformed
// event is dropped rather than passed through.
export async function sanitiseEvent(raw: unknown, key: string): Promise<SanitisedEvent> {
  const event = RawEventSchema.parse(raw);
  const timestamp = new Date(event.timestamp);
  if (Number.isNaN(timestamp.getTime())) throw new Error('event has no valid timestamp');
  const message = (await scrubText(event.message ?? '', key)).slice(0, MAX_MESSAGE);
  return {
    timestamp: timestamp.toISOString(),
    level: level(event.level),
    message,
    ...(event.service && /^[a-z0-9-]{1,40}$/.test(event.service) ? { service: event.service } : {}),
    ...(event.route ? { route: templateRoute(event.route) } : {}),
    ...(event.status !== undefined && event.status >= 100 && event.status <= 599 ? { status: event.status } : {}),
    ...(event.durationMs !== undefined ? { durationMs: Math.round(event.durationMs) } : {}),
    ...(event.errorType ? { errorType: /^[A-Z][A-Za-z]{0,40}$/.test(event.errorType) ? event.errorType : 'Error' } : {}),
    ...(event.stack ? { stack: stackFrames(event.stack) } : {}),
  };
}
