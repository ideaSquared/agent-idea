export type Project = {
  // Write access to this repo unlocks the project's logs.
  repo: string;
  // Cloudflare Worker script names whose Workers Logs belong to the project.
  workers: readonly string[];
};

export const PROJECTS: Readonly<Record<string, Project>> = {
  ads: { repo: 'ideaSquared/adopt-dont-shop', workers: [] },
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
