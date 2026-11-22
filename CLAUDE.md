# CLAUDE.md

Agent Idea: sanitised logs for every ideaSquared product, gated by GitHub team membership, plus the shared logger
`@ideasquared/log` (`packages/log`). Read `README.md` and `packages/log/README.md` first.

## Logging

- Server code logs through `@ideasquared/log` only, never `console.*`; CI fails otherwise. `src/cli` prints to a
  terminal and is exempt. Load the `logging` skill (`.claude/skills/logging/SKILL.md`) before touching any log line.
- No personal data or secrets in logs. Log ids, not people.
- `.claude/skills/logging/SKILL.md` here is the canonical copy. Every ideaSquared repo carries the same file:
  change it here first, then copy it to the other repos.

## Working here

- TypeScript strict; no `any`; `type` over `interface`; Zod at boundaries.
- Every behaviour change ships with a test. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` before you call it done, and `pnpm build`
  when `src/cli` or `packages/log` change (their `dist/` is committed and CI checks it).
- `pnpm test` runs two Vitest projects (`vitest.config.ts`): Worker code under `src/` is tested inside workerd with
  `@cloudflare/vitest-plugin` and the real local `ACCESS_CACHE` binding; the CLI, the MCP server and `packages/` stay on
  Node. Put a new test file in the project that matches the code it imports.
- The sanitiser (`src/sanitise.ts`) fails closed: anything not on an allowlist is dropped or replaced. Add a line to
  the PII test lines in `test/sanitise.test.ts` for every new kind of leak.
- Conventional commits, checked by commitlint on `commit-msg`. After changing `wrangler.jsonc` run `pnpm cf-typegen` and commit `worker-configuration.d.ts`.
