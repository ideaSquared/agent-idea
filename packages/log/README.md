# @ideasquared/log

Structured logging for every ideaSquared product, modelled on Monzo's
[slog](https://github.com/monzo/slog). It stops personal data being logged in the first place, so
[Agent Idea](../../README.md)'s sanitiser is the safety net, not the only defence.

```bash
pnpm add https://github.com/ideaSquared/agent-idea/releases/download/log-v0.1.0/ideasquared-log-0.1.0.tgz
```

Each release is a tarball on a GitHub Release, and the lockfile pins it with an integrity hash. Don't install from a
git URL or `github:` spec: those can record an SSH clone CI cannot fetch, and `turbo prune` drops the subfolder path.

To release a new version: bump `version` in `packages/log/package.json`, run `pnpm build`, and merge. On `main`, the
`Release @ideasquared/log` workflow tests, packs and publishes `log-v<version>` if that release doesn't exist yet.

```ts
import { createLogger } from '@ideasquared/log';

const log = createLogger({
  service: 'creatorgrid-api',
  fields: ['accountId', 'platform', 'count', 'requestId'],
});

log.info('sync processed', { platform: 'youtube', count: 3 });
log.error('sync failed', { accountId }, error);

const request = log.with({ requestId });   // carried on every event from `request`
request.warn('thumbnail fetch failed', { platform });
```

Each event is one JSON line on the console, which Cloudflare Workers Logs and Loki both read as fields:

```json
{"timestamp":"2026-11-14T18:22:12.984Z","level":"info","service":"creatorgrid-api","message":"sync processed","meta":{"platform":"youtube","count":3}}
```

## The rules it enforces

| Rule | How |
| --- | --- |
| The message is a fixed string from the code | Only a string literal compiles. `` log.info(`sent to ${email}`) `` and `log.info(someString)` are type errors. |
| Data goes in declared fields | `fields` lists every key the logger may write. An undeclared key is a type error, and is dropped at run time (counted in `dropped`) if untyped code sneaks one in. |
| No personal data or secrets as fields | Declaring a field such as `email`, `phone`, `name`, `displayName`, `address`, `postcode`, `ip`, `password`, `token`, `session…` or `steamId` throws. Log an id (`userId`, `accountId`) instead: Agent Idea turns ids into anonymous tags. |
| No objects dumped | Field values must be a string, number, boolean or null. Strings are cut to 200 characters. |
| Context once, on every line | `log.with({ requestId })` returns a logger that adds those fields to every event, like slog's `WithParams`. Fields passed to a call override them. |

Errors passed as the third argument are logged with their type, message and stack. An error's message can still
hold data from wherever it was thrown; Agent Idea scrubs it.

## Options

| Option | Default | |
| --- | --- | --- |
| `service` | required | The Worker or service name, as in its Workers Logs or Loki labels |
| `fields` | required | Every field the logger may write |
| `level` | `info` | Events below it are skipped: `debug` < `info` < `warn` < `error` |
| `sink` | console | Where events go. `memorySink()` keeps them in memory for tests |

## Testing

```ts
import { createLogger, memorySink } from '@ideasquared/log';

const sink = memorySink();
const log = createLogger({ service: 'test', fields: ['accountId'], sink });
// ... run the code under test with `log` ...
expect(sink.events.map((event) => event.message)).toContain('sync failed');
```
