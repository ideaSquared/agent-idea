import { createLogger } from '@ideasquared/log';
import { describe, expect, it } from 'vitest';
import { createOpsHandler, fetchCatalog, invoke, OpsError } from '../src/index.ts';
import type { Fetch, OpsCommand } from '../src/index.ts';
import { REPO, writer } from './fakes.ts';

const resync: OpsCommand = {
  id: 'accounts.resync',
  group: 'accounts',
  name: 'resync',
  summary: 'Resync',
  kind: 'write',
  fields: [{ name: 'accountId', type: 'id', required: true, description: '', positional: true }],
  dryRun: true,
  run: () => ({ result: { queued: 1 } }),
  preview: () => ({ result: { wouldQueue: 1 }, summary: 'would queue 1' }),
};

// The client talking to the real server helper, with no network.
function loopback(): Fetch {
  const github = writer();
  const handler = createOpsHandler({
    product: 'creatrgrid',
    repo: REPO,
    environment: 'production',
    commands: [resync],
    fetch: github.fetcher,
    logger: createLogger({ service: 't', fields: ['command', 'mode', 'outcome', 'durationMs'], sink: () => undefined }),
  });
  return (input, init) => handler(new Request(input, init), '/ops');
}

const BASE = 'https://api.example.com/ops';

describe('fetchCatalog', () => {
  it('returns the validated catalog', async () => {
    const catalog = await fetchCatalog(BASE, 'tok', loopback());
    expect(catalog.product).toBe('creatrgrid');
    expect(catalog.commands[0]?.id).toBe('accounts.resync');
  });

  it('tolerates a trailing slash on the base url', async () => {
    expect((await fetchCatalog(`${BASE}/`, 'tok', loopback())).version).toBe(1);
  });

  it('sends the token as a bearer', async () => {
    const seen: Array<string | null> = [];
    const fetcher: Fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return loopback()(input, init);
    };
    await fetchCatalog(BASE, 'tok', fetcher);
    expect(seen).toEqual(['Bearer tok']);
  });

  it('throws a typed error from the error shape', async () => {
    const fetcher: Fetch = async () =>
      Response.json({ error: { code: 'forbidden', message: 'write access to the repo is required' } }, { status: 403 });
    const error = await fetchCatalog(BASE, 'tok', fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsError);
    expect(error).toMatchObject({ code: 'forbidden', message: 'write access to the repo is required' });
  });

  it('throws internal for a response that is not contract v1', async () => {
    const wrongVersion: Fetch = async () =>
      Response.json({ version: 2, product: 'p', environment: 'e', commands: [] });
    const html: Fetch = async () => new Response('<html>bad gateway</html>', { status: 502 });
    await expect(fetchCatalog(BASE, 't', wrongVersion)).rejects.toMatchObject({ code: 'internal' });
    await expect(fetchCatalog(BASE, 't', html)).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('invoke', () => {
  it('previews and then runs a write', async () => {
    const fetcher = loopback();
    const preview = await invoke(BASE, 'tok', { command: 'accounts.resync', args: { accountId: 'a' }, mode: 'preview' }, fetcher);
    expect(preview).toEqual({ command: 'accounts.resync', mode: 'preview', result: { wouldQueue: 1 }, summary: 'would queue 1' });
    const run = await invoke(BASE, 'tok', { command: 'accounts.resync', args: { accountId: 'a' }, mode: 'run' }, fetcher);
    expect(run.result).toEqual({ queued: 1 });
  });

  it('throws the server error as an OpsError', async () => {
    const error = await invoke(BASE, 'tok', { command: 'accounts.resync', args: {}, mode: 'run' }, loopback()).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'OpsError', code: 'invalid_argument', message: "field 'accountId' is required" });
  });
});
