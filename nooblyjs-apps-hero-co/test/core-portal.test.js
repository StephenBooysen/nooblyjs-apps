// nooblyjs-core's own screens under /services (its Authentication Management, for platform operators): they post JSON
// to core's routes. hero-co has no global JSON parser (each router parses its own), so core parses /services bodies
// itself; this checks it through the app, as the operator's browser does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp, cookieJar } from './helpers.js';

let t;
before(async () => { t = await startApp({ cards: false }); });
after(async () => { await t?.close(); });

test('core\'s Invitations screen: a platform operator creates an invitation (the JSON body reaches core)', async () => {
  // nooblyjs-core's start-up admin, signed in on its login page (hero-co answers it; the admin is a platform operator).
  const password = (await fs.readFile(path.join(t.dataDir, 'auth', 'INITIAL_ADMIN_PASSWORD.txt'), 'utf8')).match(/^password:\s*(\S+)/m)[1];
  const jar = cookieJar();
  const signedIn = await t.post('/services/authservice/api/login', { jar, body: { email: 'admin@localhost', password }, headers: { origin: t.base } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const res = await t.post('/services/authservice/api/invitations/batch', { jar, body: { invites: [{ name: 'Stephen Example', email: 'stephen@example.com' }] }, headers: { origin: t.base } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.success, true);
  const list = await t.get('/services/authservice/api/invitations', { jar });
  assert.ok(JSON.stringify(list.json).includes('stephen@example.com'), list.text.slice(0, 300));
});
