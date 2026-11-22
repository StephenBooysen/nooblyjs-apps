// Postgres and Key Value (roadmap 6.1–6.4; infra specs 8.6, 8.7), offline with the in-process mock agent and the
// stand-in Postgres engine: create both on the Local network and in Johannesburg (the mock cloud), see their connection
// details, meters, backups and plan; reveal the connection string (typed name, audited); back up and restore into a new
// database; link them to the seeded api and to a Local network service, which gets DATABASE_URL and REDIS_URL from the
// platform when it starts (through the relay on the workspace's own network); and confirm another workspace can neither
// see, reveal nor link them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
const WS = '/api/v1/workspaces/exclusivity-life';
const infra = () => t.accelerators.mounted.infrastructure;
const docker = () => infra().local.agent.docker;
const settle = async () => { for (let i = 0; i < 4; i += 1) await t.idle(); };

before(async () => {
  t = await startApp({ seed: true });
  await infra().local.agent.welcome;
  await settle();
});
after(async () => { await t?.close(); });

test('6.2/6.3 the seeded database and cache are on the platform, live, with meters on the dashboard', async () => {
  for (const [name, type] of [['database', 'postgres'], ['cache', 'keyvalue']]) {
    const d = (await t.get(`${WS}/services/${name}/datastore`, { as: 'stevie' })).json;
    assert.deepEqual([d.type, d.status, d.regionName, d.linked], [type, 'live', 'Johannesburg', []], name);
  }
  const cards = (await t.get(`${WS}/dashboard`, { as: 'stevie' })).json.cards;
  const db = cards.find((c) => c.name === 'database');
  assert.equal(db.store.connections.limit, 50);
  assert.equal(db.store.storage.limitBytes, 10e9);
  assert.equal(cards.find((c) => c.name === 'cache').store.memory.limitMb, 256);
});

