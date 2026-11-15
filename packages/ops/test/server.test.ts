import { createLogger, memorySink } from '@ideasquared/log';
import { describe, expect, it } from 'vitest';
import { createOpsHandler, OpsError } from '../src/index.ts';
import type { Access, OpsCommand, OpsHandlerOptions } from '../src/index.ts';
import { checkTeamMembership } from '../src/index.ts';
import { fakeCache, fakeGitHub, ORG, REPO, TEAM, teamMember, writer } from './fakes.ts';

const calls: string[] = [];

const commands: OpsCommand[] = [
  {
    id: 'accounts.show',
    group: 'accounts',
    name: 'show',
    summary: 'Show an account',
    kind: 'read',
    fields: [{ name: 'accountId', type: 'id', required: true, description: '', positional: true }],
    dryRun: false,
    run: (args) => {
      calls.push(`show:${args.accountId}`);
      return { result: { accountId: args.accountId, posts: 4 }, summary: '4 posts' };
    },
  },
  {
    id: 'accounts.resync',
    group: 'accounts',
    name: 'resync',
    summary: 'Resync an account',
    kind: 'write',
    fields: [{ name: 'accountId', type: 'id', required: true, description: '', positional: true }],
    dryRun: true,
    run: (args, ctx) => {
      calls.push(`resync:${args.accountId}:${ctx.login}`);
      return { result: { queued: 1 } };
    },
    preview: (args) => ({ result: { wouldQueue: 1, accountId: args.accountId }, summary: 'would queue 1' }),
  },
  {
    id: 'accounts.purge',
    group: 'accounts',
    name: 'purge',
    summary: 'Purge',
    kind: 'write',
    fields: [],
    dryRun: false,
    run: () => {
      calls.push('purge');
      return { result: { purged: 2 } };
    },
  },
  {
    id: 'accounts.break',
    group: 'accounts',
    name: 'break',
    summary: 'Always fails',
    kind: 'read',
    fields: [],
    dryRun: false,
    run: () => {
      throw new Error('boom for alex@example.com');
    },
  },
  {
    id: 'accounts.refuse',
    group: 'accounts',
    name: 'refuse',
    summary: 'Refuses',
    kind: 'read',
    fields: [],
    dryRun: false,
    run: () => {
      throw new OpsError('not_found', 'no such account');
    },
  },
];

function setup(options: { github?: ReturnType<typeof fakeGitHub>; cache?: ReturnType<typeof fakeCache> } = {}) {
  const sink = memorySink();
  const logger = createLogger({ service: 'creatrgrid-api', fields: ['command', 'mode', 'outcome', 'durationMs'], sink });
  const github = options.github ?? writer();
  const handler = createOpsHandler({
    product: 'creatrgrid',
    repo: REPO,
    environment: 'production',
    commands,
    fetch: github.fetcher,
    cache: options.cache,
    logger,
  });
  const send = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = 'gh-secret-token', ...rest } = init;
    return handler(
      new Request(`https://api.example.com/ops${path}`, {
        ...rest,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers as Record<string, string>) },
      }),
      '/ops',
    );
  };
  const post = (body: unknown, token?: string | null) =>
    send('/invoke', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), token });
  return { send, post, sink, github };
}

describe('catalog', () => {
  it('lists the commands without their handlers', async () => {
    const { send } = setup();
    const response = await send('/catalog');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ version: 1, product: 'creatrgrid', environment: 'production' });
    expect(body.commands.map((command: { id: string }) => command.id)).toContain('accounts.resync');
    expect(JSON.stringify(body)).not.toContain('run');
    expect(body.commands[1]).toEqual({
      id: 'accounts.resync',
      group: 'accounts',
      name: 'resync',
      summary: 'Resync an account',
      kind: 'write',
      fields: [{ name: 'accountId', type: 'id', required: true, description: '', positional: true }],
      dryRun: true,
    });
  });

  it('routes under any base path, trailing slash included', async () => {
    const { send } = setup();
    expect((await send('/catalog/')).status).toBe(200);
  });
});

