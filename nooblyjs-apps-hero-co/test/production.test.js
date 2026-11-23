// Production providers (roadmap 8.1): what a production start-up warns about, the readiness check, and, with
// MONGODB_URL and REDIS_URL set (CI sets both), a sign-in that survives a restart of the app: the session is in Redis
// and the person in MongoDB, so a new process (a redeploy) still knows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, cookieJar } from './helpers.js';
import { productionWarnings } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('a production start-up names what it lacks; development names nothing', () => {
  assert.deepEqual(productionWarnings(loadConfig({ NODE_ENV: 'development' })), []);
  const bare = productionWarnings(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'http://cloud.example' }));
  assert.equal(bare.length, 4);
  assert.match(bare[0], /^MONGODB_URL is not set/);
  assert.match(bare[1], /^REDIS_URL is not set/);
  assert.match(bare[2], /^TRUST_PROXY is not set/);
  assert.match(bare[3], /^PUBLIC_URL \(http:\/\/cloud\.example\) is not https/);
  const full = loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://cloud.example', MONGODB_URL: 'mongodb://db', REDIS_URL: 'redis://cache', TRUST_PROXY: '1' });
  assert.deepEqual(productionWarnings(full), []);
  assert.equal(full.mongodbDatabase, 'nooblyjs_cloud');
  assert.equal(loadConfig({ MONGODB_URL: 'mongodb://db', MONGODB_DATABASE: 'other' }).mongodbDatabase, 'other');
  assert.equal(loadConfig({ REDIS_URL: 'redis://a', SESSION_REDIS_URL: 'redis://b' }).redisUrl, 'redis://b');
});

test('production refuses to start without SESSION_SECRET', async () => {
  await assert.rejects(startApp({ config: { production: true, devSignIn: false, sessionSecret: undefined } }), /SESSION_SECRET is required/);
});

test('/health/ready answers 200 while the records store answers, and says which it is', async () => {
  const t = await startApp({ cards: false });
  try {
    const res = await t.get('/health/ready');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 'ok', records: process.env.MONGODB_URL ? 'mongodb' : 'file' });
  } finally {
    await t.close();
  }
});

const shared = process.env.MONGODB_URL && process.env.REDIS_URL;
test('a sign-in survives a restart: the session in Redis, the person in MongoDB', { skip: !shared && 'needs MONGODB_URL and REDIS_URL' }, async () => {
  const config = { mongodbDatabase: `hero_test_restart_${process.pid}`, redisUrl: process.env.REDIS_URL, sessionSecret: 'a test secret that both processes share' };
  const first = await startApp({ cards: false, config });
  const jar = cookieJar();
  let second;
  try {
    const signIn = await first.post('/services/authservice/api/login', { jar, body: { email: 'stevie@exclusivity.life', password: 'development-only-1' }, headers: { origin: first.base } });
    assert.equal(signIn.status, 200, signIn.text);
    assert.equal((await first.get('/api/v1/me', { jar })).json.id, 'stevie');
    // The first process stops (its database kept); a new one starts on the same MongoDB database and Redis.
    await first.close({ keepDatabase: true });
    second = await startApp({ cards: false, config });
    const me = await second.get('/api/v1/me', { jar });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.id, 'stevie');
  } finally {
    await second?.close();
  }
});
