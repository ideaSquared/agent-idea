export const ENVIRONMENTS = ['staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type Project = {
  // Write access to this repo unlocks the project's logs.
  repo: string;
  // Cloudflare Worker script names whose Workers Logs belong to the project.
  workers: readonly string[];
  // Which of those Workers serve each environment. Absent when the project cannot tell environments apart, and
  // then `--env` is refused rather than returning everything. A Worker not listed here (for example one whose
  // name does not say its environment) is never returned for a filtered query.
  environments?: Readonly<Record<Environment, readonly string[]>>;
  // Where the project's logs live when they are not in Workers Logs.
  logs?: 'loki';
  // The project's error tracker, if it has one.
  errors?: 'glitchtip';
};

// The message for a project whose logs or errors cannot be narrowed to one environment.
export function noEnvironments(name: string): string {
  return `Project '${name}' has no way to tell environments apart, so --env is not available`;
}

export const PROJECTS: Readonly<Record<string, Project>> = {
  // ADS logs and errors cannot be split by environment: both services run NODE_ENV=production on staging and prod,
  // so Loki's `env` label and GlitchTip's environment read `production` on both. No `environments` here.
  ads: { repo: 'ideaSquared/adopt-dont-shop', workers: [], logs: 'loki', errors: 'glitchtip' },
  creatrgrid: {
    repo: 'ideaSquared/creatrgrid',
    workers: [
      'creatorgrid-api',
      'creatorgrid-api-staging',
      'creatorgrid-web',
      'creatorgrid-web-staging',
      'creatorgrid-dashboard',
      'creatorgrid-dashboard-staging',
      'creatorgrid-admin',
      'creatorgrid-admin-staging',
    ],
    // Production Workers carry no suffix; staging ones end in -staging.
    environments: {
      staging: ['creatorgrid-api-staging', 'creatorgrid-web-staging', 'creatorgrid-dashboard-staging', 'creatorgrid-admin-staging'],
      production: ['creatorgrid-api', 'creatorgrid-web', 'creatorgrid-dashboard', 'creatorgrid-admin'],
    },
  },
  gaminginit: { repo: 'ideaSquared/gaminginit', workers: ['wardogs-community-site'] },
  'gaminginit-bot': { repo: 'ideaSquared/gaminginit-bot', workers: ['wardogs-discord-bot'] },
  'ideasquared-bot': { repo: 'ideaSquared/ideasquared-bot', workers: ['ideasquared-bot'] },
  pairflix: {
    repo: 'ideaSquared/pairflix',
    workers: ['pairflix-api', 'pairflix-api-staging', 'pairflix-api-production', 'pairflix-client', 'pairflix-admin'],
    // Only Workers whose name says the environment. pairflix-api, -client and -admin are ambiguous, so they are
    // left out of filtered queries.
    environments: { staging: ['pairflix-api-staging'], production: ['pairflix-api-production'] },
  },
};
