import { z } from 'zod';

export type Access =
  | { outcome: 'allowed'; login: string }
  | { outcome: 'denied'; login: string }
  | { outcome: 'unauthenticated' };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const UserSchema = z.object({ login: z.string() });
const RepoSchema = z.object({
  permissions: z.object({ push: z.boolean(), maintain: z.boolean().optional(), admin: z.boolean() }).optional(),
});

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

// Write access (push, maintain or admin) on the repo, read with the caller's own token, so GitHub decides.
// Read access is not enough: anyone can read a public repo.
export async function checkWriteAccess(token: string, repo: string, fetcher: Fetch): Promise<Access> {
  const userResponse = await github(token, fetcher, '/user');
  if (userResponse.status === 401) return { outcome: 'unauthenticated' };
  if (!userResponse.ok) throw new Error(`GitHub /user answered ${userResponse.status}`);
  const { login } = UserSchema.parse(await userResponse.json());

  const repoResponse = await github(token, fetcher, `/repos/${repo}`);
  if (repoResponse.status === 403 || repoResponse.status === 404) return { outcome: 'denied', login };
  if (!repoResponse.ok) throw new Error(`GitHub /repos/${repo} answered ${repoResponse.status}`);
  const { permissions } = RepoSchema.parse(await repoResponse.json());
  const canWrite = Boolean(permissions && (permissions.push || permissions.maintain || permissions.admin));
  return { outcome: canWrite ? 'allowed' : 'denied', login };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CachedSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allowed'), login: z.string() }),
  z.object({ outcome: z.literal('denied'), login: z.string() }),
]);

// checkWriteAccess, remembered for 5 minutes under a hash of the token, never the token itself.
export async function cachedWriteAccess(
  token: string,
  repo: string,
  cache: KVNamespace,
  fetcher: Fetch,
): Promise<Access> {
  const key = `access:${await sha256(token)}:${repo}`;
  const cached = CachedSchema.safeParse(await cache.get(key, 'json'));
  if (cached.success) return cached.data;
  const access = await checkWriteAccess(token, repo, fetcher);
  if (access.outcome !== 'unauthenticated') {
    await cache.put(key, JSON.stringify(access), { expirationTtl: CACHE_SECONDS });
  }
  return access;
}
