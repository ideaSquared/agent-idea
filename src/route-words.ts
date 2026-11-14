// Path segments that may appear in a sanitised route. Any segment not listed here becomes :param,
// so a slug that is a person's name (/creators/alex) never leaves. Built from the route definitions
// in each product repo; add a word when a real route shows up as :param and you want to see it.
export const ROUTE_WORDS: ReadonlySet<string> = new Set([
  // shared
  'api', 'admin', 'auth', 'health', 'ready', 'metrics', 'docs', 'webhook', 'callback', 'public',
  'login', 'logout', 'register', 'refresh', 'refresh-token', 'csrf-token', 'me', 'users', 'user',
  'settings', 'preferences', 'status', 'stats', 'search', 'export', 'bulk', 'batch', 'config',
  // ideasquared-bot
  'ads', 'pairflix', 'creatrgrid', 'gaminginit', 'ideasquared', 'ship',
  // creatrgrid
  'accounts', 'analytics', 'approve', 'approve-domain', 'attention', 'audit-log', 'audit-logs',
  'avatar', 'avatars', 'billing', 'bootstrap-admin', 'by-domain', 'cancel', 'check', 'checkout',
  'clear', 'clear-review', 'confirm', 'connect', 'content', 'creator', 'creators', 'dashboard-stats',
  'deck', 'demo', 'disable', 'dismiss', 'domain', 'email', 'enroll', 'flag', 'force-password-reset',
  'force-reverify', 'forgot-password', 'invites', 'latest-token', 'locked-accounts', 'options',
  'password', 'plan', 'platforms', 'portal', 'promote-admin', 'read', 'remove', 'reports', 'resend',
  'resend-verification', 'reset-2fa', 'reset-password', 'resync', 'send-password-reset', 'sessions',
  'set', 'social', 'social-accounts', 'sources', 'suspend', 'thumbnails', 'unlock', 'unsuspend',
  'username', 'verify', 'verify-email', 'site', 'sites',
  // pairflix
  'entitlements', 'households', 'pick', 'pick-events', 'taste-onboarding', 'history', 'providers',
  // gaminginit and gaminginit-bot
  'account', 'coins', 'go', 'discord', 'steam', 'player', 'players', 'live', 'socket', 'lifetime',
  'review', 'season', 'shame', 'vote', 'rotation', 'matches', 'match', 'leaderboard',
  // adopt-dont-shop gateway
  'accept', 'acknowledge', 'action', 'actions', 'active', 'activity', 'adopt', 'adoption-metrics',
  'adoption-policies', 'announcements', 'answers', 'appeal', 'application', 'application-analytics',
  'application-defaults', 'application-preferences', 'applications', 'assign', 'assign-role', 'audit',
  'auth-token', 'backup-codes', 'breeds', 'broadcast', 'bulk-update', 'change-password', 'chats',
  'cleanup', 'cms', 'colleagues', 'complete', 'completion', 'confirm-email-change', 'consent',
  'conversations', 'cookies', 'cookies-consent', 'count', 'csv', 'dashboard', 'deactivate', 'defaults',
  'delete-request', 'details', 'devices', 'discovery', 'dnd', 'documents', 'drafts', 'email-change',
  'email-report', 'enable', 'end', 'enquiries', 'erasure-request', 'escalate', 'events', 'execute',
  'facets', 'favorite', 'favorites', 'featured', 'field-permissions', 'followed', 'foster',
  'home-visit', 'home-visits', 'images', 'inbox', 'invitation-token', 'invitations', 'ip-rules',
  'legal', 'lock', 'login-history', 'mark-read', 'matching', 'menus', 'messages', 'moderation',
  'moderator', 'my-tickets', 'notes', 'notifications', 'pageviews', 'pdf', 'pending-reacceptance',
  'permissions', 'pet', 'pet-performance', 'pets', 'placements', 'privacy', 'process', 'profile',
  'provider-info', 'publish', 'questions', 'queue', 'quick-application', 'reactions', 'reactivate',
  'read-all', 'redeem-invitation', 'references', 'regenerate', 'reject', 'reorder', 'reply', 'report',
  'rescue', 'rescues', 'reset', 'responses', 'restore', 'role', 'rule', 'sanctions', 'schedule',
  'schedules', 'security', 'send-email', 'session', 'setup', 'share', 'shared', 'shares', 'similar',
  'stage-distribution', 'stale', 'statistics', 'submit', 'suggestions', 'support', 'suspicious-activity',
  'swipe', 'swipes', 'targets', 'templates', 'terms', 'tickets', 'timeline', 'top-picks', 'unread',
  'unread-count', 'uploads', 'uploads-signed', 'user-invitation-token', 'versions', 'view', 'widgets',
  'with-permissions', 'withdraw',
]);
