// Path segments a workspace id may never be (roadmap 8.3). Local network services answer at /<workspace>/<service>/
// ahead of every route of ours (routes/proxy.js), so a workspace named like one of our paths could put a service in
// front of our scripts (/js/...), the agent's install script (/infrastructure/...), the webhooks (/hooks/...) or the
// sign-in API (/services/...). Workspace ids come from team names (accounts.js freeWorkspaceId), which skip these, and
// the proxy ignores them in case an older workspace has one.
//
// test/security.test.js walks the app's routers and public/ and fails when a segment is missing here. Reserving more
// than the top level needs costs nothing: a team called "Products" gets "products-2".
export const RESERVED_SEGMENTS = new Set([
  // Our pages, files and mounts.
  'w', 'new', 'api', 'admin', 'infrastructure', 'services', 'ui', 'hooks', 'health', 'dev', 'auth', 'css', 'js',
  'images', 'fonts', 'assets', 'static', 'public', 'index.html', 'favicon.ico', 'robots.txt',
  // Signing in and accounts.
  'signin', 'signup', 'signout', 'login', 'logout', 'verify-email', 'reset-password', 'forgot-password', 'invite',
  'invitations', 'account', 'me', 'settings', 'workspace', 'workspaces', 'oauth', 'github',
  // The accelerators' paths (customers, payments, infrastructure), wherever they are mounted.
  'about', 'accounts', 'actions', 'activity', 'agent', 'audit', 'c', 'campaigns', 'capacity', 'catalog', 'channels',
  'check', 'communications', 'config', 'connections', 'cost', 'credit-notes', 'customers', 'dunning', 'events',
  'hosts', 'ingress', 'invoices', 'marketing', 'messages', 'meters', 'mock', 'my-ip', 'o', 'openapi.json',
  'organizations', 'overview', 'p', 'payments', 'pools', 'prices', 'products', 'provider', 'push', 'reconciliation',
  'reference', 'refunds', 'seed', 'servers', 'sites', 'subscriptions', 'summary', 'suppressions', 'tax-rates',
  'templates', 'tenants', 'topics', 'transactional', 'u', 'usage', 'webhooks', 'billing',
  // Kept for later, and the names people expect a service like ours to own.
  'www', 'docs', 'help', 'support', 'status', 'blog', 'pricing', 'well-known', 'sitemap.xml', 'security', 'legal',
]);

/** True when `segment` (a workspace id, or the first part of a path) is one of ours. */
export const isReserved = (segment) => RESERVED_SEGMENTS.has(String(segment ?? '').toLowerCase());
