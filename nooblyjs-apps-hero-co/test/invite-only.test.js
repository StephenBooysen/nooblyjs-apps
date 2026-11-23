// AUTHTYPE=local: accounts by invitation only. Core's "Create New Account" goes to its register screen ("registration
// requires an invitation"); the sign-up form and GitHub make an account only for an open invitation to that email;
// people who have an account sign in as before. Its own file: one app per test file (core's registry is per process).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, cookieJar } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { REGISTER_PAGE } from '../src/platform/auth.js';

let t;
before(async () => { t = await startApp({ config: { authType: 'local' } }); });
after(async () => { await t?.close(); });

const signUp = (body) => t.post('/api/v1/auth/signup', { jar: cookieJar(), body, headers: { origin: t.base } });
const person = (email, extra = {}) => ({ name: 'New Person', team: 'Their Team', email, password: 'invited person 1', ...extra });

async function invite(email) {
  const sent = await t.post('/api/v1/workspaces/exclusivity-life/invitations', { as: 'stevie', body: { email } });
  assert.equal(sent.status, 201, sent.text);
  return (await t.linkFor(email, /invited you/i)).searchParams.get('token');
}

test('AUTHTYPE (or AUTH_TYPE) picks the mode; unset is open sign-up', () => {
  assert.equal(loadConfig({ AUTHTYPE: 'local' }).authType, 'local');
  assert.equal(loadConfig({ AUTH_TYPE: 'Google' }).authType, 'google');
  assert.equal(loadConfig({ AUTHTYPE: 'local', AUTH_TYPE: 'google' }).authType, 'local', 'AUTHTYPE first');
  assert.equal(loadConfig({}).authType, 'open');
  assert.equal(loadConfig({ AUTHTYPE: 'nonsense' }).authType, 'open');
});

test('"Create New Account" on core\'s sign-in page goes to core\'s register screen, which a stranger can open', async () => {
  const create = await t.get('/services/authservice/views/request-invitation.html?returnUrl=%2Fw%2Fx');
  assert.deepEqual([create.status, create.location], [302, `${REGISTER_PAGE}?returnUrl=%2Fw%2Fx`]);
  const page = await t.get(REGISTER_PAGE);
  assert.equal(page.status, 200);
  assert.match(page.text, /requires an invitation/i);
  assert.equal((await t.get('/services/authservice/views/js/register.page.js')).status, 200);
  const redeem = await t.get('/services/authservice/redeem-invitation');
  assert.deepEqual([redeem.status, redeem.location], [302, '/invite'], 'our invitations are links in an email');
  const config = (await t.get('/api/v1/auth/config')).json;
  assert.deepEqual([config.inviteOnly, config.registerUrl, config.googleOnly], [true, REGISTER_PAGE, false]);
});

test('the sign-up form makes an account only with an open invitation to that email', async () => {
  const none = await signUp(person('stranger@example.com'));
  assert.deepEqual([none.status, none.json.error.code], [403, 'invite_only']);
  assert.equal(await t.accounts.findPersonByEmail('stranger@example.com'), null);

  const token = await invite('invited@example.com');
  const wrong = await signUp(person('someone.else@example.com', { invite: token }));
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.error.details[0].message, /This invitation is for invited@example.com/);

  const ok = await signUp(person('invited@example.com', { invite: token }));
  assert.equal(ok.status, 201, ok.text);
  const joined = await t.accounts.workspacesFor((await t.accounts.findPersonByEmail('invited@example.com')).id);
  assert.ok(joined.some((w) => w.id === 'exclusivity-life' && w.role === 'Member'));
  const again = await signUp(person('invited.twice@example.com', { invite: token }));
  assert.equal(again.status, 403, 'an invitation makes one account');
});

test('GitHub makes no account without an invitation, and still signs in someone who has one', async () => {
  const signInWithGithub = async (user, query = '') => {
    const jar = cookieJar();
    const start = await t.get(`/auth/github${query}`, { jar });
    const authorize = new URL(start.location);
    const granted = await t.post('/dev/github/login/oauth/authorize', { form: { user, redirect_uri: authorize.searchParams.get('redirect_uri'), state: authorize.searchParams.get('state') } });
    const back = new URL(granted.location);
    return t.get(back.pathname + back.search, { jar });
  };
  const stranger = await signInWithGithub('1001'); // octo-dev, no account
  assert.deepEqual([stranger.status, stranger.location], [303, '/?error=invite-only']);
  assert.equal(await t.accounts.findPersonByEmail('octo@github-mock.dev'), null);

  const stevie = await signInWithGithub('1002'); // stevie@exclusivity.life has an account: linked, signed in
  assert.deepEqual([stevie.status, stevie.location], [303, '/w/exclusivity-life']);

  const token = await invite('octo@github-mock.dev');
  const invited = await signInWithGithub('1001', `?invite=${encodeURIComponent(token)}`);
  assert.deepEqual([invited.status, invited.location], [303, '/w/exclusivity-life']);
});

test('people with an account sign in with their password as before', async () => {
  const res = await t.post('/services/authservice/api/login', { jar: cookieJar(), body: { email: 'stevie@exclusivity.life', password: 'development-only-1' }, headers: { origin: t.base } });
  assert.equal(res.status, 200, res.text);
});
