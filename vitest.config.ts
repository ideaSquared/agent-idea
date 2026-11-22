import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker code runs in workerd, as in production, with the bindings from wrangler.jsonc backed by local Miniflare.
// The CLI, the MCP server and the packages are Node programs, so their tests stay on Node.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'worker',
          setupFiles: ['./test/setup-worker.ts'],
          include: [
            'test/access.test.ts',
            'test/github-actions.test.ts',
            'test/glitchtip.test.ts',
            'test/loki.test.ts',
            'test/sanitise.test.ts',
            'test/worker.test.ts',
            'test/workers-logs.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'node',
          include: ['test/cli.test.ts', 'test/cli-process.test.ts', 'test/mcp.test.ts', 'packages/*/test/**/*.test.ts'],
        },
      },
    ],
  },
});
