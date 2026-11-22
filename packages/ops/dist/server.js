import { cachedWriteAccess, checkWriteAccess } from "./access.js";
import { validateArgs } from "./args.js";
import { CommandSchema, InvokeRequestSchema, OPS_CONTRACT_VERSION, OPS_ERROR_STATUS, OpsError } from "./contract.js";
function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
}
function errorResponse(error) {
    return json(OPS_ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
}
function toOpsError(error) {
    return error instanceof OpsError ? error : new OpsError('internal', 'internal error');
}
function bearerToken(request) {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!match?.[1])
        throw new OpsError('unauthenticated', 'a GitHub token is required');
    return match[1];
}
// The path after basePath, or null if the request is not under it.
function routeOf(request, basePath) {
    const base = basePath.replace(/\/+$/, '');
    const { pathname } = new URL(request.url);
    if (pathname !== base && !pathname.startsWith(`${base}/`))
        return null;
    return pathname.slice(base.length).replace(/\/+$/, '') || '/';
}
function assertConsistent(commands) {
    const metadata = commands.map((command) => CommandSchema.parse(command));
    const duplicate = metadata.find((command, index) => metadata.findIndex((other) => other.id === command.id) !== index);
    if (duplicate)
        throw new Error(`duplicate ops command ${duplicate.id}`);
    commands.forEach((command) => {
        const previewable = command.kind === 'write' && command.dryRun;
        if (previewable && !command.preview)
            throw new Error(`ops command ${command.id} says dryRun but has no preview`);
        if (!previewable && (command.dryRun || command.preview)) {
            throw new Error(`ops command ${command.id}: only a write can have dryRun and preview`);
        }
    });
    return metadata;
}
// The raw error a handler throws can carry personal data, arguments, results or tokens in its message, and the
// logger copies an error's message and stack. Log only the error's type, and only a known one: `name` is writable,
// so anything off this list becomes UnknownError.
const KNOWN_ERROR_NAMES = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'URIError',
    'EvalError',
    'AggregateError',
    'AbortError',
    'TimeoutError',
    'ZodError',
    'OpsError',
]);
function sanitisedCause(cause) {
    const name = cause instanceof Error && KNOWN_ERROR_NAMES.has(cause.name) ? cause.name : 'UnknownError';
    const safe = new Error('handler threw');
    safe.name = name;
    return safe;
}
export function createOpsHandler(options) {
    const { product, repo, authorize, environment, logger, cache } = options;
    if (repo !== undefined && authorize)
        throw new Error('give either repo or authorize, not both');
    if (repo === undefined && !authorize)
        throw new Error('give either repo or authorize');
    if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error('repo must be "owner/name"');
    if (!product || !environment)
        throw new Error('product and environment are required');
    const commands = assertConsistent(options.commands);
    const byId = new Map(options.commands.map((command) => [command.id, command]));
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    const catalog = { version: OPS_CONTRACT_VERSION, product, environment, commands };
    const builtIn = (token) => {
        if (repo === undefined)
            throw new Error('repo is required without authorize');
        return cache ? cachedWriteAccess(token, repo, cache, fetcher) : checkWriteAccess(token, repo, fetcher);
    };
    // A custom authoriser's own errors, OpsError included, must never reach the caller: anything it throws becomes the
    // generic 500, and only the error's type goes on to the log.
    const callAuthorize = async (check, token) => {
        try {
            return await check(token, { fetch: fetcher });
        }
        catch (cause) {
            const failed = new Error('authoriser threw');
            failed.name = cause instanceof Error ? cause.name : 'UnknownError';
            throw failed;
        }
    };
    const authenticate = async (request) => {
        const token = bearerToken(request);
        const access = authorize ? await callAuthorize(authorize, token) : await builtIn(token);
        if (access.outcome === 'unauthenticated')
            throw new OpsError('unauthenticated', 'the GitHub token was rejected');
        if (access.outcome === 'denied')
            throw new OpsError('forbidden', authorize ? 'access denied' : 'write access to the repo is required');
        return access.login;
    };
    const invoke = async (request, login, trace) => {
        const body = await request.json().catch(() => null);
        const parsed = InvokeRequestSchema.safeParse(body);
        if (!parsed.success)
            throw new OpsError('invalid_argument', 'the request body is not a valid invoke request');
        const command = byId.get(parsed.data.command);
        if (!command)
            throw new OpsError('not_found', 'unknown command');
        // A read has nothing to preview, so it runs, and the response says so.
        const mode = command.kind === 'read' ? 'run' : parsed.data.mode;
        trace.command = command.id;
        trace.mode = mode;
        const args = validateArgs(command.fields, parsed.data.args);
        const ctx = { login };
        if (mode === 'preview' && !command.preview) {
            throw new OpsError('invalid_argument', 'this command does not support preview');
        }
        const handler = mode === 'preview' && command.preview ? command.preview : command.run;
        const output = await handler.call(command, args, ctx);
        return {
            command: command.id,
            mode,
            result: output.result ?? null,
            ...(output.summary !== undefined ? { summary: output.summary } : {}),
        };
    };
    const record = (trace, started, failure, cause) => {
        if (!logger)
            return;
        const fields = {
            ...(trace.command !== undefined ? { command: trace.command } : {}),
            ...(trace.mode !== undefined ? { mode: trace.mode } : {}),
            outcome: failure ? failure.code : 'ok',
            durationMs: Date.now() - started,
        };
        // A logger that throws must never change the response: a write that ran is still reported as ran, so the
        // caller doesn't retry and repeat it.
        try {
            if (!failure)
                logger.info('ops command ran', fields);
            else if (failure.code === 'internal')
                logger.error('ops command failed', fields, sanitisedCause(cause));
            else
                logger.warn('ops command rejected', fields);
        }
        catch {
            // Nothing to do: the response below is what matters.
        }
    };
    return async (request, basePath) => {
        const route = routeOf(request, basePath);
        const isCatalog = route === '/catalog' && request.method === 'GET';
        const isInvoke = route === '/invoke' && request.method === 'POST';
        if (!isCatalog && !isInvoke)
            return errorResponse(new OpsError('not_found', 'not found'));
        const started = Date.now();
        const trace = {};
        try {
            const login = await authenticate(request);
            if (isCatalog)
                return json(200, catalog);
            const response = await invoke(request, login, trace);
            record(trace, started, null, undefined);
            return json(200, response);
        }
        catch (cause) {
            const failure = toOpsError(cause);
            if (isInvoke)
                record(trace, started, failure, cause);
            return errorResponse(failure);
        }
    };
}
