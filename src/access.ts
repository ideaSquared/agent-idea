import { z } from 'zod';

export type Access =
  | { outcome: 'allowed'; login: string }
  | { outcome: 'denied'; login: string }
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

// Membership of a GitHub team, read with the caller's own token, so GitHub decides. Only an active membership
// allows: a pending invitation is denied. A 404 means not a member (GitHub also answers 404 when the token cannot
// see the org's teams, which is a denial too). Any other unexpected status throws, and the handler answers 500.
export async function checkTeamMembership(token: string, { org, team }: TeamRef, fetcher: Fetch): Promise<Access> {
  if (!SLUG.test(org)) throw new Error('org must be a GitHub org slug');
  if (!SLUG.test(team)) throw new Error('team must be a GitHub team slug');
  const userResponse = await github(token, fetcher, '/user');
  if (userResponse.status === 401) return { outcome: 'unauthenticated' };
  if (!userResponse.ok) throw new Error(`GitHub /user answered ${userResponse.status}`);
  const { login } = UserSchema.parse(await userResponse.json());

  const path = `/orgs/${org}/teams/${team}/memberships/${encodeURIComponent(login)}`;
  const response = await github(token, fetcher, path);
  if (response.status === 401) return { outcome: 'unauthenticated' };
  if (response.status === 404) return { outcome: 'denied', login };
  if (!response.ok) throw new Error(`GitHub team membership answered ${response.status}`);
  const { state } = MembershipSchema.parse(await response.json());
  return { outcome: state === 'active' ? 'allowed' : 'denied', login };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CachedSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allowed'), login: z.string() }),
  z.object({ outcome: z.literal('denied'), login: z.string() }),
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
