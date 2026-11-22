import { env } from 'cloudflare:workers';

// The real ACCESS_CACHE binding from wrangler.jsonc, backed by local Miniflare storage (emptied before each test by
// setup-worker.ts).
export const accessCache = (): KVNamespace => env.ACCESS_CACHE;

export async function cachedKeys(kv: KVNamespace): Promise<string[]> {
  return (await kv.list()).keys.map((key) => key.name);
}
