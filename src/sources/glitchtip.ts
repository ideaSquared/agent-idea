import { z } from 'zod';
import { accessHeaders, type AccessToken } from './cf-access.ts';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type GlitchTipConfig = AccessToken & { url: string; org: string; project: string; token: string };

// An unresolved issue, reduced to what helps debugging. No permalink, user count, metadata, tags or event bodies.
// The title and culprit are free text and are not yet scrubbed.
export type IssueSummary = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  level: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
};

const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;
// GlitchTip pages issues 50 at a time by default; ask for the busiest first and keep the first page.
const PAGE = 100;
export const MAX_TEXT = 300;
const MAX_FRAMES = 10;

const IssueSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
  shortId: z.string().nullish(),
  title: z.string().nullish(),
  culprit: z.string().nullish(),
  count: z.union([z.string(), z.number()]).nullish(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  level: z.string().nullish(),
});

const FrameSchema = z.object({
  filename: z.string().nullish(),
  absPath: z.string().nullish(),
  lineNo: z.number().int().nullish(),
  inApp: z.boolean().nullish(),
});

const EventSchema = z.object({
  entries: z
    .array(
      z.object({
        type: z.string(),
        data: z.unknown(),
      }),
    )
    .default([]),
});

const ExceptionSchema = z.object({
  values: z.array(z.object({ stacktrace: z.object({ frames: z.array(FrameSchema).default([]) }).nullish() })).default([]),
});

function glitchTip(config: GlitchTipConfig, fetcher: Fetch, path: string): Promise<Response> {
  // Access answers a bad service token with a redirect to its login page, so redirects are not followed.
  return fetcher(`${config.url.replace(/\/+$/, '')}${path}`, {
    headers: { ...accessHeaders(config), authorization: `Bearer ${config.token}`, accept: 'application/json' },
    redirect: 'manual',
  });
}

async function getJson(config: GlitchTipConfig, fetcher: Fetch, path: string): Promise<unknown> {
  const response = await glitchTip(config, fetcher, path);
  if (!response.ok) throw new Error(`GlitchTip answered ${response.status}`);
  return response.json();
}

function isoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function count(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The project's unresolved issues, most frequent first. Issues that do not parse are dropped.
export async function listIssues(config: GlitchTipConfig, limit: number, fetcher: Fetch): Promise<IssueSummary[]> {
  const query = new URLSearchParams({ query: 'is:unresolved', sort: '-count', limit: String(PAGE) });
  const path = `/api/0/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(config.project)}/issues/?${query}`;
  const body = z.array(z.unknown()).parse(await getJson(config, fetcher, path));
  return body
    .map((item) => IssueSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .map((issue) => ({
      id: issue.id,
      shortId: issue.shortId && /^[A-Za-z0-9-]{1,40}$/.test(issue.shortId) ? issue.shortId : issue.id,
      // Kept whole: clipping before the scrubber could cut a secret in half and stop it being recognised.
      title: issue.title ?? '',
      culprit: issue.culprit ?? '',
      count: count(issue.count),
      firstSeen: isoDate(issue.firstSeen),
      lastSeen: isoDate(issue.lastSeen),
      level: LEVELS.find((level) => level === issue.level?.toLowerCase()) ?? 'error',
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// A frame's file cut to the path after src/ (or the bare file name), so a home directory never leaves.
function frame(file: string, line: number): string | undefined {
  const path = file.split(/[?#]/)[0] ?? '';
  const short = /(?:^|\/)(src\/.*)$/.exec(path)?.[1] ?? path.split(/[/\\]/).pop() ?? '';
  const text = `${short}:${line}`;
  return /^[\w./@-]{1,200}:\d+$/.test(text) ? text : undefined;
}

// The latest event's stack frames as file:line, innermost first: the in-app frames when there are any, else all.
// Nothing else of the event is read: no exception value, request, user, tags, breadcrumbs, context lines or vars.
export async function latestFrames(config: GlitchTipConfig, issueId: string, fetcher: Fetch): Promise<string[]> {
  const body = EventSchema.parse(await getJson(config, fetcher, `/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`));
  const frames = body.entries
    .filter((entry) => entry.type === 'exception')
    .flatMap((entry) => {
      const parsed = ExceptionSchema.safeParse(entry.data);
      return parsed.success ? parsed.data.values.flatMap((value) => value.stacktrace?.frames ?? []) : [];
    });
  const inApp = frames.filter((candidate) => candidate.inApp);
  return [...(inApp.length > 0 ? inApp : frames)]
    .reverse()
    .flatMap((candidate) => {
      const file = candidate.filename ?? candidate.absPath;
      if (!file || candidate.lineNo === null || candidate.lineNo === undefined) return [];
      const text = frame(file, candidate.lineNo);
      return text ? [text] : [];
    })
    .slice(0, MAX_FRAMES);
}
