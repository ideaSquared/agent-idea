# Agent Idea

Sanitised logs for every ideaSquared product, for people and for LLMs. Nothing personal leaves it, and you only
see a product's logs if your GitHub login has **write access** to its repo.

```
idea CLI ──(your gh token)──▶ Agent Idea API (Cloudflare Worker)
                                 1. ask GitHub, with your token, whether you can write to the repo
                                 2. fetch logs (Cloudflare Workers Logs, Loki, GlitchTip, GitHub Actions)
                                 3. sanitise: allowlist fields, scrub text, tag ids
                                 4. return only sanitised data
```

Status: phase 4 of 6. Cloudflare Workers Logs, GitHub Actions runs, adopt-dont-shop's Loki and GlitchTip (staging),
and the `idea` CLI are in.

## The idea command

```bash
pnpm add -g github:ideaSquared/agent-idea     # install or update
```

```bash
idea logs creatrgrid                          # the last hour, oldest first
idea logs creatrgrid --level error --since 24 # errors in the last 24 hours
idea logs pairflix --search youtube           # events mentioning youtube
idea logs gaminginit-bot --json               # JSON, for piping into other tools or an LLM
idea runs pairflix --failed                   # recent failed GitHub Actions runs, with their ids
idea run pairflix 43639019850                 # that run's jobs, and the sanitised log of each failed job
idea logs ads --level error                   # adopt-dont-shop staging, from Loki
idea errors ads --frames                      # adopt-dont-shop's top unresolved errors, with stack frames
idea access ads                               # check you have write access
```

- `--since` is in hours, up to 168 (Workers Logs keeps 7 days). `--limit` is up to 200, default 50.
- `--search` matches the **sanitised** events only (message, route, service, error type), among the newest ~1,000 in
  the window. It never searches raw logs, so it can't reveal whether hidden data (a slug, an email) is in them.
- It signs in with `GH_TOKEN`, `GITHUB_TOKEN` or your `gh` login, and talks to `AGENT_IDEA_URL`
  (default `https://agent-idea.idea-squared.workers.dev`).

## Access

- Every request carries a GitHub token: `Authorization: Bearer <token>`. The CLI will read it from `gh auth token`.
- The Worker calls GitHub's `/user` and `/repos/{owner}/{repo}` **with that token** and allows the request only if
  `permissions` has `push`, `maintain` or `admin`. Read access is not enough, because anyone can read a public repo.
- The answer is cached in KV for 5 minutes under a SHA-256 of the token. The token itself is never stored or logged.
- Every request logs one audit line: GitHub login, project, route and outcome. Never the results.

Products, their repos and their Worker scripts are in [`src/projects.ts`](src/projects.ts).

## Sanitising

Every log event goes through [`sanitiseEvent`](src/sanitise.ts) before it leaves the Worker.

