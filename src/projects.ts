export const ENVIRONMENTS = ['staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type Project = {
  // Active membership of this team in the ideaSquared org unlocks the project's logs, errors and runs.
  team: string;
  // The project's repo, whose GitHub Actions runs are read with the caller's token.
  repo: string;
  // Cloudflare Worker script names whose Workers Logs belong to the project.
  workers: readonly string[];
  // Which of those Workers serve each environment. Absent when the project cannot tell environments apart, and
  // then `--env` is refused rather than returning everything. A Worker not listed here (for example one whose
  // name does not say its environment) is never returned for a filtered query.
  environments?: Readonly<Record<Environment, readonly string[]>>;
  // For a project whose logs and errors come from one server, the only environment that server serves. `--env` for
  // it is allowed and passed to the source as a filter, and `--env` for the other environment is refused without
  // calling the source.
  reachable?: Environment;
  // Where the project's logs live when they are not in Workers Logs.
  logs?: 'loki';
  // The project's error tracker, if it has one.
  errors?: 'glitchtip';
};

// The message for a project whose logs or errors cannot be narrowed to one environment.
export function noEnvironments(name: string): string {
  return `Project '${name}' has no way to tell environments apart, so --env is not available`;
}

// The message for an environment of a project whose source only serves the other one.
export function notReachable(name: string, environment: Environment): string {
  return `The ${environment} logs and errors for '${name}' are not reachable through Agent Idea yet: only the staging server's Loki and GlitchTip are behind the tunnel`;
}

// The GitHub org that owns every project's team.
export const ORG = 'ideaSquared';

export const PROJECTS: Readonly<Record<string, Project>> = {
  // ADS's Loki `env` label and GlitchTip `environment` carry DEPLOY_ENV (staging | production). Only the staging
  // server's Loki and GlitchTip are behind the tunnel (docs/ads-tunnel.md), so only `--env staging` is served.
  ads: {
    team: 'adoptdontshop',
    repo: 'ideaSquared/adopt-dont-shop',
    workers: [],
    logs: 'loki',
    errors: 'glitchtip',
    reachable: 'staging',
  },
  // agent-idea's own Worker. It has no staging, so `--env staging` finds nothing.
  'agent-idea': {
    team: 'ops-platform',
    repo: 'ideaSquared/agent-idea',
    workers: ['agent-idea'],
    environments: { staging: [], production: ['agent-idea'] },
  },
  creatrgrid: {
    team: 'creatrgrid',
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
      staging: [
        'creatorgrid-api-staging',
        'creatorgrid-web-staging',
        'creatorgrid-dashboard-staging',
        'creatorgrid-admin-staging',
      ],
      production: ['creatorgrid-api', 'creatorgrid-web', 'creatorgrid-dashboard', 'creatorgrid-admin'],
    },
  },
  gaminginit: { team: 'gaminginit', repo: 'ideaSquared/gaminginit', workers: ['wardogs-community-site'] },
  'gaminginit-bot': { team: 'gaminginit', repo: 'ideaSquared/gaminginit-bot', workers: ['wardogs-discord-bot'] },
  'ideasquared-bot': { team: 'ops-platform', repo: 'ideaSquared/ideasquared-bot', workers: ['ideasquared-bot'] },
  pairflix: {
    team: 'pairflix',
    repo: 'ideaSquared/pairflix',
    workers: ['pairflix-api', 'pairflix-api-staging', 'pairflix-api-production', 'pairflix-client', 'pairflix-admin'],
    // Only Workers whose name says the environment. pairflix-api, -client and -admin are ambiguous, so they are
    // left out of filtered queries.
    environments: { staging: ['pairflix-api-staging'], production: ['pairflix-api-production'] },
  },
};
