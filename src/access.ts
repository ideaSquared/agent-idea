import { z } from 'zod';

// tokenExpiresAt is when the caller's GitHub token expires (ISO 8601), when GitHub says it does.
export type Access =
  | { outcome: 'allowed'; login: string; tokenExpiresAt?: string }
  | { outcome: 'denied'; login: string; tokenExpiresAt?: string }
  | { outcome: 'unauthenticated' };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const UserSchema = z.object({ login: z.string() });
const MembershipSchema = z.object({ state: z.string() });
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const CACHE_SECONDS = 300;

function github(token: string, fetcher: Fetch, path: string): Promise<Response> {
  return fetcher(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-idea',
      'x-github-api-version': '2022-11-28',
    },
  });
}

export type TeamRef = { org: string; team: string };

// GitHub also answers 403 for its primary (quota spent) and secondary rate limits. Those are temporary, so they must
// never become a cached denial. A secondary limit may only say so in retry-after or the error message.
async function rateLimited(response: Response): Promise<boolean> {
  if (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) return true;
  return /rate limit/i.test(await response.text());
}

const EXPIRATION = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/;

// GitHub's github-authentication-token-expiration header ("2027-11-21 13:20:00 UTC" or "... +0100") as ISO 8601.
// undefined when the header is missing (a token with no expiry) or not in a form we recognise.
export function tokenExpiry(header: string | null): string | undefined {
  const match = EXPIRATION.exec(header ?? '');
  if (!match) return undefined;
  const [, date, time, zone = 'UTC'] = match;
  const offset = zone === 'UTC' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(`${date}T${time}${offset}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// Membership of a GitHub team, read with the caller's own token, so GitHub decides. Only an active membership
// allows: a pending invitation is denied. A 404 means not a member (GitHub also answers 404 when the token cannot
// see the org's teams, which is a denial too). A 403 that is not a rate limit is a token GitHub will not let read
// the team (SAML SSO not authorised for it, or a fine-grained token without Members: read): also a denial. Any other
// unexpected status throws, and the handler answers 500.
export async function checkTeamMembership(token: string, { org, team }: TeamRef, fetcher: Fetch): Promise<Access> {
  if (!SLUG.test(org)) throw new Error('org must be a GitHub org slug');
  if (!SLUG.test(team)) throw new Error('team must be a GitHub team slug');
  const userResponse = await github(token, fetcher, '/user');
  if (userResponse.status === 401) return { outcome: 'unauthenticated' };
  if (!userResponse.ok) throw new Error(`GitHub /user answered ${userResponse.status}`);
  const { login } = UserSchema.parse(await userResponse.json());
  const tokenExpiresAt = tokenExpiry(userResponse.headers.get('github-authentication-token-expiration'));
  const expiry = tokenExpiresAt ? { tokenExpiresAt } : {};

  const path = `/orgs/${org}/teams/${team}/memberships/${encodeURIComponent(login)}`;
  const response = await github(token, fetcher, path);
  if (response.status === 401) return { outcome: 'unauthenticated' };
  if (response.status === 404) return { outcome: 'denied', login, ...expiry };
  if (response.status === 403 && !(await rateLimited(response))) {
    return { outcome: 'denied', login, ...expiry };
  }
  if (!response.ok) throw new Error(`GitHub team membership answered ${response.status}`);
  const { state } = MembershipSchema.parse(await response.json());
  return { outcome: state === 'active' ? 'allowed' : 'denied', login, ...expiry };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CachedSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allowed'), login: z.string(), tokenExpiresAt: z.string().optional() }),
  z.object({ outcome: z.literal('denied'), login: z.string(), tokenExpiresAt: z.string().optional() }),
]);

// checkTeamMembership, remembered for 5 minutes under a hash of the token, never the token itself. The `team:` key
// prefix is new on purpose: entries written under the old repo-keyed `access:` prefix are never read.
export async function cachedTeamMembership(
  token: string,
  ref: TeamRef,
  cache: KVNamespace,
  fetcher: Fetch,
): Promise<Access> {
  const key = `team-access:${await sha256(token)}:${ref.org}/${ref.team}`;
  const cached = CachedSchema.safeParse(await cache.get(key, 'json'));
  if (cached.success) return cached.data;
  const access = await checkTeamMembership(token, ref, fetcher);
  if (access.outcome !== 'unauthenticated') {
    await cache.put(key, JSON.stringify(access), { expirationTtl: CACHE_SECONDS });
  }
  return access;
}