1. **Allowlist.** Only these fields are returned: `timestamp`, `level`, `service`, `route`, `status`, `durationMs`,
   `errorType`, `message`, `stack`. Anything else on the event (bodies, headers, cookies, IPs, user agents, query
   strings) is dropped. The same goes for the source formats: each source reads only the fields listed under
   [Log sources](#log-sources).
2. **Scrub** the message: JWTs, bearer tokens, API keys (Anthropic, GitHub, Slack, Stripe, AWS), `password=`-style
   pairs (any key ending in `token`, `secret`, `password`, `cookie`, `session` or `api_key`, so `refresh_token=` and
   `"csrfToken":` too), any userinfo in a URL (`user:pass@`, `:pass@`, a DSN's `key@`), query strings in URLs, emails, IPv4 and IPv6, UK phone numbers and postcodes, card numbers,
   and long numbers (Discord ids and the like).
3. **Tag** ids so one user can be followed without being identified: UUIDs and 32-hex ids become `id_xxxxxxxx`,
   prefixed ids such as `acct_…` become `acct_xxxxxxxx` (either case), and Steam IDs `steam_xxxxxxxx`. Each is an HMAC under the
   `PSEUDONYM_KEY` secret. Without that secret the Worker serves nothing.
4. **Routes and URLs.** Routes, URLs and `GET /path`-style text in messages lose their query string. A path segment
   is kept only if it is a version (`v1`) or one of **that project's** words in
   [`src/route-words.ts`](src/route-words.ts), and it does not follow a word that takes an id (`creators`, `users`,
   `pets` and so on). Everything else becomes `:param`, so `/creators/alex` and `/creators/discord` both come out as
   `/creators/:param`. Parameter syntax in a raw path (`:id`, `{id}`) is not trusted. If a real route shows up as
   `:param` and you want to see it, add the word there. Stack traces keep only `file:line`, cut to the path after
   `src/`.

[`test/sanitise.test.ts`](test/sanitise.test.ts) holds log lines full of personal data and secrets. CI fails if any
of it survives. Add a line there whenever a new kind of leak is found.

**Limits.** Regexes cannot recognise a name in free text ("player Bob joined"). That is what
[`@ideasquared/log`](packages/log/README.md) is for: products log a fixed message and declared fields, so names and
emails are never written in the first place. The sanitiser is the safety net, not the only defence.

## Log sources

| Source | Projects | How |
| --- | --- | --- |
| Cloudflare Workers Logs | creatrgrid, gaminginit, gaminginit-bot, ideasquared-bot, pairflix | Workers Observability telemetry query API, filtered to the project's Worker scripts. Only the timestamp, level, service, path, status, wall time and message are read; Cloudflare's client IP, location, headers and TLS details are never touched. |
| Loki | ads | adopt-dont-shop staging's Loki, reached through a Cloudflare Tunnel behind Cloudflare Access (see [Phase 4](#phase-4-adopt-dont-shop)). A LogQL `query_range` selects by the `service` and `level` labels only, with no line filter. From each `@ideasquared/log` JSON line only the timestamp, level, service, message, `meta.route`, `meta.status`, `meta.durationMs`, the error type and the stack's `at` lines are read; other meta fields and the error message are never touched. |
| GlitchTip | ads | adopt-dont-shop's GlitchTip (Sentry API), through the same tunnel. The project's unresolved issues: short id, scrubbed title and culprit, count, first and last seen, level. Optionally the latest event's stack frames as `file:line`. Never the permalink, event bodies, exception values, request data, user, tags, breadcrumbs or source context. |
| GitHub Actions | all | GitHub's API, called with **your own** token (the one that passed the write-access check), so no extra secret. Runs list the workflow, event, result, short commit and time; the branch only when it is the default branch, and never the commit message, PR title or who triggered it. A run's failed jobs come with the last lines of their log (80 by default, `--tail` up to 300), each line sanitised like any log message. |

## Phase 4: adopt-dont-shop

adopt-dont-shop runs on its own server, not on Workers, so its logs are in Loki and its errors in GlitchTip. Both
sit on the staging server behind a Cloudflare Tunnel, and Cloudflare Access lets through only Agent Idea's service
token: the Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request, plus a read-only
GlitchTip API token for GlitchTip.

- `idea logs ads` takes the same options as for any project, and the events come back in the same sanitised shape.
  `--search` matches sanitised events only, among the newest ~1,000 in the window.
- `idea errors ads [--limit n] [--frames] [--json]` lists the busiest unresolved issues. Titles and culprits are
  scrubbed like log messages; frames are `file:line`, cut to the path after `src/`, in-app frames first.
- Unconfigured is a valid state: until the tunnel, Access and secrets are set up, both answer `501` with
  "ADS logs are not configured" or "ADS errors are not configured".

Setting it up (cloudflared on the server, the tunnel's hostnames, the Access application and service token, the
GlitchTip token, and the Worker's secrets and vars) is in [docs/ads-tunnel.md](docs/ads-tunnel.md).

## API

| Route | What |
| --- | --- |
| `GET /health` | `{ "ok": true }`, no token needed |
| `GET /v1/access/:project` | `200` with your login if you can write to the project's repo; `401` with no or a bad token, `403` without write access, `404` for an unknown project |
| `GET /v1/logs/:project` | `{ "events": [...], "scanned": n }`, sanitised, newest first. Query: `since` (hours, default 1, max 168), `level`, `search` (matched against sanitised events), `limit` (default 50, max 200). Same `401`/`403`/`404`, plus `400` for a bad query |
| `GET /v1/errors/:project` | `{ "issues": [...] }`, the busiest unresolved errors first. Query: `limit` (default 10, max 25), `frames=true` for each issue's latest stack frames. `404` for a project with no error tracker (only `ads` has one), `501` while GlitchTip is not configured, `502` if it can't be reached |
| `GET /v1/runs/:project` | `{ "runs": [...] }`, newest first. Query: `limit` (default 10, max 50), `failed=true` |
| `GET /v1/runs/:project/:runId` | `{ "jobs": [...] }`: each job's result and failed steps, plus a sanitised `log` tail for failed jobs. Query: `tail` (default 80, max 300) |

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build        # the CLI, into dist/ (committed, so installing from GitHub needs no build)
pnpm dev          # wrangler dev; put PSEUDONYM_KEY and CF_API_TOKEN in .dev.vars
```

## Deploy

Merging to `main` deploys the Worker through [shipper](https://github.com/ideaSquared/shipper) (`ship.yaml`): the
gate, `wrangler deploy`, a `/health` check that rolls back on failure, and a message in Discord. `ship status
agent-idea`, `ship deploy agent-idea` and `ship rollback agent-idea` work as for every other product.

The Worker's secrets are set once, by hand; deploys keep them:

```bash
openssl rand -hex 32 | pnpm wrangler secret put PSEUDONYM_KEY
pnpm wrangler secret put CF_API_TOKEN     # Cloudflare API token: Account > Workers Observability > Read, nothing else
# adopt-dont-shop (docs/ads-tunnel.md), plus the ADS_* vars in wrangler.jsonc:
pnpm wrangler secret put ADS_ACCESS_CLIENT_ID
pnpm wrangler secret put ADS_ACCESS_CLIENT_SECRET
pnpm wrangler secret put ADS_GLITCHTIP_TOKEN
```

To deploy by hand instead: `pnpm run deploy` (not `pnpm deploy`, which is pnpm's own workspace command).

Wrangler creates the `ACCESS_CACHE` KV namespace on the first deploy. Keep `PSEUDONYM_KEY` stable: changing it changes
every tag, so ids from before and after no longer match.
