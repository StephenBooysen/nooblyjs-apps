// Static Sites (roadmap 5.1, 5.2; infra spec 8.8), offline with the in-process mock agent: create one on the Local
// network with a publish directory; its build runs once, its files are uploaded and the site switches to them; it
// answers at <base>/<workspace>/<name>/ with the platform's cache headers, ETags, redirects and _headers, sandboxed,
// with our cookies kept from it; requests, bandwidth and cache hits are counted for the Bandwidth and Cache hit rate
// meters; single-page app applies at once; a deploy is served whole; a rollback serves an earlier deploy's files at
// once; the seeded storefront has its meters. Another workspace, or a service that is not a Static Site, is a 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
const WS = '/api/v1/workspaces/exclusivity-life';
const SVC = `${WS}/services/docs`;
const infra = () => t.accelerators.mounted.infrastructure;
const docker = () => infra().local.agent.docker;
const settle = async () => { for (let i = 0; i < 4; i += 1) await t.idle(); };
const body = (over = {}) => ({
  type: 'static', name: 'docs', repoUrl: 'https://github.com/render-examples/create-react-app', branch: 'main',
  region: 'local', runtime: 'node22', buildCommand: 'npm ci && npm run build', publishDir: 'build', env: [{ key: 'API_URL', value: 'https://api.example.com' }], ...over,
});
let version = 1;

before(async () => {
  t = await startApp({ seed: true });
  await infra().local.agent.welcome;
  docker().siteFiles(() => [
    { path: 'index.html', data: `<!doctype html><title>Docs</title><h1>v${version}</h1><script src="./assets/app-Ab12cd${version}9.js"></script>` },
    { path: `assets/app-Ab12cd${version}9.js`, data: `console.log(${version})` },
    { path: 'guide/index.html', data: 'guide' },
    { path: '404.html', data: 'not here' },
    { path: '_redirects', data: '/old /guide/ 301\n' },
    { path: '_headers', data: '/*\n  X-Frame-Options: DENY\n' },
  ]);
});
after(async () => { await t?.close(); });

test('5.2 create: the publish directory is checked and kept; the build gets its variables and BASE_PATH; the files go live', async () => {
  for (const [over, path] of [[{ publishDir: '../up' }, 'publishDir'], [{ publishDir: '/abs' }, 'publishDir'], [{ spa: 'yes' }, 'spa']]) {
    const r = await t.post(`${WS}/services`, { as: 'stevie', body: body(over) });
    assert.equal(r.status, 422, JSON.stringify(over));
    assert.ok(r.json.error.details.some((d) => d.path === path), JSON.stringify(r.json.error.details));
  }
  const res = await t.post(`${WS}/services`, { as: 'stevie', body: body() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await settle();
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.type, svc.status, svc.build.publishDir, svc.spa, svc.url], ['static', 'live', 'build', false, `${t.base}/exclusivity-life/docs/`]);
  const w = await t.platform().workloads.get('exclusivity-life', 'docs');
  assert.deepEqual([w.kind, w.build.publishDir, w.site.spa], ['static', 'build', false]);
  assert.deepEqual(w.run.env.map((e) => [e.key, e.build, e.value ?? 'secret']), [['API_URL', true, 'secret'], ['BASE_PATH', true, '/exclusivity-life/docs/']]);
  assert.deepEqual(docker().exports.map((e) => e.dir), ['build']);
  assert.equal(docker().state.containers.filter((c) => c.labels['noobly-workload'] === 'docs').length, 0, 'nothing runs');
  const [d] = svc.deploys;
  assert.deepEqual([d.status, d.trigger], ['live', 'manual']);
  assert.ok(d.startedAt && d.endedAt && d.startedAt <= d.endedAt, `a first deploy has its start: ${d.startedAt} → ${d.endedAt}`);
  const log = (await t.get(`${SVC}/deploys/${d.id}`, { as: 'stevie' })).json.log.map((l) => l.text).join('\n');
  assert.match(log, /Uploaded 4 files/);
  assert.match(log, /Serving the new files/);
});

