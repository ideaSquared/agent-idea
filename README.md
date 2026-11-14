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

Status: phase 1 of 6. The API, the access check and the sanitiser are in; no log source is connected yet, and the
`idea` CLI comes next.

## Access

- Every request carries a GitHub token: `Authorization: Bearer <token>`. The CLI will read it from `gh auth token`.
- The Worker calls GitHub's `/user` and `/repos/{owner}/{repo}` **with that token** and allows the request only if
  `permissions` has `push`, `maintain` or `admin`. Read access is not enough, because anyone can read a public repo.
- The answer is cached in KV for 5 minutes under a SHA-256 of the token. The token itself is never stored or logged.
- Every request logs one audit line: GitHub login, project, route and outcome. Never the results.

Products and their repos are in [`src/projects.ts`](src/projects.ts).

## Sanitising

Every log event goes through [`sanitiseEvent`](src/sanitise.ts) before it leaves the Worker.

1. **Allowlist.** Only these fields are returned: `timestamp`, `level`, `service`, `route`, `status`, `durationMs`,
   `errorType`, `message`, `stack`. Anything else on the event (bodies, headers, cookies, IPs, user agents, query
   strings) is dropped.
2. **Scrub** the message: JWTs, bearer tokens, API keys (Anthropic, GitHub, Slack, Stripe, AWS), `password=`-style
   pairs, credentials and query strings in URLs, emails, IPv4 and IPv6, UK phone numbers and postcodes, card numbers,
   and long numbers (Discord ids and the like).
3. **Tag** ids so one user can be followed without being identified: UUIDs become `id_xxxxxxxx` and Steam IDs
   `steam_xxxxxxxx`, an HMAC under the `PSEUDONYM_KEY` secret. Without that secret the Worker serves nothing.
4. **Templates and frames.** Routes lose their query string, and any segment that is not a plain word, a version or a
   parameter becomes `:param`. Stack traces keep only `file:line`, cut to the path after `src/`.

[`test/sanitise.test.ts`](test/sanitise.test.ts) holds log lines full of personal data and secrets. CI fails if any
of it survives. Add a line there whenever a new kind of leak is found.

**Limits.** Regexes cannot recognise a name in free text ("player Bob joined"), or a slug that is a plain word
(`/sites/alex`). Products should not log names, and log sources should pass route templates (Hono's `routePath`,
Fastify's route URL) rather than raw paths. The sanitiser is the safety net, not the only defence.

## API

| Route | What |
| --- | --- |
| `GET /health` | `{ "ok": true }`, no token needed |
| `GET /v1/access/:project` | `200` with your login if you can write to the project's repo; `401` with no or a bad token, `403` without write access, `404` for an unknown project |

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev          # wrangler dev; put PSEUDONYM_KEY=<anything> in .dev.vars
```

## Deploy

```bash
openssl rand -hex 32 | pnpm wrangler secret put PSEUDONYM_KEY
pnpm deploy
```

Wrangler creates the `ACCESS_CACHE` KV namespace on the first deploy. Keep `PSEUDONYM_KEY` stable: changing it changes
every tag, so ids from before and after no longer match.
