import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

// Every test starts with an empty access cache, as if it were the first request.
beforeEach(async () => {
  const { keys } = await env.ACCESS_CACHE.list();
  await Promise.all(keys.map((key) => env.ACCESS_CACHE.delete(key.name)));
});
