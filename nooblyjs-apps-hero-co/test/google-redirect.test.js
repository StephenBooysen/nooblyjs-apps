// GOOGLE_REDIRECT_BASE: the address Google sends the browser back to when it is not PUBLIC_URL (a Codespaces forwarded
// address). Its own file: nooblyjs-core's registry is one per process, so one app per test file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, cookieJar } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { GOOGLE_START, GOOGLE_CALLBACK } from '../src/platform/auth.js';

const base = 'https://example-codespace-11010.app.github.dev';

test('GOOGLE_REDIRECT_BASE is read from the environment, as a URL, without a trailing slash', () => {
  assert.equal(loadConfig({ GOOGLE_REDIRECT_BASE: `${base}/` }).google.redirectBase, base);
  assert.equal(loadConfig({ GOOGLE_REDIRECT_BASE: 'not a url' }).google.redirectBase, null);
  assert.equal(loadConfig({}).google.redirectBase, null);
});

test('the redirect URI sent to Google is GOOGLE_REDIRECT_BASE + the callback path, not PUBLIC_URL', async () => {
  const t = await startApp({ cards: false, config: { authType: 'google', google: { redirectBase: base } } });
  try {
    const start = await t.get(GOOGLE_START, { jar: cookieJar() });
    assert.equal(start.status, 302);
    assert.equal(new URL(start.location).searchParams.get('redirect_uri'), `${base}${GOOGLE_CALLBACK}`);
  } finally {
    await t.close();
  }
});
