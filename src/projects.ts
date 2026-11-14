export type Project = {
  // Write access to this repo unlocks the project's logs.
  repo: string;
  // Cloudflare Worker script names whose Workers Logs belong to the project.
  workers: readonly string[];
  // Where the project's logs live when they are not in Workers Logs.
  logs?: 'loki';
  // The project's error tracker, if it has one.
  errors?: 'glitchtip';
};

export const PROJECTS: Readonly<Record<string, Project>> = {
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
  },
  gaminginit: { repo: 'ideaSquared/gaminginit', workers: ['wardogs-community-site'] },
  'gaminginit-bot': { repo: 'ideaSquared/gaminginit-bot', workers: ['wardogs-discord-bot'] },
  'ideasquared-bot': { repo: 'ideaSquared/ideasquared-bot', workers: ['ideasquared-bot'] },
  pairflix: {
    repo: 'ideaSquared/pairflix',
    workers: ['pairflix-api', 'pairflix-api-staging', 'pairflix-api-production', 'pairflix-client', 'pairflix-admin'],
  },
};
