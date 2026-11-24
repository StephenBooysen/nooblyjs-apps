// Backup and restore (roadmap 8.7.8; the audit's P5): DATA_DIR, and the MongoDB database when MONGODB_URL is set.
//
//   node app.js --backup <folder>            writes <folder>/nooblyjs-cloud-<time>/ (data/, mongodb/, manifest.json)
//   node app.js --restore <backup> [--force] puts it back into DATA_DIR (and the database)
//
// Both take DATA_DIR's lock (src/platform/lock.js), so they refuse while the app is running: with the app stopped no
// file or record changes mid-copy, and the backup is consistent across the folder and the database. The keys
// (SESSION_SECRET, HERO_SECRET_KEY, INFRA_SECRET_KEY, SETTINGS_SECRET) are not in either: keep them in your secret
// store, because a restore opens the encrypted values only with the same ones.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { lockDataDir, LOCK_FILE } from './lock.js';

export const BACKUP_PREFIX = 'nooblyjs-cloud-';
/** The collections of ours in a shared database: hero-co's, and the customers and payments accelerators'. */
const OURS = /^(hero|cx|pay)_/;
const quiet = { warn() {} };

/** Never copied: the running process's lock, and locks moved aside while being taken over. */
const skip = (file) => {
  const name = path.basename(file);
  return name === LOCK_FILE || name.startsWith(`${LOCK_FILE}.stale-`);
};

async function countFiles(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).length;
}

async function mongo(url, database) {
  const { MongoClient, BSON } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  return { client, db: client.db(database), EJSON: BSON.EJSON };
}

/**
 * Writes a backup of DATA_DIR (and the database) into a new folder under `out`.
 * @param {{ dataDir: string, mongodbUrl?: string|null, mongodbDatabase?: string, out: string, version?: string, now?: Date }} o
 * @returns {Promise<{ dir: string, manifest: object }>}
 */
export async function backup({ dataDir, mongodbUrl, mongodbDatabase, out, version, now = new Date() }) {
  if (!out) throw new Error('Name the folder to write the backup into: node app.js --backup <folder>.');
  await fs.access(dataDir).catch(() => { throw new Error(`DATA_DIR (${dataDir}) does not exist: nothing to back up.`); });
  const dir = path.resolve(out, `${BACKUP_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}`);
  if (dir === path.resolve(dataDir) || dir.startsWith(`${path.resolve(dataDir)}${path.sep}`)) throw new Error('Write the backup outside DATA_DIR.');
  const lock = await lockDataDir(dataDir, { waitMs: 0, log: quiet });
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.cp(dataDir, path.join(dir, 'data'), { recursive: true, filter: (src) => !skip(src), errorOnExist: true });
    let collections = null;
    if (mongodbUrl) {
      const { client, db, EJSON } = await mongo(mongodbUrl, mongodbDatabase);
      try {
        collections = {};
        await fs.mkdir(path.join(dir, 'mongodb'));
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
          if (!OURS.test(name)) continue;
          const file = await fs.open(path.join(dir, 'mongodb', `${name}.jsonl`), 'w');
          let n = 0;
          try {
            // Canonical Extended JSON keeps every BSON type (dates, ObjectIds, numbers) as it was.
            for await (const doc of db.collection(name).find({})) {
              await file.write(`${EJSON.stringify(doc, { relaxed: false })}\n`);
              n++;
            }
          } finally {
            await file.close();
          }
          collections[name] = n;
        }
      } finally {
        await client.close();
      }
    }
    const manifest = {
      app: 'nooblyjs-cloud',
      version,
      createdAt: now.toISOString(),
      dataDir: path.resolve(dataDir),
      files: await countFiles(path.join(dir, 'data')),
      mongodb: collections ? { database: mongodbDatabase, collections } : null,
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifest };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await lock.release();
  }
}

/**
 * Puts a backup back: its files into DATA_DIR and its collections into the database.
 * DATA_DIR and the database must be empty of ours, unless `force`: then what is in DATA_DIR is moved aside (to
 * DATA_DIR.before-restore-<time>) and the backup's collections replace the database's.
 * @param {{ dataDir: string, mongodbUrl?: string|null, mongodbDatabase?: string, from: string, force?: boolean, now?: Date }} o
 * @returns {Promise<{ manifest: object, aside: string|null }>}
 */
export async function restore({ dataDir, mongodbUrl, mongodbDatabase, from, force = false, now = new Date() }) {
  if (!from) throw new Error('Name the backup folder to restore: node app.js --restore <folder>.');
  const manifest = JSON.parse(await fs.readFile(path.join(from, 'manifest.json'), 'utf8').catch(() => {
    throw new Error(`${from} is not a backup (it has no manifest.json).`);
  }));
  if (manifest.app !== 'nooblyjs-cloud') throw new Error(`${from} is not a NooblyJS Cloud backup.`);
  if (manifest.mongodb && !mongodbUrl) throw new Error('This backup holds MongoDB collections: set MONGODB_URL (and MONGODB_DATABASE) to restore them.');
  if (!manifest.mongodb && mongodbUrl) throw new Error('This backup has no MongoDB collections (it was made without MONGODB_URL): unset MONGODB_URL to restore it.');

  await fs.mkdir(dataDir, { recursive: true });
  const lock = await lockDataDir(dataDir, { waitMs: 0, log: quiet });
  let aside = null;
  try {
    const existing = (await fs.readdir(dataDir)).filter((f) => !skip(f));
    let client = null;
    let db = null;
    let EJSON = null;
    if (manifest.mongodb) {
      ({ client, db, EJSON } = await mongo(mongodbUrl, mongodbDatabase));
    }
    try {
      const present = db ? (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => OURS.test(n)) : [];
      const occupied = [];
      for (const name of present) if (await db.collection(name).estimatedDocumentCount()) occupied.push(name);
      if (!force && (existing.length || occupied.length)) {
        const what = [existing.length ? `${dataDir} is not empty` : null, occupied.length ? `the database ${mongodbDatabase} has records (${occupied.slice(0, 3).join(', ')}${occupied.length > 3 ? ', …' : ''})` : null].filter(Boolean).join(' and ');
        throw new Error(`${what}: restore into an empty DATA_DIR and database, or pass --force to replace them (DATA_DIR's files are moved aside, not deleted).`);
      }
      if (existing.length) {
        aside = `${path.resolve(dataDir)}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
        await fs.mkdir(aside);
        for (const name of existing) await fs.rename(path.join(dataDir, name), path.join(aside, name));
      }
      await fs.cp(path.join(from, 'data'), dataDir, { recursive: true, filter: (src) => !skip(src) });

      if (db) {
        for (const name of present) await db.collection(name).drop();
        for (const [name, expected] of Object.entries(manifest.mongodb.collections)) {
          const collection = db.collection(name);
          let batch = [];
          const lines = readline.createInterface({ input: createReadStream(path.join(from, 'mongodb', `${name}.jsonl`)), crlfDelay: Infinity });
          for await (const line of lines) {
            if (!line) continue;
            batch.push(EJSON.parse(line, { relaxed: false }));
            if (batch.length === 1000) {
              await collection.insertMany(batch, { ordered: true });
              batch = [];
            }
          }
          if (batch.length) await collection.insertMany(batch, { ordered: true });
          const count = await collection.countDocuments();
          if (count !== expected) throw new Error(`${name}: ${count} records restored, the backup has ${expected}.`);
        }
      }
    } finally {
      await client?.close();
    }
    return { manifest, aside };
  } finally {
    await lock.release();
  }
}
