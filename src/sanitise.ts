import { z } from 'zod';
import type { RouteRules } from './route-words.ts';

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

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replace: (match: string) => Promise<string>,
): Promise<string> {
  const matches = [...text.matchAll(pattern)].map((match) => match[0]);
  const replacements = await Promise.all(matches.map(replace));
  let index = 0;
  return text.replace(pattern, () => replacements[index++] ?? '');
}

const VERSION = /^v\d{1,2}$/;

// The route as a template: no host or query string. A segment is kept only if it is a version (v1) or one
// of the project's route words and does not follow a word that takes an id; everything else becomes :param.
// Parameter syntax (:id, {id}) in the input is not trusted, because sources hand over raw paths.
export function templateRoute(route: string, rules: RouteRules): string {
  const path = route.replace(/^\w+:\/\/[^/]+/, '').split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const templated = segments.map((segment, index) => {
    const previous = segments[index - 1]?.toLowerCase();
    if (previous !== undefined && rules.dynamicAfter.has(previous)) return ':param';
    return VERSION.test(segment) || rules.words.has(segment.toLowerCase()) ? segment : ':param';
  });
  return `/${templated.join('/')}`;
}

// URLs keep their scheme and host; the path is templated and any query string is replaced.
function templateUrl(url: string, rules: RouteRules): string {
  const match = /^(\w+:\/\/[^\s/?#"']+)([^\s?#"']*)([?#][^\s"']*)?$/.exec(url);
  if (!match) return '[url]';
  const [, origin = '', path = '', query] = match;
  return `${origin}${path ? templateRoute(path, rules) : ''}${query ? '?[query]' : ''}`;
}

// Fixed replacements, applied in order. Secrets first, so a token is never half-matched as something else.
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  // The whole Authorization value whatever the scheme (Digest has several parameters): an escape-aware quoted
  // string when serialised, otherwise to the end of the line. A Cookie header is redacted to the end of the line.
  [/\bauthorization(["']?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\r\n]*)/gi, 'authorization$1[redacted]'],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [token]'],
  [/\bcookie(["']?\s*:\s*)[^\r\n]*/gi, 'cookie$1[redacted]'],
  [
    /\b(sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|whsec_|sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|pk_test_)[\w-]{8,}/g,
    '[key]',
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[key]'],
  // Any key whose name contains one of these words, so STRIPE_SECRET_KEY=, refresh_token=, csrfToken: and
  // "refreshToken":"…" are caught too. A quoted value is redacted whole, spaces included.
  [
    /\b([\w-]*(?:key|secret|token|password|passwd|pwd|credential|private|cookie|session)[\w-]*)(["']?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|["']?[^\s"',;&]+)/gi,
    '$1$2[redacted]',
  ],
  // Any userinfo in a URL: user:pass@, :pass@ (Redis) and a bare key@ (a Sentry or GlitchTip DSN).
  [/(\w+:\/\/)[^\s/?#@]+@/g, '$1[creds]@'],
  // Unicode local parts and domains; the @ may be URL-encoded as %40.
  [/[\p{L}\p{M}\p{N}_.+-]+(?:@|%40)[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)+/gu, '[email]'],
];

const LATE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b/gi, '[ip]'],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
  [/(?:\+44\s?|\b0)(?:[\s-]?\d){9,10}\b/g, '[phone]'],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[postcode]'],
  [/\b\d{6,}\b/g, '[number]'],
];

// Free text with secrets and personal data removed. UUIDs, hex ids and Steam IDs become stable tags, so one
// user can be followed through the logs without being identified.
export async function scrubText(text: string, key: string, rules: RouteRules): Promise<string> {
  const redacted = REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
    .replace(/\b\w+:\/\/[^\s"'<>]+/g, (url) => templateUrl(url, rules))
    .replace(
      /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'<>]*)/g,
      (_, method: string, path: string) => `${method} ${templateRoute(path, rules)}`,
    )
    .replace(/(\/[^\s"'<>?#]*)\?[^\s"'<>]+/g, '$1?[query]');
  const withIds = await replaceAsync(
    redacted,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    (uuid) => tag('id', uuid, key),
  );
  // Prefixed ids such as acct_f02ea3fd… keep their prefix; bare 32-hex ids become id_….
  const withPrefixed = await replaceAsync(withIds, /\b[a-z]{2,10}_[0-9a-f]{16,}\b/gi, (id) => {
    const [prefix = 'id'] = id.split('_');
    return tag(prefix.toLowerCase(), id, key);
  });
  const withHex = await replaceAsync(withPrefixed, /\b[0-9a-f]{32}\b/gi, (id) => tag('id', id, key));
  const withSteam = await replaceAsync(withHex, /\b7656119\d{10}\b/g, (steamId) => tag('steam', steamId, key));
  return LATE_REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), withSteam);
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
export async function sanitiseEvent(raw: unknown, key: string, rules: RouteRules): Promise<SanitisedEvent> {
  const event = RawEventSchema.parse(raw);
  const timestamp = new Date(event.timestamp);
  if (Number.isNaN(timestamp.getTime())) throw new Error('event has no valid timestamp');
  const message = (await scrubText(event.message ?? '', key, rules)).slice(0, MAX_MESSAGE);
  return {
    timestamp: timestamp.toISOString(),
    level: level(event.level),
    message,
    ...(event.service && /^[a-z0-9-]{1,40}$/.test(event.service) ? { service: event.service } : {}),
    ...(event.route ? { route: templateRoute(event.route, rules) } : {}),
    ...(event.status !== undefined && event.status >= 100 && event.status <= 599 ? { status: event.status } : {}),
    ...(event.durationMs !== undefined ? { durationMs: Math.round(event.durationMs) } : {}),
    ...(event.errorType
      ? { errorType: /^[A-Z][A-Za-z]{0,40}$/.test(event.errorType) ? event.errorType : 'Error' }
      : {}),
    ...(event.stack ? { stack: stackFrames(event.stack) } : {}),
  };
}
