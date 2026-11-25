import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

// The Worker code runs in workerd, as in production, with the bindings from wrangler.jsonc backed by local Miniflare.
// The CLI, the MCP server and the packages are Node programs, so their tests stay on Node.
// Every test/ file runs in the worker project unless it is listed here, so no test file can fall outside both projects.
const nodeTestFiles = ['test/cli.test.ts', 'test/cli-process.test.ts', 'test/mcp.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'worker',
          setupFiles: ['./test/setup-worker.ts'],
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...nodeTestFiles],
        },
      },
      {
        test: {
          name: 'node',
          include: [...nodeTestFiles, 'packages/*/test/**/*.test.ts'],
        },
      },
    ],
  },
});
