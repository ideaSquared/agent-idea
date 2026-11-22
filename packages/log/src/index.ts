// Structured logging modelled on Monzo's slog (github.com/monzo/slog):
// - the message is a fixed string from the code, never built from data;
// - data goes in named fields, declared up front, so nothing undeclared is ever logged;
// - context (a request id, a job name) is attached once with `with` and carried on every line.
// Each event is one JSON line, which Cloudflare Workers Logs and Loki both read as fields.

declare const console: {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
};

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type FieldValue = string | number | boolean | null;

export type LogEvent = {
  timestamp: string;
  level: Level;
  service: string;
  message: string;
  meta?: Record<string, FieldValue>;
  error?: { type: string; message: string; stack?: string };
  // How many fields were dropped because they were undeclared or not a plain value.
  dropped?: number;
};

export type Sink = (event: LogEvent) => void;

// A message must be a string literal. `log.info(someString)` and `log.info(\`sent to ${email}\`)` do not compile:
// their types (`string`, or the pattern \`sent to ${string}\`) turn Record<M, 1> into an index signature, which `{}`
// satisfies, whereas a literal such as 'sync failed' gives a required property, which `{}` does not.
export type Message<M extends string> = {} extends Record<M, 1> ? never : M;

export type Fields<F extends string> = Partial<Record<F, FieldValue>>;

export type Logger<F extends string> = {
  debug<M extends string>(message: Message<M>, fields?: Fields<F>): void;
  info<M extends string>(message: Message<M>, fields?: Fields<F>): void;
  warn<M extends string>(message: Message<M>, fields?: Fields<F>, error?: unknown): void;
  error<M extends string>(message: Message<M>, fields?: Fields<F>, error?: unknown): void;
  // A logger that adds these fields to every event, like slog's WithParams.
  with(fields: Fields<F>): Logger<F>;
};

export type LoggerOptions<F extends string> = {
  service: string;
  fields: readonly F[];
  level?: Level;
  sink?: Sink;
};

// Field names that describe personal data or secrets. Declaring one throws, so it fails in the first test
// that creates the logger. Log an id (userId, accountId) instead: Agent Idea turns ids into anonymous tags.
const FORBIDDEN_FIELD =
  /e-?mail|phone|mobile|(^|[a-z_])name$|^name|address|postcode|postal|zip|^ip$|ipaddr|ip_?address|password|passwd|secret|token|cookie|session|authori[sz]ation|card|iban|sort_?code|dob|birth|steam_?id/i;

// Names the rule above would catch that hold no personal data. Kept short on purpose: add one only when it is
// clearly not about a person.
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['hostname', 'filename', 'pathname']);

const MAX_STRING = 200;
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const consoleSink: Sink = (event) => console[event.level](JSON.stringify(event));

function cleanFields(
  fields: Record<string, unknown> | undefined,
  declared: ReadonlySet<string>,
): { meta: Record<string, FieldValue>; dropped: number } {
  const entries = Object.entries(fields ?? {});
  const kept = entries.filter(
    ([key, value]) =>
      declared.has(key) &&
      (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
  ) as Array<[string, FieldValue]>; // filtered to FieldValue by the check above
  const meta = Object.fromEntries(
    kept.map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, MAX_STRING) : value]),
  );
  return { meta, dropped: entries.length - kept.length };
}

function describeError(error: unknown): LogEvent['error'] {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { type: typeof error, message: String(error).slice(0, MAX_STRING) };
}

export function createLogger<const F extends string>(options: LoggerOptions<F>): Logger<F> {
  const forbidden = options.fields.filter((field) => FORBIDDEN_FIELD.test(field) && !ALLOWED_FIELDS.has(field));
  if (forbidden.length > 0) {
    throw new Error(
      `Fields that hold personal data or secrets cannot be logged: ${forbidden.join(', ')}. Log an id instead.`,
    );
  }
  const declared = new Set<string>(options.fields);
  const minimum = ORDER[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;

  const build = (context: Record<string, unknown>): Logger<F> => {
    const emit = (level: Level, message: string, fields?: Record<string, unknown>, error?: unknown): void => {
      if (ORDER[level] < minimum) return;
      const { meta, dropped } = cleanFields({ ...context, ...fields }, declared);
      sink({
        timestamp: new Date().toISOString(),
        level,
        service: options.service,
        message,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
        ...(error !== undefined ? { error: describeError(error) } : {}),
        ...(dropped > 0 ? { dropped } : {}),
      });
    };
    return {
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields, error) => emit('warn', message, fields, error),
      error: (message, fields, error) => emit('error', message, fields, error),
      with: (fields) => build({ ...context, ...fields }),
    };
  };
  return build({});
}

// A sink that keeps events in memory, for tests: assert what was logged, and that nothing personal was.
export function memorySink(): Sink & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const sink = (event: LogEvent): void => {
    events.push(event);
  };
  return Object.assign(sink, { events });
}
