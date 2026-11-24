// NooblyJS Cloud: starts the app (src/app.js) on PORT (default 11010).
//
//   npm start                  http://localhost:11010 (sign up at /, or /dev/login in development)
//   npm run seed [-- --reset]  writes the seed story (infrastructure, then services and GitHub) into DATA_DIR and exits
//   node app.js --operator <email> <platform|support|none>   grants (or removes) an operator role and exits
//   node app.js --backup <folder>              writes a backup of DATA_DIR (and MongoDB) and exits (app stopped)
//   node app.js --restore <backup> [--force]   puts a backup back into DATA_DIR (and MongoDB) and exits (app stopped)
//
// --development (npm start, npm run dev, npm run seed) stands for NODE_ENV=development when neither the environment
// nor .env sets it. Without it, an unset NODE_ENV runs with no development sign-in and no sample data (roadmap 8.7.3);
// the image runs `node app.js` with NODE_ENV=production.
import fs from 'node:fs/promises';
import { createApp } from './src/app.js';
import { loadConfig, ROOT } from './src/config.js';
import { backup, restore } from './src/platform/backup.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
if (args.has('--development') && !process.env.NODE_ENV) process.env.NODE_ENV = 'development';
const config = loadConfig();

// Backup and restore (roadmap 8.7.8) never start the app: they take DATA_DIR's lock, so they refuse while it runs.
if (args.has('--backup') || args.has('--restore')) {
  const flag = args.has('--backup') ? '--backup' : '--restore';
  const target = argv[argv.indexOf(flag) + 1];
  const where = { dataDir: config.dataDir, mongodbUrl: config.mongodbUrl, mongodbDatabase: config.mongodbDatabase };
  try {
    if (flag === '--backup') {
      const { version } = JSON.parse(await fs.readFile(new URL('package.json', `file://${ROOT}/`), 'utf8'));
      const { dir, manifest } = await backup({ ...where, out: target, version });
      const records = manifest.mongodb ? `, ${Object.values(manifest.mongodb.collections).reduce((a, b) => a + b, 0)} MongoDB records in ${Object.keys(manifest.mongodb.collections).length} collections` : '';
      console.log(`Backed up ${config.dataDir} (${manifest.files} files${records}) to ${dir}`);
    } else {
      const { manifest, aside } = await restore({ ...where, from: target, force: args.has('--force') });
      console.log(`Restored the backup of ${manifest.createdAt} into ${config.dataDir}${manifest.mongodb ? ` and ${config.mongodbDatabase}` : ''}.${aside ? ` What was there is in ${aside}.` : ''} Start the app with the same keys it had.`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`${flag === '--backup' ? 'Backup' : 'Restore'} failed: ${err.message}`);
    process.exit(1);
  }
}

if (args.has('--seed') && !config.sampleData) {
  console.error('npm run seed writes sample data, so it needs NODE_ENV=development (roadmap 8.7.2).');
  process.exit(1);
}

// Another copy on the same DATA_DIR took the lock (this one was paused past its heartbeat): stop at once, before both
// write the same files.
const onLockLost = (holder) => {
  console.error(`NooblyJS Cloud stopped: DATA_DIR is now in use by pid ${holder?.pid ?? '?'} on ${holder?.hostname ?? '?'}.`);
  process.exit(1);
};
// The one-off commands refuse at once while the app is running; a start waits for a stopped copy's lock to go stale.
const oneOff = args.has('--seed') || args.has('--operator');

let hero;
try {
  hero = await createApp({ config, seed: !args.has('--seed'), onLockLost, lock: oneOff ? { waitMs: 0 } : {} });
} catch (err) {
  console.error(`NooblyJS Cloud could not start: ${err.message}`);
  process.exit(1);
}

if (args.has('--operator')) {
  const [email, role] = argv.slice(argv.indexOf('--operator') + 1);
  try {
    const person = await hero.setOperator(email, role);
    console.log(`${person.email} is ${person.operator ? `an operator (${person.operator})` : 'not an operator'}.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  await hero.shutdown();
  process.exit();
}

if (args.has('--seed')) {
  await hero.accelerators.mounted.infrastructure.seed({ reset: args.has('--reset') });
  const result = await hero.seedRecords({ reset: args.has('--reset') });
  console.log(`Seeded ${config.dataDir}${args.has('--reset') ? ' (reset)' : ''}: ${result.skipped ? `services ${result.skipped}` : `${result.services} services, ${result.deploys} deploys, GitHub as stevie`}.`);
  await hero.shutdown();
  process.exit(0);
}

// Express 5 hands a listen failure (such as the port being taken by another copy of this app) to this callback, not
// to a crash: stop everything, the local agent with it, rather than run without a port.
const server = hero.app.listen(config.port, async (err) => {
  if (err) {
    console.error(`Could not listen on port ${config.port}: ${err.code === 'EADDRINUSE' ? 'something else is using it (another copy of this app?)' : err.message}`);
    await hero.shutdown();
    process.exit(1);
  }
  console.log(`NooblyJS Cloud on ${config.publicUrl} (data in ${config.dataDir})`);
});
// Local servers' agents connect to /infrastructure/agent/v1 over a WebSocket (infra spec 8.9).
hero.attachUpgrades(server);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  server.close();
  await hero.shutdown();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