describe('auth', () => {
  it('answers 401 with no token and never asks GitHub', async () => {
    const { send, github } = setup();
    const response = await send('/catalog', { token: null });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('unauthenticated');
    expect(github.calls).toHaveLength(0);
  });

  it('answers 401 for a token GitHub rejects', async () => {
    const { send } = setup({ github: fakeGitHub({ '/user': { status: 401 } }) });
    expect((await send('/catalog')).status).toBe(401);
  });

  it('answers 403 without write access', async () => {
    const github = fakeGitHub({
      '/user': { status: 200, body: { login: 'reader' } },
      [`/repos/${REPO}`]: { status: 200, body: { permissions: { pull: true, push: false, admin: false } } },
    });
    const { send, post } = setup({ github });
    expect((await send('/catalog')).status).toBe(403);
    expect((await post({ command: 'accounts.purge', args: {}, mode: 'run' })).status).toBe(403);
    expect(calls).not.toContain('purge');
  });

  it('answers 500 when GitHub is failing, without leaking the token', async () => {
    const { send } = setup({ github: fakeGitHub({ '/user': { status: 502 } }) });
    const response = await send('/catalog');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('gh-secret-token');
  });

  it('uses the cache when given one', async () => {
    const cache = fakeCache();
    const { send, github } = setup({ cache });
    await send('/catalog');
    await send('/catalog');
    expect(github.calls).toHaveLength(2);
    expect(JSON.stringify([...cache.store])).not.toContain('gh-secret-token');
  });
});

describe('a custom authorize', () => {
  const secret = 'gh-secret-token';
  const build = (authorize: (token: string) => Promise<Access>) => {
    const sink = memorySink();
    const logger = createLogger({ service: 'ads-ops', fields: ['command', 'mode', 'outcome', 'durationMs'], sink });
    const github = fakeGitHub({});
    const seen: Array<{ token: string; fetchIsHandlers: boolean }> = [];
    const handler = createOpsHandler({
      product: 'ads',
      environment: 'production',
      commands,
      fetch: github.fetcher,
      logger,
      authorize: async (token, ctx) => {
        seen.push({ token, fetchIsHandlers: ctx.fetch === github.fetcher });
        return authorize(token);
      },
    });
    const call = (path: string, init: RequestInit = {}) =>
      handler(
        new Request(`https://api.example.com/ops${path}`, {
          ...init,
          headers: { authorization: `Bearer ${secret}` },
        }),
        '/ops',
      );
    const invoke = (command: string) =>
      call('/invoke', { method: 'POST', body: JSON.stringify({ command, args: {}, mode: 'run' }) });
    return { call, invoke, sink, github, seen };
  };

  it('lets an allowed caller in, with their login, and replaces the repo check', async () => {
    const { call, invoke, github, seen } = build(async () => ({ outcome: 'allowed', login: 'octocat' }));
    expect((await call('/catalog')).status).toBe(200);
    const before = calls.length;
    expect((await invoke('accounts.purge')).status).toBe(200);
    expect(calls.length).toBe(before + 1);
    expect(seen.every((entry) => entry.token === secret && entry.fetchIsHandlers)).toBe(true);
    expect(github.calls).toHaveLength(0);
  });

  it('gives the handler the login the authoriser returned', async () => {
    const handler = createOpsHandler({
      product: 'ads',
      environment: 'production',
      commands,
      authorize: async () => ({ outcome: 'allowed', login: 'team-member' }),
    });
    const response = await handler(
      new Request('https://api.example.com/ops/invoke', {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: JSON.stringify({ command: 'accounts.resync', args: { accountId: 'a1' }, mode: 'run' }),
      }),
      '/ops',
    );
    expect(response.status).toBe(200);
    expect(calls).toContain('resync:a1:team-member');
  });

  it('answers 403 for a denied caller and never runs the command', async () => {
    const { call, invoke } = build(async () => ({ outcome: 'denied', login: 'octocat' }));
    const before = calls.length;
    expect((await call('/catalog')).status).toBe(403);
    const response = await invoke('accounts.purge');
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
    expect(calls.length).toBe(before);
  });

  it('answers 401 when the authoriser says unauthenticated', async () => {
    const { call, invoke } = build(async () => ({ outcome: 'unauthenticated' }));
    expect((await call('/catalog')).status).toBe(401);
    const response = await invoke('accounts.purge');
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('unauthenticated');
  });

  it('answers 401 with no token without calling the authoriser', async () => {
    const { seen } = build(async () => ({ outcome: 'allowed', login: 'octocat' }));
    const handler = createOpsHandler({
      product: 'ads',
      environment: 'production',
      commands,
      authorize: async (token) => {
        seen.push({ token, fetchIsHandlers: false });
        return { outcome: 'allowed', login: 'octocat' };
      },
    });
    const response = await handler(new Request('https://api.example.com/ops/catalog'), '/ops');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('answers 500 internal when the authoriser throws, logging only the error type', async () => {
    const { invoke, sink } = build(async () => {
      throw new TypeError(`boom for alex@example.com ${secret}`);
    });
    const response = await invoke('accounts.purge');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } });
    const serialised = JSON.stringify(sink.events);
    expect(sink.events.map((event) => event.message)).toEqual(['ops command failed']);
    expect(serialised).toContain('TypeError');
    for (const leak of [secret, 'alex@example.com', 'octocat']) {
      expect(serialised).not.toContain(leak);
      expect(text).not.toContain(leak);
    }
  });

  it('answers the generic 500 even when the authoriser throws an OpsError carrying private detail', async () => {
    const { invoke, sink } = build(async () => {
      throw new OpsError('forbidden', `not in team for alex@example.com ${secret}`);
    });
    const response = await invoke('accounts.purge');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } });
    for (const leak of [secret, 'alex@example.com', 'not in team']) {
      expect(text).not.toContain(leak);
      expect(JSON.stringify(sink.events)).not.toContain(leak);
    }
  });

  it('never logs the token or the login', async () => {
    const { invoke, sink } = build(async () => ({ outcome: 'allowed', login: 'octocat' }));
    await invoke('accounts.purge');
    expect(sink.events.map((event) => event.message)).toEqual(['ops command ran']);
    expect(JSON.stringify(sink.events)).not.toContain(secret);
    expect(JSON.stringify(sink.events)).not.toContain('octocat');
  });

  it('does not use the cache, which belongs to the built-in check', async () => {
    const cache = fakeCache();
    const handler = createOpsHandler({
      product: 'ads',
      environment: 'production',
      commands,
      cache,
      authorize: async () => ({ outcome: 'allowed', login: 'octocat' }),
    });
    await handler(new Request('https://api.example.com/ops/catalog', { headers: { authorization: 'Bearer t' } }), '/ops');
    expect(cache.store.size).toBe(0);
  });

  it('works end to end with checkTeamMembership', async () => {
    const send = (github: ReturnType<typeof teamMember>) =>
      createOpsHandler({
        product: 'ads',
        environment: 'production',
        commands,
        fetch: github.fetcher,
        authorize: (token, ctx) => checkTeamMembership(token, { org: ORG, team: TEAM }, ctx.fetch),
      })(new Request('https://api.example.com/ops/catalog', { headers: { authorization: 'Bearer t' } }), '/ops');
    expect((await send(teamMember({ status: 200, body: { state: 'active' } }))).status).toBe(200);
    expect((await send(teamMember({ status: 404 }))).status).toBe(403);
    expect((await send(teamMember({ status: 500 }))).status).toBe(500);
  });
});

