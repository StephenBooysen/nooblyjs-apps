// Workspace isolation (roadmap 1.6; product.md §10: no customer can see, reach or affect another workspace). Started in
// Phase 1 and extended every phase: it walks every route of the workspace API router and every workspace page, so a
// route added later is covered without editing this file. A non-member must get a 404 (never a 403, never data).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startApp, cookieJar } from './helpers.js';
import { createWorkspacesApi } from '../src/routes/workspaces.js';
import { WORKSPACE_PAGES, SERVICE_TYPES } from '../src/routes/pages.js';

let t;
before(async () => { t = await startApp(); });
after(async () => { await t?.close(); });

/** Every route of the workspace API router: [method, path]. */
function workspaceRoutes() {
  const noop = (req, res, next) => next();
  const router = createWorkspacesApi({ express, session: { requireWorkspace: noop, requireOwner: noop, auth: noop }, accounts: {}, link: {}, config: {}, audit: async () => {}, realtime: {} });
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.push([method.toUpperCase(), layer.route.path]);
  }
  return out.filter(([, p]) => p.includes(':workspace'));
}

test('the walk finds the workspace API (so the checks below are not vacuous)', () => {
  const routes = workspaceRoutes();
  assert.ok(routes.length >= 6, `found ${routes.length}`);
  assert.ok(routes.some(([m, p]) => m === 'DELETE' && p.endsWith('/members/:person')));
});

test('a signed-up stranger reaches nothing of another workspace: every API route and every page is a 404', async () => {
  const jar = cookieJar();
  const res = await t.post('/api/v1/auth/signup', { jar, headers: { origin: t.base }, body: { name: 'Mallory', team: 'Mallory Inc', email: 'mallory@evil.example', password: 'let me in please 1' } });
  assert.equal(res.status, 201);
  const csrf = { origin: t.base };

  for (const [method, path] of workspaceRoutes()) {
    const url = `/api/v1${path.replace(':workspace', 'exclusivity-life').replace(/:[a-z]+/g, 'x')}`;
    const r = await t.call(method, url, { jar, headers: csrf, ...(method === 'GET' || method === 'DELETE' ? {} : { body: { name: 'pwned', email: 'mallory@evil.example' } }) });
    assert.equal(r.status, 404, `${method} ${url} → ${r.status}`);
    assert.doesNotMatch(r.text, /Exclusivity Life|stevie/i, `${method} ${url} leaks nothing`);
  }

  const pages = [...WORKSPACE_PAGES.map((p) => `/w/exclusivity-life${p}`), ...SERVICE_TYPES.map((s) => `/w/exclusivity-life/new/${s}`), '/w/exclusivity-life/services/api'];
  for (const url of pages) assert.equal((await t.get(url, { jar })).status, 404, url);

  // A workspace that does not exist looks the same as one that does.
  assert.equal((await t.get('/api/v1/workspaces/does-not-exist', { jar })).status, 404);
  assert.deepEqual((await t.get('/api/v1/workspaces/does-not-exist', { jar })).json, (await t.get('/api/v1/workspaces/exclusivity-life', { jar })).json);

  // Nothing changed.
  assert.equal((await t.accounts.getWorkspace('exclusivity-life')).name, 'Exclusivity Life');
  assert.deepEqual((await t.accounts.membersOf('exclusivity-life')).map((m) => m.personId), ['stevie']);
});

test('signed out, the workspace API is a 401 and the pages send you to sign in', async () => {
  for (const [method, path] of workspaceRoutes()) {
    const url = `/api/v1${path.replace(':workspace', 'exclusivity-life').replace(/:[a-z]+/g, 'x')}`;
    const r = await t.call(method, url, { headers: { origin: t.base }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
  assert.match((await t.get('/w/exclusivity-life/settings')).location, /^\/signin\?next=/);
});

test('operators are not workspace members: the back office does not open customer workspaces', async () => {
  assert.equal((await t.get('/w/exclusivity-life', { as: 'ops-platform' })).status, 404);
  assert.equal((await t.get('/api/v1/workspaces/exclusivity-life', { as: 'ops-support' })).status, 404);
});

test('customers cannot reach nooblyjs-core\'s /services portal or its login API', async () => {
  for (const url of ['/services/', '/services/authservice/api/status']) assert.equal((await t.get(url, { as: 'stevie' })).status, 404, url);
  assert.equal((await t.post('/services/authservice/api/login', { as: 'stevie', body: { email: 'stevie@exclusivity.life', password: 'x' } })).status, 404);
  assert.equal((await t.get('/services/', { as: 'ops-support' })).status, 404, 'support operators neither');
});
