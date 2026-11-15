import { cachedWriteAccess, checkWriteAccess } from './access.ts';
import type { Access, Fetch, OpsCache } from './access.ts';
import { validateArgs } from './args.ts';
import {
  CommandSchema,
  InvokeRequestSchema,
  OPS_CONTRACT_VERSION,
  OPS_ERROR_STATUS,
  OpsError,
} from './contract.ts';
import type { Args, Catalog, Command, InvokeResponse, Mode } from './contract.ts';

export type OpsContext = {
  // The caller's GitHub login. Handlers may use it to act as them; it is never logged by this package.
  login: string;
};

// What a handler returns. `result` is sent to the caller as it is, so return ids and counts, never personal data.
export type OpsOutput = { result: unknown; summary?: string };

export type OpsCommand = Command & {
  run(args: Args, ctx: OpsContext): Promise<OpsOutput> | OpsOutput;
  // Required exactly when `dryRun` is true on a write: say what run would do, and change nothing.
  preview?(args: Args, ctx: OpsContext): Promise<OpsOutput> | OpsOutput;
};

// The fields this package logs. Declare exactly these on the logger passed in:
//   createLogger({ service, fields: ['command', 'mode', 'outcome', 'durationMs'] })
export type OpsLogFields = { command?: string; mode?: string; outcome?: string; durationMs?: number };

// What createOpsHandler needs of an @ideasquared/log logger. The messages are fixed, and nothing about the caller,
// the args or the result is logged.
export type OpsLogger = {
  info(message: 'ops command ran', fields?: OpsLogFields): void;
  warn(message: 'ops command rejected', fields?: OpsLogFields): void;
  error(message: 'ops command failed', fields?: OpsLogFields, error?: unknown): void;
};

export type OpsHandlerOptions = {
  product: string;
  // "owner/name": callers need write access to this GitHub repo.
  repo: string;
  environment: string;
  commands: readonly OpsCommand[];
  fetch?: Fetch;
  cache?: OpsCache;
  logger?: OpsLogger;
};

// Mount under a base path, for example in Hono: app.all('/ops/*', (c) => handler(c.req.raw, '/ops'))
export type OpsHandler = (request: Request, basePath: string) => Promise<Response>;

type Trace = { command?: string; mode?: Mode };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function errorResponse(error: OpsError): Response {
  return json(OPS_ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
}

function toOpsError(error: unknown): OpsError {
  return error instanceof OpsError ? error : new OpsError('internal', 'internal error');
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) throw new OpsError('unauthenticated', 'a GitHub token is required');
  return match[1];
}

// The path after basePath, or null if the request is not under it.
function routeOf(request: Request, basePath: string): string | null {
  const base = basePath.replace(/\/+$/, '');
  const { pathname } = new URL(request.url);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  return pathname.slice(base.length).replace(/\/+$/, '') || '/';
}

function assertConsistent(commands: readonly OpsCommand[]): Command[] {
  const metadata = commands.map((command) => CommandSchema.parse(command));
  const duplicate = metadata.find((command, index) => metadata.findIndex((other) => other.id === command.id) !== index);
  if (duplicate) throw new Error(`duplicate ops command ${duplicate.id}`);
  commands.forEach((command) => {
    const previewable = command.kind === 'write' && command.dryRun;
    if (previewable && !command.preview) throw new Error(`ops command ${command.id} says dryRun but has no preview`);
    if (!previewable && (command.dryRun || command.preview)) {
      throw new Error(`ops command ${command.id}: only a write can have dryRun and preview`);
    }
  });
  return metadata;
}

export function createOpsHandler(options: OpsHandlerOptions): OpsHandler {
  const { product, repo, environment, logger, cache } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be "owner/name"');
  if (!product || !environment) throw new Error('product and environment are required');
  const commands = assertConsistent(options.commands);
  const byId = new Map(options.commands.map((command) => [command.id, command]));
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const catalog: Catalog = { version: OPS_CONTRACT_VERSION, product, environment, commands };

  const authenticate = async (request: Request): Promise<string> => {
    const token = bearerToken(request);
    const access: Access = cache
      ? await cachedWriteAccess(token, repo, cache, fetcher)
      : await checkWriteAccess(token, repo, fetcher);
    if (access.outcome === 'unauthenticated') throw new OpsError('unauthenticated', 'the GitHub token was rejected');
    if (access.outcome === 'denied') throw new OpsError('forbidden', 'write access to the repo is required');
    return access.login;
  };

  const invoke = async (request: Request, login: string, trace: Trace): Promise<InvokeResponse> => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = InvokeRequestSchema.safeParse(body);
    if (!parsed.success) throw new OpsError('invalid_argument', 'the request body is not a valid invoke request');
    const command = byId.get(parsed.data.command);
    if (!command) throw new OpsError('not_found', 'unknown command');
    // A read has nothing to preview, so it runs, and the response says so.
    const mode: Mode = command.kind === 'read' ? 'run' : parsed.data.mode;
    trace.command = command.id;
    trace.mode = mode;
    const args = validateArgs(command.fields, parsed.data.args);
    const ctx: OpsContext = { login };
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

  const record = (trace: Trace, started: number, failure: OpsError | null, cause: unknown): void => {
    if (!logger) return;
    const fields: OpsLogFields = {
      ...(trace.command !== undefined ? { command: trace.command } : {}),
      ...(trace.mode !== undefined ? { mode: trace.mode } : {}),
      outcome: failure ? failure.code : 'ok',
      durationMs: Date.now() - started,
    };
    if (!failure) logger.info('ops command ran', fields);
    else if (failure.code === 'internal') logger.error('ops command failed', fields, cause);
    else logger.warn('ops command rejected', fields);
  };

  return async (request, basePath) => {
    const route = routeOf(request, basePath);
    const isCatalog = route === '/catalog' && request.method === 'GET';
    const isInvoke = route === '/invoke' && request.method === 'POST';
    if (!isCatalog && !isInvoke) return errorResponse(new OpsError('not_found', 'not found'));

    const started = Date.now();
    const trace: Trace = {};
    try {
      const login = await authenticate(request);
      if (isCatalog) return json(200, catalog);
      const response = await invoke(request, login, trace);
      record(trace, started, null, undefined);
      return json(200, response);
    } catch (cause) {
      const failure = toOpsError(cause);
      if (isInvoke) record(trace, started, failure, cause);
      return errorResponse(failure);
    }
  };
}
