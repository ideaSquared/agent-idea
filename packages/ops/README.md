# @ideasquared/ops

One ops contract every ideaSquared product can expose, and one client that drives any of them, in the spirit of
Monzo's ops tooling: browse a product's commands, run reads, preview writes (a dry run), then confirm. The `eng` CLI
is the client. [creatrgrid](https://github.com/ideaSquared/creatrgrid) is the first product, then pairflix;
adopt-dont-shop keeps its own richer `service.ops` for now.

```bash
pnpm add https://github.com/ideaSquared/agent-idea/releases/download/ops-v0.1.1/ideasquared-ops-0.1.1.tgz
```

Each release is a tarball on a GitHub Release, and the lockfile pins it with an integrity hash. Don't install from a
git URL or `github:` spec (see [`@ideasquared/log`](../log/README.md) for why).

To release a new version: bump `version` in `packages/ops/package.json`, run `pnpm build`, and merge. On `main`, the
`Release @ideasquared/ops` workflow tests, packs and publishes `ops-v<version>` if that release doesn't exist yet.
CI fails if `packages/ops/dist` differs from `src`, so commit the build.

The server helper uses only Web `Request`/`Response`, `fetch` and `crypto.subtle`: no Node APIs and no framework. The
one dependency is `zod`.

## Contract v1

`OPS_CONTRACT_VERSION = 1`. Every schema is exported (`CatalogSchema`, `CommandSchema`, `FieldSchema`,
`InvokeRequestSchema`, `InvokeResponseSchema`, `ErrorResponseSchema`) with its inferred type.

Every request carries `Authorization: Bearer <GitHub token>`, the caller's `gh auth token`.

| Route | |
| --- | --- |
| `GET <base>/catalog` | `{ version: 1, product, environment, commands: Command[] }` |
| `POST <base>/invoke` | body `{ command, args, mode: 'run' \| 'preview' }`, answers `{ command, mode, result, summary? }` |

- **Command**: `{ id: "group.name", group, name, summary, kind: 'read' | 'write', fields: Field[], dryRun }`. `group`
  and `name` are lowercase words (`a-z`, digits, `-`). `dryRun` says a write supports preview.
- **Field**: `{ name, type: 'string' | 'number' | 'boolean' | 'enum' | 'id', required, description, values?, positional? }`.
  `values` lists an enum's choices. `positional` fields are filled from bare CLI words, in declared order. A field
  cannot be called `json`. An `id` is 1 to 128 characters with no spaces.
- **Reads ignore preview.** A read asked to preview runs, and the response says `mode: 'run'`: `mode` is what was done.
- **Writes**: `run` is allowed without a preview (the client is responsible for previewing first). A write with
  `dryRun: true` must implement `preview`. A preview request for a write that has none is refused with
  `invalid_argument`; it is never run instead.
- **Args are validated server-side** against the command's fields before the handler runs: type, required, enum
  values, and no unknown fields. No coercion (a number field takes a JSON number). Messages name the field, never the
  value.

Errors are `{ error: { code, message } }`:

| Code | HTTP | When |
| --- | --- | --- |
| `unauthenticated` | 401 | no token, or GitHub rejected it |
| `forbidden` | 403 | the token has no write access (push, maintain or admin) to the product's repo |
| `not_found` | 404 | unknown command (also unknown route or method) |
| `invalid_argument` | 400 | bad body, bad args, or preview of a write that cannot |
| `internal` | 500 | anything else, including GitHub failing. The message is generic. |

Throw `OpsError(code, message)` from a handler to answer with a specific code. Any other thrown error becomes
`internal` with the message `internal error`.

## Mounting it in Hono

```ts
import { createOpsHandler } from '@ideasquared/ops';
import { createLogger } from '@ideasquared/log';

const log = createLogger({ service: 'creatrgrid-ops', fields: ['command', 'mode', 'outcome', 'durationMs'] });

const handler = createOpsHandler({
  product: 'creatrgrid',
  repo: 'ideaSquared/creatrgrid',
  environment: 'production',
  cache: env.ACCESS_CACHE, // optional: a KV namespace, or anything with get and put
  logger: log, // optional
  commands: [
    {
      id: 'accounts.resync', group: 'accounts', name: 'resync', kind: 'write', dryRun: true,
      summary: 'Re-import an account’s posts',
      fields: [{ name: 'accountId', type: 'id', required: true, positional: true, description: 'The account' }],
      preview: async ({ accountId }) => ({ result: { accountId, wouldQueue: 1 }, summary: 'would queue 1 task' }),
      run: async ({ accountId }, ctx) => ({ result: { accountId, queued: 1 } }),
    },
  ],
});

app.all('/ops/*', (c) => handler(c.req.raw, '/ops'));
```

`createOpsHandler` throws at startup for a malformed command, a duplicate id, `dryRun` without `preview`, or `preview`
without `dryRun`. `run` and `preview` get the validated `args` and a context `{ login }` (the caller's GitHub login).
They return `{ result, summary? }`. The `fetch` option replaces the global `fetch` used to reach GitHub (for tests).

## How eng uses it

```ts
import { fetchCatalog, invoke, parseArgs } from '@ideasquared/ops';

const catalog = await fetchCatalog(baseUrl, token);            // browse
const command = catalog.commands.find((c) => c.id === 'accounts.resync');
const args = parseArgs(command, ['acct_1']);                   // rejects bad input before any call
const preview = await invoke(baseUrl, token, { command: command.id, args, mode: 'preview' });
// show preview.summary / preview.result, ask for confirmation, then:
await invoke(baseUrl, token, { command: command.id, args, mode: 'run' });
```

`fetchCatalog` and `invoke` validate responses with the schemas and throw `OpsError` (with the server's `code`) on the
error shape, or code `internal` for a response that is not contract v1. `parseArgs(command, argv)` accepts
`--field value`, `--field=value`, `--flag` (a boolean, true; `--flag=false` for false), bare words for positional
fields, `--json '{...}'` (options override it) and `--` to end options, then applies the same `validateArgs` the
server does.

## Safety notes

- **Access is decided by GitHub**, with the caller's own token, on every request (cached 5 minutes under a SHA-256 of
  the token, never the token). Read access is not enough: anyone can read a public repo. If the cache fails, GitHub is
  asked.
- **Return ids and counts, not personal data.** A result is sent to the caller as it is: put no emails, names, tokens
  or message text in `result`, `summary` or an `OpsError` message.
- **Logging follows the [logging skill](../../.claude/skills/logging/SKILL.md).** One line per invoke: command id (only
  for a known command), mode, outcome and duration, with fixed messages. Never the token, the GitHub login, args or
  results. An unexpected failure is logged at error level with only the error's type: its message and stack can
  carry personal data, args or tokens, so they never reach the log. A logger that throws never changes the response,
  so a write that ran is still reported as ran and the caller has no reason to retry it.
- Writes should be previewable (`dryRun`) wherever a mistake is costly; clients preview before they run.
