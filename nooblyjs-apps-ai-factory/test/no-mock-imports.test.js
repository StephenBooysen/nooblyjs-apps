// Phase 27 (no mocks in production), task 16: a mock provider is imported only by tests, the harness's testing entry,
// and the few shipped places that refuse to run it in production. A new import anywhere else fails here, so a mock
// can't quietly reach shipped code again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MONOREPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '.git', '.claude', '.temp', 'data', 'test-app', 'coverage']);
const MOCK_IMPORT = /\b(createMockProvider|createEchoProvider|createFakeClock|makeMockProvider)\b|providers\/mock(\.js)?['"]/;

// Each allowed file, and why it may name a mock.
const ALLOWED = new Map([
  ['nooblyjs-ai-harness/testing.js', 'the testing entry itself'],
  ['nooblyjs-ai-harness/src/providers/mock.js', 'the mock provider'],
  ['nooblyjs-ai-harness/src/providers/echo.js', 'the echo provider (refused in production)'],
  ['nooblyjs-ai-harness/src/providers/index.js', 'creates echo for `noobly --echo`, refused in production'],
  ['nooblyjs-ai-harness/src/index.js', 'a comment pointing at the testing entry'],
  ['nooblyjs-ai-factory/src/services/harness.js', 'the Factory\'s one import of the harness (internal, not its public API)'],
  ['nooblyjs-ai-factory/src/services/exec/harness/script.js', 'scripted models, refused in production'],
  ['nooblyjs-ai-factory/src/services/exec/harness/in-process.js', 'a comment'],
  ['nooblyjs-ai-factory/src/services/exec/harness/driver.js', 'a comment'],
  ['nooblyjs-ai-factory/src/services/bench/runner.js', 'the bench\'s oracle and null agents, refused in production'],
  ['nooblyjs-ai-factory/src/utils/clock.js', 'a comment pointing at test/fixtures/clock.js'],
  ['nooblyjs-ai-teammate/src/services/providers/index.js', 'offline mode, only with AI_PROVIDER=mock, refused in production'],
]);

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
    } else if (/\.(c|m)?jsx?$/.test(entry.name)) yield path.join(dir, entry.name);
  }
}

test('no mock provider or fake clock is named in shipped code outside the allowed places', () => {
  const projects = fs.readdirSync(MONOREPO).filter((n) => n.startsWith('nooblyjs-ai-') && fs.statSync(path.join(MONOREPO, n)).isDirectory());
  const offenders = [];
  let scanned = 0;
  for (const project of projects) {
    for (const file of sourceFiles(path.join(MONOREPO, project))) {
      const rel = path.relative(MONOREPO, file).split(path.sep).join('/');
      scanned += 1;
      if (ALLOWED.has(rel)) continue;
      if (MOCK_IMPORT.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    }
  }
  assert.ok(scanned > 500, `only ${scanned} files scanned: is MONOREPO right?`);
  assert.deepEqual(offenders, [], `mock providers named in shipped code: ${offenders.join(', ')}`);
});
