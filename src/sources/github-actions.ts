import { z } from 'zod';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// A workflow run, reduced to what helps debugging. No commit message, PR title or actor: free text and people.
export type RunSummary = {
  id: number;
  number: number;
  workflow: string;
  event: string;
  status: string;
  conclusion: string | null;
  // Only when the run is on the default branch; other branch names can name people.
  branch?: string;
  sha: string;
  createdAt: string;
  url: string;
};

export type JobSummary = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedSteps: string[];
};

const RepoSchema = z.object({ default_branch: z.string() });
const RunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      run_number: z.number(),
      name: z.string().nullable(),
      event: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      created_at: z.string(),
      html_url: z.string(),
    }),
  ),
});
const JobsSchema = z.object({
  total_count: z.number().default(0),
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      started_at: z.string().nullable(),
      completed_at: z.string().nullable(),
      steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })).optional(),
    }),
  ),
});

function github(token: string, fetcher: Fetch, path: string, init: RequestInit = {}): Promise<Response> {
  return fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-idea',
      'x-github-api-version': '2022-11-28',
    },
  });
}

async function getJson(token: string, fetcher: Fetch, path: string): Promise<unknown> {
  const response = await github(token, fetcher, path);
  if (!response.ok) throw new Error(`GitHub ${path.split('?')[0]} answered ${response.status}`);
  return response.json();
}

export async function listRuns(
  repo: string,
  token: string,
  options: { limit: number; failed: boolean },
  fetcher: Fetch,
): Promise<RunSummary[]> {
  const query = new URLSearchParams({
    per_page: String(options.limit),
    ...(options.failed ? { status: 'failure' } : {}),
  });
  const [repoBody, runsBody] = await Promise.all([
    getJson(token, fetcher, `/repos/${repo}`),
    getJson(token, fetcher, `/repos/${repo}/actions/runs?${query}`),
  ]);
  const { default_branch: defaultBranch } = RepoSchema.parse(repoBody);
  return RunsSchema.parse(runsBody).workflow_runs.map((run) => ({
    id: run.id,
    number: run.run_number,
    workflow: run.name ?? 'workflow',
    event: run.event,
    status: run.status ?? 'unknown',
    conclusion: run.conclusion,
    ...(run.head_branch === defaultBranch ? { branch: defaultBranch } : {}),
    sha: run.head_sha.slice(0, 7),
    createdAt: run.created_at,
    url: run.html_url,
  }));
}

// GitHub pages jobs 100 at a time; a big matrix run can have more. Stop at a sane ceiling.
const JOB_PAGE = 100;
const MAX_JOB_PAGES = 10;

async function allJobs(
  repo: string,
  token: string,
  runId: number,
  fetcher: Fetch,
  page = 1,
): Promise<z.infer<typeof JobsSchema>['jobs']> {
  const body = await getJson(
    token,
    fetcher,
    `/repos/${repo}/actions/runs/${runId}/jobs?per_page=${JOB_PAGE}&page=${page}`,
  );
  const { jobs, total_count: total } = JobsSchema.parse(body);
  if (jobs.length < JOB_PAGE || page * JOB_PAGE >= total || page >= MAX_JOB_PAGES) return jobs;
  return [...jobs, ...(await allJobs(repo, token, runId, fetcher, page + 1))];
}

export async function runJobs(repo: string, token: string, runId: number, fetcher: Fetch): Promise<JobSummary[]> {
  return (await allJobs(repo, token, runId, fetcher)).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    failedSteps: (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name),
  }));
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
// ANSI colour codes, which CI logs are full of.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// A line longer than this is cut before anything else is done with it, so one huge line can't use up memory.
const MAX_RAW_LINE = 4000;

function clean(line: string): string {
  return line.replace(TIMESTAMP, '').replace(ANSI, '');
}

// Reads a text stream and keeps only its last `lines` non-empty lines, so memory stays bounded however long the
// log is. A line that goes past MAX_RAW_LINE is cut there.
export async function tailOf(stream: ReadableStream<Uint8Array>, lines: number): Promise<string[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const kept: string[] = [];
  let partial = '';
  const keep = (line: string): void => {
    const cleaned = clean(line.slice(0, MAX_RAW_LINE)).replace(/\r$/, '');
    if (cleaned.trim() === '') return;
    kept.push(cleaned);
    if (kept.length > lines) kept.shift();
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parts = (partial + value).split('\n');
    partial = (parts.pop() ?? '').slice(0, MAX_RAW_LINE);
    parts.forEach(keep);
  }
  keep(partial);
  return kept;
}

// The last `lines` lines of a job's log, without timestamps or colour codes. Not yet sanitised.
export async function jobLogTail(
  repo: string,
  token: string,
  jobId: number,
  lines: number,
  fetcher: Fetch,
): Promise<string[]> {
  // GitHub answers with a redirect to a signed download URL, which must be fetched without our token.
  const response = await github(token, fetcher, `/repos/${repo}/actions/jobs/${jobId}/logs`, { redirect: 'manual' });
  const location = response.headers.get('location');
  const logResponse = response.status >= 300 && response.status < 400 && location ? await fetcher(location) : response;
  if (!logResponse.ok) throw new Error(`GitHub job log answered ${logResponse.status}`);
  if (!logResponse.body) return [];
  return tailOf(logResponse.body, lines);
}