test('6.4 create Postgres on the Local network: checked, its own role and database, reveal, back up, restore, plan', async () => {
  for (const [over, path] of [[{ name: 'Bad Name' }, 'name'], [{ plan: 'huge' }, 'plan'], [{ region: 'eu-central' }, 'region'], [{ backupTime: '25:00' }, 'backupTime'], [{ name: 'api' }, 'name']]) {
    const r = await t.post(`${WS}/datastores`, { as: 'stevie', body: { type: 'postgres', name: 'main-db', region: 'local', ...over } });
    assert.equal(r.status, 422, JSON.stringify(over));
    assert.ok(r.json.error.details.some((p) => p.path === path), JSON.stringify(r.json.error.details));
  }
  const res = await t.post(`${WS}/datastores`, { as: 'stevie', body: { type: 'postgres', name: 'main-db', region: 'local', plan: 'starter' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.redirect, '/w/exclusivity-life/services/main-db');
  await settle();
  const d = (await t.get(`${WS}/services/main-db/datastore`, { as: 'stevie' })).json;
  assert.deepEqual([d.status, d.local, d.planText, d.backupTime, d.connection.through], ['live', true, '20 connections · 1 GB storage', '03:00', 'relay']);
  assert.match(d.connection.user, /^nb_main_db_[0-9a-f]{12}$/);
  assert.equal(d.connection.database, d.connection.user, 'the database is reached only as its own role');
  assert.equal(d.connections.limit, 20);
  assert.ok(d.storage.bytes > 0);

  // The connection string: only after typing the name; recorded.
  assert.equal((await t.post(`${WS}/services/main-db/datastore/reveal`, { as: 'stevie', body: { confirm: 'nope' } })).status, 422);
  const { url } = (await t.post(`${WS}/services/main-db/datastore/reveal`, { as: 'stevie', body: { confirm: 'main-db' } })).json;
  assert.match(url, new RegExp(`^postgres://${d.connection.user}:[A-Za-z0-9_-]{32}@`));
  assert.ok(!JSON.stringify(d).includes(url.split(':')[2].split('@')[0]), 'the page data has no password');

  // Back up now, then restore into a new database.
  assert.equal((await t.post(`${WS}/services/main-db/datastore/backups`, { as: 'stevie' })).status, 202);
  await settle();
  const backups = (await t.get(`${WS}/services/main-db/datastore`, { as: 'stevie' })).json.backups;
  assert.equal(backups.length, 1);
  assert.equal((await t.post(`${WS}/services/main-db/datastore/restore`, { as: 'stevie', body: { backup: backups[0].id, into: 'main-db' } })).status, 422);
  const restored = await t.post(`${WS}/services/main-db/datastore/restore`, { as: 'stevie', body: { backup: backups[0].id, into: 'main-db-copy' } });
  assert.equal(restored.status, 201, JSON.stringify(restored.json));
  await settle();
  const copy = (await t.get(`${WS}/services/main-db-copy/datastore`, { as: 'stevie' })).json;
  assert.deepEqual([copy.status, copy.restoredFrom.database], ['live', 'main-db']);

  // A bigger plan: the connection limit applies at once.
  const p = await t.patch(`${WS}/services/main-db/datastore`, { as: 'stevie', body: { plan: 'standard', backupTime: null } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.deepEqual([p.json.plan, p.json.backupTime, p.json.connections.limit], ['standard', null, 50]);
});

test('6.4 create Key Value on the Local network: a Valkey store on the workspace network, reveal, plan', async () => {
  const res = await t.post(`${WS}/datastores`, { as: 'stevie', body: { type: 'keyvalue', name: 'jobs', region: 'local', plan: 'starter', eviction: 'noeviction' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await settle();
  const d = (await t.get(`${WS}/services/jobs/datastore`, { as: 'stevie' })).json;
  assert.deepEqual([d.status, d.eviction, d.persistence, d.connection.through, d.connection.host], ['live', 'noeviction', false, 'network', 'jobs-kv.exclusivity-life.internal']);
  assert.equal(d.memory.limitMb, 256);
  const c = docker().state.containers.find((x) => /-kv-jobs$/.test(x.name));
  assert.match(c.args.command.join(' '), /--maxmemory 256mb --maxmemory-policy noeviction/);
  const { url } = (await t.post(`${WS}/services/jobs/datastore/reveal`, { as: 'stevie', body: { confirm: 'jobs' } })).json;
  assert.match(url, /^redis:\/\/default:[A-Za-z0-9_-]{32}@jobs-kv\.exclusivity-life\.internal:6379$/);
  assert.equal((await t.post(`${WS}/services/jobs/datastore/backups`, { as: 'stevie' })).status, 409, 'nothing to back up');
});

test('6.4 Link to service: the seeded api gets DATABASE_URL and REDIS_URL; a Local service gets them through its network', async () => {
  // The seeded api is in Johannesburg: the Local network stores are refused, the Johannesburg ones linked.
  const far = await t.put(`${WS}/services/api/links`, { as: 'stevie', body: { links: [{ key: 'DATABASE_URL', store: 'main-db' }] } });
  assert.equal(far.status, 422);
  assert.match(far.json.error.message, /stays inside one region/);
  const r = await t.put(`${WS}/services/api/links`, { as: 'stevie', body: { links: [{ key: 'DATABASE_URL', store: 'database' }, { key: 'REDIS_URL', store: 'cache' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.redeploying, true);
  await settle();
  const w = await t.platform().workloads.get('exclusivity-life', 'api');
  assert.deepEqual(w.run.env.filter((e) => e.link), [{ key: 'DATABASE_URL', link: { database: 'database' } }, { key: 'REDIS_URL', link: { keyvalue: 'cache' } }]);
  assert.deepEqual((await t.get(`${WS}/services/database/datastore`, { as: 'stevie' })).json.linked, [{ service: 'api', key: 'DATABASE_URL' }]);
  assert.equal((await t.put(`${WS}/services/api/links`, { as: 'stevie', body: { links: [{ key: 'X', store: 'database' }, { key: 'X', store: 'cache' }] } })).status, 422);

  // A Local network web service: its container gets the connection strings when it starts.
  const created = await t.post(`${WS}/services`, { as: 'stevie', body: { type: 'web', name: 'notes', repoUrl: 'https://github.com/render-examples/express-hello-world', branch: 'main', region: 'local', runtime: 'node22', plan: 'starter', instances: 1 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await settle();
  const linked = await t.put(`${WS}/services/notes/links`, { as: 'stevie', body: { links: [{ key: 'DATABASE_URL', store: 'main-db' }, { key: 'REDIS_URL', store: 'jobs' }] } });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  await settle();
  const c = docker().state.containers.filter((x) => x.labels['noobly-workload'] === 'notes' && x.state === 'running').at(-1);
  const env = Object.fromEntries(c.args.env.map((e) => [e.key, e.value]));
  const relay = docker().relays.find((x) => x.network === c.args.network);
  const db = (await t.get(`${WS}/services/main-db/datastore`, { as: 'stevie' })).json;
  assert.match(env.DATABASE_URL, new RegExp(`^postgres://${db.connection.user}:[A-Za-z0-9_-]{32}@${relay.host.replace(/\./g, '\\.')}:${relay.port}/${db.connection.database}\\?sslmode=disable$`));
  assert.match(env.REDIS_URL, /@jobs-kv\.exclusivity-life\.internal:6379$/);
  assert.ok(relay.databases.includes(db.connection.database), 'the relay reaches the workspace\'s databases');
  assert.equal(c.args.network, docker().state.containers.find((x) => /-kv-jobs$/.test(x.name)).args.network, 'the store is on the same network');
});

test('6.4 another workspace cannot see, reveal, back up or link them', async () => {
  for (const [method, path] of [['get', '/services/main-db/datastore'], ['post', '/services/main-db/datastore/reveal'], ['post', '/services/main-db/datastore/backups'], ['patch', '/services/jobs/datastore']]) {
    const r = await t[method](`${WS}${path}`, { as: 'amara', ...(method === 'get' ? {} : { body: { confirm: 'main-db' } }) });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  // In their own workspace the name means nothing; the platform answers not found for another tenant's store.
  const other = '/api/v1/workspaces/amara-labs';
  const svc = (await t.get(`${other}/services`, { as: 'amara' })).json.services.find((s) => !['postgres', 'keyvalue', 'static'].includes(s.type));
  if (svc) {
    const r = await t.put(`${other}/services/${svc.name}/links`, { as: 'amara', body: { links: [{ key: 'DATABASE_URL', store: 'main-db' }] } });
    assert.equal(r.status, 422);
  }
  await assert.rejects(t.platform().databases.connection('amara-labs', 'main-db'), (e) => e.status === 404);
  await assert.rejects(t.platform().keyvalue.connection('amara-labs', 'jobs'), (e) => e.status === 404);
  // And their containers' relay (another network) is not told about these databases.
  const db = (await t.get(`${WS}/services/main-db/datastore`, { as: 'stevie' })).json;
  assert.equal(docker().relays.filter((r) => r.databases.includes(db.connection.database)).length, 1, 'only the workspace\'s own network relays to it');
});
