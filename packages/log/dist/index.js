// Structured logging modelled on Monzo's slog (github.com/monzo/slog):
// - the message is a fixed string from the code, never built from data;
// - data goes in named fields, declared up front, so nothing undeclared is ever logged;
// - context (a request id, a job name) is attached once with `with` and carried on every line.
// Each event is one JSON line, which Cloudflare Workers Logs and Loki both read as fields.
// Field names that describe personal data or secrets. Declaring one throws, so it fails in the first test
// that creates the logger. Log an id (userId, accountId) instead: Agent Idea turns ids into anonymous tags.
const FORBIDDEN_FIELD = /e-?mail|phone|mobile|(^|[a-z_])name$|^name|address|postcode|postal|zip|^ip$|ipaddr|ip_?address|password|passwd|secret|token|cookie|session|authori[sz]ation|card|iban|sort_?code|dob|birth|steam_?id/i;
// Names the rule above would catch that hold no personal data. Kept short on purpose: add one only when it is
// clearly not about a person.
const ALLOWED_FIELDS = new Set(['hostname', 'filename', 'pathname']);
const MAX_STRING = 200;
const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const consoleSink = (event) => console[event.level](JSON.stringify(event));
function cleanFields(fields, declared) {
    const entries = Object.entries(fields ?? {});
    const kept = entries.filter(([key, value]) => declared.has(key) &&
        (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')); // filtered to FieldValue by the check above
    const meta = Object.fromEntries(kept.map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, MAX_STRING) : value]));
    return { meta, dropped: entries.length - kept.length };
}
function describeError(error) {
    if (error instanceof Error) {
        return { type: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
    }
    return { type: typeof error, message: String(error).slice(0, MAX_STRING) };
}
export function createLogger(options) {
    const forbidden = options.fields.filter((field) => FORBIDDEN_FIELD.test(field) && !ALLOWED_FIELDS.has(field));
    if (forbidden.length > 0) {
        throw new Error(`Fields that hold personal data or secrets cannot be logged: ${forbidden.join(', ')}. Log an id instead.`);
    }
    const declared = new Set(options.fields);
    const minimum = ORDER[options.level ?? 'info'];
    const sink = options.sink ?? consoleSink;
    const build = (context) => {
        const emit = (level, message, fields, error) => {
            if (ORDER[level] < minimum)
                return;
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
export function memorySink() {
    const events = [];
    const sink = (event) => {
        events.push(event);
    };
    return Object.assign(sink, { events });
}
