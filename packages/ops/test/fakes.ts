import type { Fetch, OpsCache } from '../src/index.ts';

export function fakeCache(): OpsCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

type Route = { status: number; body?: unknown };

// A fetch that answers GitHub API paths from a table and records every call.
export function fakeGitHub(routes: Record<string, Route>) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: Fetch = async (input, init) => {
    calls.push({ url: input, authorization: new Headers(init?.headers).get('authorization') });
    const route = routes[new URL(input).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status });
  };
  return { fetcher, calls };
}

export const REPO = 'ideaSquared/creatrgrid';
export const writer = () =>
  fakeGitHub({
    '/user': { status: 200, body: { login: 'octocat' } },
    [`/repos/${REPO}`]: { status: 200, body: { permissions: { push: true, admin: false } } },
  });

export const ORG = 'ideaSquared';
export const TEAM = 'ads-ops-production';
export const membershipPath = (login: string, org = ORG, team = TEAM) =>
  `/orgs/${org}/teams/${team}/memberships/${login}`;

// A caller GitHub knows as `login`, with the given answer for their team membership.
export const teamMember = (membership: Route, login = 'octocat') =>
  fakeGitHub({
    '/user': { status: 200, body: { login } },
    [membershipPath(login)]: membership,
  });
