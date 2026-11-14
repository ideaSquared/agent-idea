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