describe('invoke', () => {
  it('runs a read and passes validated args', async () => {
    const { post } = setup();
    const response = await post({ command: 'accounts.show', args: { accountId: 'acct_1' }, mode: 'run' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: 'accounts.show',
      mode: 'run',
      result: { accountId: 'acct_1', posts: 4 },
      summary: '4 posts',
    });
  });

  it('runs a read even when asked to preview, and says it ran', async () => {
    const { post } = setup();
    const body = await (await post({ command: 'accounts.show', args: { accountId: 'a' }, mode: 'preview' })).json();
    expect(body.mode).toBe('run');
  });

  it('previews a write without running it', async () => {
    calls.length = 0;
    const { post } = setup();
    const body = await (await post({ command: 'accounts.resync', args: { accountId: 'a' }, mode: 'preview' })).json();
    expect(body).toEqual({
      command: 'accounts.resync',
      mode: 'preview',
      result: { wouldQueue: 1, accountId: 'a' },
      summary: 'would queue 1',
    });
    expect(calls).toEqual([]);
  });

  it('runs a write, giving the handler the caller login', async () => {
    calls.length = 0;
    const { post } = setup();
    const response = await post({ command: 'accounts.resync', args: { accountId: 'a' }, mode: 'run' });
    expect((await response.json()).result).toEqual({ queued: 1 });
    expect(calls).toEqual(['resync:a:octocat']);
  });

  it('refuses to preview a write that cannot, rather than running it', async () => {
    calls.length = 0;
    const { post } = setup();
    const response = await post({ command: 'accounts.purge', args: {}, mode: 'preview' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_argument');
    expect(calls).toEqual([]);
  });

  it('answers 404 for an unknown command', async () => {
    const { post } = setup();
    const response = await post({ command: 'accounts.nope', args: {}, mode: 'run' });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
  });

  it('answers 400 naming the invalid field, before the handler runs', async () => {
    calls.length = 0;
    const { post } = setup();
    const response = await post({ command: 'accounts.show', args: {}, mode: 'run' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: 'invalid_argument',
      message: "field 'accountId' is required",
    });
    expect(calls).toEqual([]);
  });

  it('answers 400 for a body that is not an invoke request', async () => {
    const { post } = setup();
    expect((await post('not json')).status).toBe(400);
    expect((await post({ command: 'accounts.show', args: {} })).status).toBe(400);
  });

  it('maps an OpsError from a handler to its code', async () => {
    const { post } = setup();
    const response = await post({ command: 'accounts.refuse', args: {}, mode: 'run' });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toEqual({ code: 'not_found', message: 'no such account' });
  });

  it('hides the message of an unexpected error', async () => {
    const { post } = setup();
    const response = await post({ command: 'accounts.break', args: {}, mode: 'run' });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toEqual({ code: 'internal', message: 'internal error' });
  });

  it('answers 404 for unknown routes and wrong methods', async () => {
    const { send } = setup();
    expect((await send('/nope')).status).toBe(404);
    expect((await send('/invoke')).status).toBe(404);
    expect((await send('/catalog', { method: 'POST' })).status).toBe(404);
  });
});

describe('logging', () => {
  it('logs command, mode, outcome and duration with fixed messages', async () => {
    const { post, sink } = setup();
    await post({ command: 'accounts.resync', args: { accountId: 'a' }, mode: 'preview' });
    await post({ command: 'accounts.show', args: {}, mode: 'run' });
    expect(sink.events.map((event) => [event.level, event.message, event.meta?.command, event.meta?.mode, event.meta?.outcome])).toEqual([
      ['info', 'ops command ran', 'accounts.resync', 'preview', 'ok'],
      ['warn', 'ops command rejected', 'accounts.show', 'run', 'invalid_argument'],
    ]);
    expect(sink.events[0]?.meta?.durationMs).toEqual(expect.any(Number));
    expect(sink.events.every((event) => event.dropped === undefined)).toBe(true);
  });

  it('logs denied callers without a command', async () => {
    const { post, sink } = setup();
    await post({ command: 'accounts.show', args: {}, mode: 'run' }, null);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.meta).toEqual({ outcome: 'unauthenticated', durationMs: expect.any(Number) });
  });

  it('logs an unknown command without echoing it', async () => {
    const { post, sink } = setup();
    await post({ command: 'alex@example.com', args: {}, mode: 'run' });
    expect(JSON.stringify(sink.events)).not.toContain('alex');
    expect(sink.events[0]?.meta?.outcome).toBe('not_found');
  });

  it('logs an unexpected failure at error level', async () => {
    const { post, sink } = setup();
    await post({ command: 'accounts.break', args: {}, mode: 'run' });
    expect(sink.events[0]).toMatchObject({ level: 'error', message: 'ops command failed' });
  });

  it('logs only the type of an unexpected error, never its message or stack', async () => {
    const { post, sink } = setup();
    await post({ command: 'accounts.break', args: {}, mode: 'run' });
    const logged = JSON.stringify(sink.events);
    expect(logged).not.toContain('alex');
    expect(logged).not.toContain('boom');
    expect(logged).toContain('Error');
  });

  it('never logs the token, the GitHub login, args or results', async () => {
    const { post, sink } = setup();
    await post({ command: 'accounts.show', args: { accountId: 'acct-private-1' }, mode: 'run' });
    await post({ command: 'accounts.resync', args: { accountId: 'acct-private-2' }, mode: 'run' });
    const logged = JSON.stringify(sink.events);
    for (const secret of ['gh-secret-token', 'octocat', 'acct-private', 'posts', 'queued']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('createOpsHandler configuration', () => {
  const base = { product: 'p', repo: REPO, environment: 'e' };
  const at = (index: number): OpsCommand => {
    const found = commands[index];
    if (!found) throw new Error('missing fixture');
    return found;
  };
  const read = at(0);

  it('rejects a write that says dryRun without a preview', () => {
    const bad = { ...at(2), dryRun: true };
    expect(() => createOpsHandler({ ...base, commands: [bad] })).toThrow('has no preview');
  });

  it('rejects a preview that dryRun does not declare, and a read with dryRun', () => {
    const preview = { ...at(2), preview: () => ({ result: 1 }) };
    expect(() => createOpsHandler({ ...base, commands: [preview] })).toThrow('only a write');
    expect(() => createOpsHandler({ ...base, commands: [{ ...read, dryRun: true }] })).toThrow('only a write');
  });

  it('rejects duplicate ids, malformed metadata and a bad repo', () => {
    expect(() => createOpsHandler({ ...base, commands: [read, read] })).toThrow('duplicate');
    expect(() => createOpsHandler({ ...base, commands: [{ ...read, id: 'x' }] })).toThrow();
    expect(() => createOpsHandler({ ...base, repo: 'nope', commands: [] })).toThrow('owner/name');
  });

  it('requires exactly one of repo and authorize', () => {
    const authorize = async (): Promise<Access> => ({ outcome: 'allowed', login: 'octocat' });
    const { repo: _repo, ...noAccess } = base;
    // The types already forbid these; the cast reaches the startup check that plain JavaScript callers hit.
    const loose = (options: object) => options as unknown as OpsHandlerOptions;
    expect(() => createOpsHandler(loose({ ...noAccess, commands: [] }))).toThrow('either repo or authorize');
    expect(() => createOpsHandler(loose({ ...base, authorize, commands: [] }))).toThrow('not both');
    expect(() => createOpsHandler({ ...noAccess, authorize, commands: [] })).not.toThrow();
    expect(() => createOpsHandler({ ...base, commands: [] })).not.toThrow();
  });
});

describe('the error type in a failure line', () => {
  const failingWith = (error: unknown) => {
    const sink = memorySink();
    const logger = createLogger({ service: 'creatrgrid-api', fields: ['command', 'mode', 'outcome', 'durationMs'], sink });
    const handler = createOpsHandler({
      product: 'creatrgrid',
      repo: REPO,
      environment: 'production',
      commands: [
        {
          id: 'accounts.crash',
          group: 'accounts',
          name: 'crash',
          summary: 'Throws',
          kind: 'read',
          fields: [],
          dryRun: false,
          run: () => {
            throw error;
          },
        },
      ],
      fetch: writer().fetcher,
      logger,
    });
    const run = () =>
      handler(
        new Request('https://api.example.com/ops/invoke', {
          method: 'POST',
          headers: { authorization: 'Bearer gh-secret-token' },
          body: JSON.stringify({ command: 'accounts.crash', args: {}, mode: 'run' }),
        }),
        '/ops',
      );
    return { sink, run };
  };
  const named = (name: string) => Object.assign(new Error('x'), { name });

  it.each(['alex', 'ghp_SYNTHETIC_TOKEN_123', 'acct_private_42'])('replaces a made-up name (%s) with UnknownError', async (name) => {
    const { sink, run } = failingWith(named(name));
    await run();
    const logged = JSON.stringify(sink.events);
    expect(logged).not.toContain(name);
    expect(logged).toContain('UnknownError');
  });

  it('keeps a known type such as TypeError', async () => {
    const { sink, run } = failingWith(new TypeError('alex@example.com'));
    await run();
    const logged = JSON.stringify(sink.events);
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('alex');
  });

  it('uses UnknownError for a thrown non-error', async () => {
    const { sink, run } = failingWith('alex@example.com');
    await run();
    const logged = JSON.stringify(sink.events);
    expect(logged).toContain('UnknownError');
    expect(logged).not.toContain('alex');
  });
});

describe('a logger that throws', () => {
  const throwingLogger = {
    info: () => {
      throw new Error('sink down');
    },
    warn: () => {
      throw new Error('sink down');
    },
    error: () => {
      throw new Error('sink down');
    },
  };
  const ran: string[] = [];
  const handler = createOpsHandler({
    product: 'creatrgrid',
    repo: REPO,
    environment: 'production',
    commands: [
      {
        id: 'accounts.touch',
        group: 'accounts',
        name: 'touch',
        summary: 'Writes once',
        kind: 'write',
        fields: [],
        dryRun: false,
        run: () => {
          ran.push('touch');
          return { result: { touched: true } };
        },
      },
      {
        id: 'accounts.crash',
        group: 'accounts',
        name: 'crash',
        summary: 'Throws',
        kind: 'read',
        fields: [],
        dryRun: false,
        run: () => {
          throw new Error('handler broke');
        },
      },
    ],
    fetch: writer().fetcher,
    logger: throwingLogger,
  });
  const post = (command: string) =>
    handler(
      new Request('https://api.example.com/ops/invoke', {
        method: 'POST',
        headers: { authorization: 'Bearer gh-secret-token' },
        body: JSON.stringify({ command, args: {}, mode: 'run' }),
      }),
      '/ops',
    );

  it('still reports a write that ran as ran', async () => {
    const response = await post('accounts.touch');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ command: 'accounts.touch', result: { touched: true } });
    expect(ran).toEqual(['touch']);
  });

  it('still answers a failure with the contract error', async () => {
    const response = await post('accounts.crash');
    expect(response.status).toBe(500);
    expect((await response.json()).error).toEqual({ code: 'internal', message: 'internal error' });
  });
});
