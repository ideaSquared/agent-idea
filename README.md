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

Status: phase 2 of 6. Cloudflare Workers Logs and the `idea` CLI are in. Next: GitHub Actions logs, then
adopt-dont-shop's Loki and GlitchTip (staging).

## The idea command

```bash
pnpm add -g github:ideaSquared/agent-idea     # install or update
```

```bash
idea logs creatrgrid                          # the last hour, oldest first
idea logs creatrgrid --level error --since 24 # errors in the last 24 hours
idea logs pairflix --search youtube           # events mentioning youtube
idea logs gaminginit-bot --json               # JSON, for piping into other tools or an LLM
idea access ads                               # check you have write access
```

- `--since` is in hours, up to 168 (Workers Logs keeps 7 days). `--limit` is up to 200, default 50.
- A search term that holds personal data or a secret (an email, an IP, a token) is refused, so the logs can't be used
  to find out whether a person is in them.
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
   strings) is dropped.
2. **Scrub** the message: JWTs, bearer tokens, API keys (Anthropic, GitHub, Slack, Stripe, AWS), `password=`-style
   pairs, credentials and query strings in URLs, emails, IPv4 and IPv6, UK phone numbers and postcodes, card numbers,
   and long numbers (Discord ids and the like).
3. **Tag** ids so one user can be followed without being identified: UUIDs and 32-hex ids become `id_xxxxxxxx`,
   prefixed ids such as `acct_…` become `acct_xxxxxxxx`, and Steam IDs `steam_xxxxxxxx`. Each is an HMAC under the
   `PSEUDONYM_KEY` secret. Without that secret the Worker serves nothing.
4. **Routes and URLs.** Routes, URLs and `GET /path`-style text in messages lose their query string, and any path
   segment that is not in [`src/route-words.ts`](src/route-words.ts), a version or a parameter becomes `:param`, so a
   slug that is a person's name (`/creators/alex`) never leaves. If a real route shows up as `:param` and you want to
   see it, add the word there. Stack traces keep only `file:line`, cut to the path after `src/`.

[`test/sanitise.test.ts`](test/sanitise.test.ts) holds log lines full of personal data and secrets. CI fails if any
of it survives. Add a line there whenever a new kind of leak is found.

**Limits.** Regexes cannot recognise a name in free text ("player Bob joined"). Products should not log names. The
sanitiser is the safety net, not the only defence.

## Log sources

| Source | Projects | How |
| --- | --- | --- |
| Cloudflare Workers Logs | creatrgrid, gaminginit, gaminginit-bot, ideasquared-bot, pairflix | Workers Observability telemetry query API, filtered to the project's Worker scripts. Only the timestamp, level, service, path, status, wall time and message are read; Cloudflare's client IP, location, headers and TLS details are never touched. |

## API

| Route | What |
| --- | --- |
| `GET /health` | `{ "ok": true }`, no token needed |
| `GET /v1/access/:project` | `200` with your login if you can write to the project's repo; `401` with no or a bad token, `403` without write access, `404` for an unknown project |
| `GET /v1/logs/:project` | `{ "events": [...] }`, sanitised, newest first. Query: `since` (hours, default 1, max 168), `level`, `search`, `limit` (default 50, max 200). Same `401`/`403`/`404`, plus `400` for a bad query or a search holding personal data |

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build        # the CLI, into dist/ (committed, so installing from GitHub needs no build)
pnpm dev          # wrangler dev; put PSEUDONYM_KEY and CF_API_TOKEN in .dev.vars
```

## Deploy

```bash
openssl rand -hex 32 | pnpm wrangler secret put PSEUDONYM_KEY
pnpm wrangler secret put CF_API_TOKEN     # Cloudflare API token: Account > Workers Observability > Read, nothing else
pnpm deploy
```

Wrangler creates the `ACCESS_CACHE` KV namespace on the first deploy. Keep `PSEUDONYM_KEY` stable: changing it changes
every tag, so ids from before and after no longer match.
