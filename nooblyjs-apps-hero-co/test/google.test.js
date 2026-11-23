// Google sign-in (AUTHTYPE=google): Google is the only way in. Core's sign-in page asks sso-config and goes straight
// to Google; the callback (the redirect URI registered with Google) makes a hero-co session and, the first time, the
// person and their workspace. Email sign-up and GitHub sign-in are off; the password form stays for operators
// (?local=1). Runs against the mock Google at /dev/google, which passport-google-oauth20 talks to as it would to Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, cookieJar } from './helpers.js';
import { GOOGLE_START, GOOGLE_CALLBACK } from '../src/platform/auth.js';

let t;
before(async () => { t = await startApp({ config: { authType: 'google' } }); });
after(async () => { await t?.close(); });

/** The whole round trip as a browser: start, choose `user` on the mock Google, come back. → the callback's answer. */
async function signInWithGoogle(user, { query = {}, jar = cookieJar(), tamper } = {}) {
  const q = new URLSearchParams(query).toString();
  const start = await t.get(`${GOOGLE_START}${q ? `?${q}` : ''}`, { jar });
  assert.equal(start.status, 302, start.text);
  const authorize = new URL(start.location);
  assert.equal(authorize.pathname, '/dev/google/o/oauth2/v2/auth');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${t.base}${GOOGLE_CALLBACK}`, 'the redirect URI registered with Google');
  assert.ok(authorize.searchParams.get('state'), 'a state, checked on the way back');
  const chosen = await t.post('/dev/google/o/oauth2/v2/auth', { form: { user, redirect_uri: authorize.searchParams.get('redirect_uri'), state: tamper ?? authorize.searchParams.get('state') } });
  const back = new URL(chosen.location);
  const res = await t.get(back.pathname + back.search, { jar });
  return { ...res, jar };
}

test('core\'s sign-in page is sent to Google; email sign-up and GitHub sign-in are off', async () => {
  const sso = await t.get('/services/authservice/api/sso-config');
  assert.deepEqual(sso.json.data, { enabled: true, provider: 'google', initiateUrl: GOOGLE_START });
  const config = (await t.get('/api/v1/auth/config')).json;
  assert.equal(config.googleOnly, true);
  assert.equal(config.googleUrl, GOOGLE_START);
  assert.equal(config.github, false);
  const signup = await t.post('/api/v1/auth/signup', { jar: cookieJar(), body: { name: 'Ada', team: 'Engines', email: 'ada@engines.dev', password: 'difference engine 1' }, headers: { origin: t.base } });
  assert.deepEqual([signup.status, signup.json.error.code], [403, 'google_only']);
  assert.equal((await t.get('/auth/github')).status, 404);
});

test('the first Google sign-in makes the person and their workspace; the next one signs them in', async () => {
  const first = await signInWithGoogle('g-2001');
  assert.equal(first.status, 303, first.text);
  assert.match(first.location, /^\/w\/grace-hopper-s-team/);
  const me = (await t.get('/api/v1/me', { jar: first.jar })).json;
  assert.deepEqual([me.name, me.email, me.emailVerified], ['Grace Hopper', 'grace@google-mock.dev', true]);
  assert.equal(me.workspaces[0].role, 'Owner');
  const person = await t.accounts.findPersonByEmail('grace@google-mock.dev');
  assert.deepEqual([person.googleId, person.signedUpWith], ['g-2001', 'google']);
  assert.ok(t.outbox().some((m) => m.to === 'grace@google-mock.dev'), 'the welcome email');

  const again = await signInWithGoogle('g-2001', { query: { returnUrl: `/w/${me.workspaces[0].id}/logs` } });
  assert.equal(again.location, `/w/${me.workspaces[0].id}/logs`, 'back to the page they wanted');
  assert.equal((await t.accounts.listPeople()).filter((p) => p.email === 'grace@google-mock.dev').length, 1);
  const tricked = await signInWithGoogle('g-2001', { query: { returnUrl: '/\t/evil.com' } });
  assert.equal(tricked.location, `/w/${me.workspaces[0].id}`, 'not another site');
});

test('a Google account with an existing account\'s email links to it', async () => {
  const res = await signInWithGoogle('g-2002');
  assert.equal(res.status, 303);
  assert.equal(res.location, '/w/exclusivity-life');
  const stevie = await t.accounts.getPerson('stevie');
  assert.equal(stevie.googleId, 'g-2002');
  assert.equal((await t.get('/api/v1/me', { jar: res.jar })).json.id, 'stevie');
});

test('an address Google has not verified, or a forged state, signs nobody in', async () => {
  const unverified = await signInWithGoogle('g-2003');
  assert.deepEqual([unverified.status, unverified.location], [303, '/?error=google-email']);
  assert.equal(await t.accounts.findPersonByEmail('unverified@google-mock.dev'), null);
  const forged = await signInWithGoogle('g-2001', { tamper: 'not-the-state' });
  assert.deepEqual([forged.status, forged.location], [303, '/?error=google']);
  assert.equal((await t.get('/api/v1/me', { jar: forged.jar })).status, 401);
});

test('an invitation: the invited person signs in with Google and joins that workspace (and no other)', async () => {
  const sent = await t.post('/api/v1/workspaces/exclusivity-life/invitations', { as: 'stevie', body: { email: 'new.person@google-mock.dev' } });
  assert.equal(sent.status, 201, sent.text);
  const link = await t.linkFor('new.person@google-mock.dev', /invited you/i);
  const token = link.searchParams.get('token');
  // The mock has no such account: add one for this test.
  const { GOOGLE_MOCK_USERS } = await import('../src/platform/auth.js');
  GOOGLE_MOCK_USERS.push({ sub: 'g-2099', name: 'New Person', email: 'new.person@google-mock.dev', email_verified: true });
  const res = await signInWithGoogle('g-2099', { query: { invite: token } });
  assert.deepEqual([res.status, res.location], [303, '/w/exclusivity-life']);
  const me = (await t.get('/api/v1/me', { jar: res.jar })).json;
  assert.deepEqual(me.workspaces.map((w) => [w.id, w.role]), [['exclusivity-life', 'Member']]);
});

test('operators keep the password form (?local=1): the login API still answers', async () => {
  const ops = (await t.accounts.listPeople()).find((p) => p.operator === 'platform' && p.signedUpWith === 'seed');
  const ok = await t.post('/services/authservice/api/login', { jar: cookieJar(), body: { email: ops.email, password: 'development-only-1' }, headers: { origin: t.base } });
  assert.equal(ok.status, 200, ok.text);
});

test('production refuses AUTHTYPE=google without a Google client', async () => {
  await assert.rejects(startApp({ config: { production: true, devSignIn: false, sessionSecret: 'a production secret for the test', authType: 'google', google: {} } }), /AUTHTYPE=google needs GOOGLE_OAUTH_CLIENT/);
});
