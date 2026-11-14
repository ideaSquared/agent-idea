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
  const query = new URLSearchParams({ per_page: String(options.limit), ...(options.failed ? { status: 'failure' } : {}) });
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

export async function runJobs(repo: string, token: string, runId: number, fetcher: Fetch): Promise<JobSummary[]> {
  const body = await getJson(token, fetcher, `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  return JobsSchema.parse(body).jobs.map((job) => ({
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

// The last `lines` lines of a job's log, without timestamps or colour codes. Not yet sanitised.
export async function jobLogTail(repo: string, token: string, jobId: number, lines: number, fetcher: Fetch): Promise<string[]> {
  // GitHub answers with a redirect to a signed download URL, which must be fetched without our token.
  const response = await github(token, fetcher, `/repos/${repo}/actions/jobs/${jobId}/logs`, { redirect: 'manual' });
  const location = response.headers.get('location');
  const logResponse = response.status >= 300 && response.status < 400 && location ? await fetcher(location) : response;
  if (!logResponse.ok) throw new Error(`GitHub job log answered ${logResponse.status}`);
  const text = await logResponse.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, '').replace(ANSI, ''))
    .filter((line) => line.trim() !== '')
    .slice(-lines);
}
