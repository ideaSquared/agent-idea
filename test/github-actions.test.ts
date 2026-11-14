import { describe, expect, it } from 'vitest';
import { jobLogTail, listRuns, runJobs, tailOf } from '../src/sources/github-actions.ts';

type Route = { status?: number; body?: unknown; text?: string; location?: string };

// A fetch that answers paths (and full URLs) from a table, recording each call and its Authorization header.
function fake(routes: Record<string, Route>) {
  const calls: Array<{ url: string; authorization: string | null; redirect?: RequestInit["redirect"] }> = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    const parsed = new URL(input);
    const route = routes[input] ?? routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (!route) return new Response('not found', { status: 404 });
    const headers = route.location ? { location: route.location } : undefined;
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200, headers });
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status ?? 200, headers });
  };
  return { fetcher, calls };
}

const REPO = 'ideaSquared/creatrgrid';
const run = (overrides: Record<string, unknown>) => ({
  id: 1,
  run_number: 7,
  name: 'CI',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  head_branch: 'main',
  head_sha: 'abcdef1234567890',
  created_at: '2026-11-14T20:00:00Z',
  html_url: 'https://github.com/ideaSquared/creatrgrid/actions/runs/1',
  display_title: 'fix: alex@example.com could not sign in',
  actor: { login: 'someone' },
  ...overrides,
});

describe('listRuns', () => {
  it('returns runs without titles or actors, and names only the default branch', async () => {
    const { fetcher, calls } = fake({
      [`/repos/${REPO}`]: { body: { default_branch: 'main' } },
      [`/repos/${REPO}/actions/runs`]: {
        body: { workflow_runs: [run({}), run({ id: 2, run_number: 8, head_branch: 'alex/fix-login', conclusion: 'success' })] },
      },
    });
    const runs = await listRuns(REPO, 'tok', { limit: 5, failed: false }, fetcher);
    expect(runs).toEqual([
      { id: 1, number: 7, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', branch: 'main', sha: 'abcdef1', createdAt: '2026-11-14T20:00:00Z', url: 'https://github.com/ideaSquared/creatrgrid/actions/runs/1' },
      { id: 2, number: 8, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'success', sha: 'abcdef1', createdAt: '2026-11-14T20:00:00Z', url: 'https://github.com/ideaSquared/creatrgrid/actions/runs/1' },
    ]);
    expect(JSON.stringify(runs)).not.toMatch(/alex|someone/);
    expect(calls.every((call) => call.authorization === 'Bearer tok')).toBe(true);
  });

  it('asks GitHub for failed runs only with failed', async () => {
    const { fetcher, calls } = fake({
      [`/repos/${REPO}`]: { body: { default_branch: 'main' } },
      [`/repos/${REPO}/actions/runs`]: { body: { workflow_runs: [] } },
    });
    await listRuns(REPO, 'tok', { limit: 3, failed: true }, fetcher);
    expect(calls.map((call) => call.url)).toContain(`https://api.github.com/repos/${REPO}/actions/runs?per_page=3&status=failure`);
  });

  it('throws when GitHub refuses', async () => {
    const { fetcher } = fake({ [`/repos/${REPO}`]: { status: 403, body: {} } });
    await expect(listRuns(REPO, 'tok', { limit: 3, failed: false }, fetcher)).rejects.toThrow('403');
  });
});

describe('runJobs', () => {
  it('lists jobs with their failed steps', async () => {
    const { fetcher } = fake({
      [`/repos/${REPO}/actions/runs/1/jobs`]: {
        body: {
          jobs: [
            { id: 10, name: 'test', status: 'completed', conclusion: 'failure', started_at: 'a', completed_at: 'b', steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Test', conclusion: 'failure' }] },
            { id: 11, name: 'deploy', status: 'completed', conclusion: 'skipped', started_at: null, completed_at: null },
          ],
        },
      },
    });
    expect(await runJobs(REPO, 'tok', 1, fetcher)).toEqual([
      { id: 10, name: 'test', status: 'completed', conclusion: 'failure', startedAt: 'a', completedAt: 'b', failedSteps: ['Test'] },
      { id: 11, name: 'deploy', status: 'completed', conclusion: 'skipped', startedAt: null, completedAt: null, failedSteps: [] },
    ]);
  });
});

describe('jobLogTail', () => {
  const log = ['2026-11-14T20:00:00.1234567Z \x1b[36;1mpnpm test\x1b[0m', '', '2026-11-14T20:00:01.0000000Z one', '2026-11-14T20:00:02.0000000Z two'].join('\n');

  it('follows the redirect without our token and returns the last lines, cleaned', async () => {
    const signed = 'https://pipelines.example.net/logs/10?sig=abc';
    const { fetcher, calls } = fake({
      [`/repos/${REPO}/actions/jobs/10/logs`]: { status: 302, location: signed },
      [signed]: { text: log },
    });
    expect(await jobLogTail(REPO, 'tok', 10, 2, fetcher)).toEqual(['one', 'two']);
    expect(calls[0]).toMatchObject({ authorization: 'Bearer tok', redirect: 'manual' });
    expect(calls[1]).toMatchObject({ url: signed, authorization: null });
  });

  it('strips timestamps and colour codes', async () => {
    const { fetcher } = fake({ [`/repos/${REPO}/actions/jobs/10/logs`]: { text: log } });
    expect(await jobLogTail(REPO, 'tok', 10, 10, fetcher)).toEqual(['pnpm test', 'one', 'two']);
  });
});

describe('runJobs paging', () => {
  it('follows pages until every job is collected', async () => {
    const job = (id: number) => ({ id, name: `j${id}`, status: 'completed', conclusion: 'success', started_at: null, completed_at: null });
    const first = Array.from({ length: 100 }, (_, i) => job(i));
    const { fetcher, calls } = fake({
      [`/repos/${REPO}/actions/runs/1/jobs?per_page=100&page=1`]: { body: { total_count: 101, jobs: first } },
      [`/repos/${REPO}/actions/runs/1/jobs?per_page=100&page=2`]: { body: { total_count: 101, jobs: [job(100)] } },
    });
    const jobs = await runJobs(REPO, 'tok', 1, fetcher);
    expect(jobs).toHaveLength(101);
    expect(calls).toHaveLength(2);
  });
});

describe('tailOf', () => {
  const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
        controller.close();
      },
    });

  it('keeps only the last lines of a long log, across chunk boundaries', async () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n');
    const chunks = lines.match(/[\s\S]{1,777}/g) ?? [];
    expect(await tailOf(streamOf(chunks), 3)).toEqual(['line 9997', 'line 9998', 'line 9999']);
  });

  it('cuts a huge line instead of holding it', async () => {
    const [line] = await tailOf(streamOf(['x'.repeat(50_000), '\n']), 1);
    expect(line).toHaveLength(4000);
  });
});