test('5.1 the site answers under its path: cache headers, ETag, redirects under the prefix, _headers, 404.html, sandboxed', async () => {
  const site = `${t.base}/exclusivity-life/docs`;
  let r = await fetch(`${site}/`, { headers: { cookie: 'hero.sid=secret; theirs=1' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<h1>v1<\/h1>/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /^sandbox /);
  assert.equal(r.headers.get('set-cookie'), null);
  const etag = r.headers.get('etag');
  assert.equal((await fetch(`${site}/`, { headers: { 'if-none-match': etag } })).status, 304);
  r = await fetch(`${site}/assets/app-Ab12cd19.js`);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  r = await fetch(`${site}/old?x=1`, { redirect: 'manual' });
  assert.deepEqual([r.status, r.headers.get('location')], [301, '/exclusivity-life/docs/guide/?x=1']);
  r = await fetch(`${site}/guide`, { redirect: 'manual' });
  assert.deepEqual([r.status, r.headers.get('location')], [301, '/exclusivity-life/docs/guide/']);
  r = await fetch(`${site}/missing`);
  assert.deepEqual([r.status, await r.text()], [404, 'not here']);
  assert.equal((await fetch(site, { redirect: 'manual' })).status, 308, 'no trailing slash: sent to the path with one');

  // Counted: requests, bytes, and the 304 and memory-cache answers as hits.
  await t.telemetry?.idle?.();
  const site_ = (await t.get(`${SVC}/site`, { as: 'stevie' })).json.site;
  assert.ok(site_.month.requests >= 6 && site_.month.bytes > 0, JSON.stringify(site_.month));
  assert.ok(site_.month.hits >= 1 && site_.month.hitRate > 0 && site_.month.hitRate <= 1);
  const dash = (await t.get(`${WS}/dashboard`, { as: 'stevie' })).json;
  const card = dash.cards.find((s) => s.name === 'docs');
  assert.deepEqual(Object.keys(card.site).sort(), ['hitRate', 'hits', 'includedBytes', 'monthBytes', 'requests']);
  assert.equal(card.site.includedBytes, 100e9);
});

test('5.2 single-page app at once; a new publish directory builds again; a deploy is served whole; rollback is at once', async () => {
  const site = `${t.base}/exclusivity-life/docs`;
  assert.equal((await fetch(`${site}/app/route`)).status, 404);
  let r = await t.patch(`${SVC}/site`, { as: 'stevie', body: { spa: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.operation, r.json.site.spa], [null, true]);
  assert.match(await (await fetch(`${site}/app/route`)).text(), /<h1>v1<\/h1>/);
  assert.equal((await t.patch(`${SVC}/site`, { as: 'stevie', body: { publishDir: '../x' } })).status, 422);

  // A new deploy (from a changed publish directory): all new files, none of the old.
  version = 2;
  r = await t.patch(`${SVC}/site`, { as: 'stevie', body: { publishDir: 'dist' } });
  assert.ok(r.json.operation, 'a new publish directory deploys again');
  await settle();
  assert.match(await (await fetch(`${site}/`)).text(), /<h1>v2<\/h1>/);
  assert.equal((await fetch(`${site}/assets/app-Ab12cd19.js`)).status, 404);
  assert.deepEqual(docker().exports.map((e) => e.dir), ['build', 'dist']);

  const info = (await t.get(`${SVC}/site`, { as: 'stevie' })).json.site;
  assert.equal(info.kept.length, 2);
  const first = info.kept.find((d) => d.deployId !== info.serving.deployId);
  assert.equal((await t.post(`${SVC}/rollback`, { as: 'stevie', body: { deploy: info.serving.deployId } })).status, 409);
  assert.equal((await t.post(`${SVC}/rollback`, { as: 'stevie', body: { deploy: 'dep_nope' } })).status, 404);
  r = await t.post(`${SVC}/rollback`, { as: 'stevie', body: { deploy: first.deployId } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.deploy.status, 'live');
  assert.match(await (await fetch(`${site}/`)).text(), /<h1>v1<\/h1>/);
  await settle();
  const svc = (await t.get(SVC, { as: 'stevie' })).json;
  assert.deepEqual([svc.deploys[0].trigger, svc.deploys[0].status, svc.current.deployId], ['rollback', 'live', r.json.deploy.id]);
  assert.equal(svc.deploys.filter((d) => d.status === 'live').length, 1, 'the deploy before is superseded');
});

test('5.2 another workspace, or a service that is not a Static Site, is a 404; the seeded storefront has its meters', async () => {
  assert.equal((await t.get(`${SVC}/site`, { as: 'amara' })).status, 404);
  assert.equal((await t.post(`${SVC}/rollback`, { as: 'amara', body: { deploy: 'x' } })).status, 404);
  assert.equal((await t.get(`${WS}/services/api/site`, { as: 'stevie' })).status, 404);
  assert.equal((await t.patch(`${WS}/services/api/site`, { as: 'stevie', body: { spa: true } })).status, 404);
  const store = (await t.get(`${WS}/services/storefront/site`, { as: 'stevie' })).json.site;
  assert.deepEqual([store.publishDir, store.serving.deployId, store.serving.commit, store.serving.files], ['dist', 'dep_seedsto01', '3be19f4', 4]);
  const card = (await t.get(`${WS}/dashboard`, { as: 'stevie' })).json.cards.find((s) => s.name === 'storefront');
  assert.deepEqual([card.type, card.site.includedBytes, card.site.hitRate], ['static', 100e9, null]);
});
