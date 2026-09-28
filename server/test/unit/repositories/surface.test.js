import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as repos from '../../../src/repositories/index.js';

// Repository write surface (architecture v0.3 §10 table), the no-delete rule,
// append-only layer 1 (§7) and "transactions are opened only by unitOfWork".

const WRITES = {
  groupRepo: ['create', 'updateConfig', 'setMembers', 'archive', 'unarchive'],
  managerRepo: ['upsertProfiles'],
  seasonRepo: ['replaceTeamsAndChipRules', 'applySemanticsEvidence'],
  eventRepo: ['bulkUpsert'],
  playerRepo: ['bulkUpsert'],
  managerGameweekRepo: ['bulkUpsertSeasonRows'],
  managerSeasonRepo: ['upsert'],
  liveRepo: ['replace'],
  syncRunRepo: ['insert', 'pushRequest', 'finish', 'markAbandoned', 'unsetExpiry'],
  rawResponseRepo: ['insert', 'unsetEvidenceExpiry'],
  resultRepo: ['insertSnapshot', 'appendAction', 'movePointer'],
  ownershipRepo: [],
  lockRepo: ['acquire', 'heartbeat', 'fence', 'release'],
};
const READ = /^(get|list|load|verify)[A-Z]?/;
const DELETE_NAME = /delete|remove|drop|purge|destroy|truncate|clear/i;

const REPO_DIR = fileURLToPath(new URL('../../../src/repositories/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../../src/', import.meta.url));

async function jsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => join(e.parentPath ?? e.path, e.name));
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('every repository exposes exactly its §10 writes plus reads', () => {
  assert.deepEqual(Object.keys(WRITES).sort(), Object.keys(repos).filter((k) => k.endsWith('Repo')).sort());
  for (const [name, writes] of Object.entries(WRITES)) {
    const methods = Object.keys(repos[name]);
    const extra = methods.filter((m) => !writes.includes(m) && !READ.test(m));
    assert.deepEqual(extra, [], `${name} has methods outside its write surface`);
    for (const w of writes) assert.equal(typeof repos[name][w], 'function', `${name}.${w}`);
  }
});

test('no repository method deletes (TTL is the only deletion mechanism)', () => {
  for (const [name, repo] of Object.entries(repos)) {
    if (!name.endsWith('Repo')) continue;
    assert.deepEqual(Object.keys(repo).filter((m) => DELETE_NAME.test(m)), [], name);
  }
});

test('repository sources contain no delete, drop or replace calls', async () => {
  const offenders = [];
  const FORBIDDEN = /\b(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findOneAndRemove|findByIdAndRemove|dropCollection|dropDatabase|dropIndex(es)?|replaceOne|findOneAndReplace)\b|\.(remove|drop)\s*\(/;
  for (const file of await jsFiles(REPO_DIR)) {
    const src = stripComments(await readFile(file, 'utf8'));
    if (FORBIDDEN.test(src)) offenders.push(relative(REPO_DIR, file));
  }
  assert.deepEqual(offenders, []);
});

test('resultSnapshots and gwResultActions are only ever created (append-only layer 1)', async () => {
  const src = stripComments(await readFile(join(REPO_DIR, 'resultRepo.js'), 'utf8'));
  assert.doesNotMatch(src, /\b(ResultSnapshot|GwResultAction)\.(update\w*|findOneAndUpdate|findByIdAndUpdate|bulkWrite|collection|replace\w*|insertMany)\b/);
  assert.match(src, /ResultSnapshot\.create\(/);
  assert.match(src, /GwResultAction\.create\(/);
});

test('repositories never open transactions (only db/unitOfWork.js does)', async () => {
  const offenders = [];
  for (const file of await jsFiles(REPO_DIR)) {
    const src = stripComments(await readFile(file, 'utf8'));
    if (/\b(startSession|withTransaction|startTransaction|commitTransaction)\b/.test(src)) offenders.push(relative(REPO_DIR, file));
  }
  assert.deepEqual(offenders, []);
});

test('models/ is imported only by repositories/ (and the models themselves)', async () => {
  const offenders = [];
  for (const file of await jsFiles(SRC_DIR)) {
    const rel = relative(SRC_DIR, file).split('\\').join('/');
    if (rel.startsWith('models/') || rel.startsWith('repositories/')) continue;
    const src = stripComments(await readFile(file, 'utf8'));
    if (/(?:from\s+|import\s*\(\s*)['"](?:\.\.?\/)+(?:[\w-]+\/)*models\//.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('mappers are pure: no model imports, no queries', async () => {
  for (const file of await jsFiles(join(REPO_DIR, 'mappers'))) {
    const src = stripComments(await readFile(file, 'utf8'));
    assert.doesNotMatch(src, /models\//, relative(REPO_DIR, file));
    assert.doesNotMatch(src, /\.(find|findOne|findById|updateOne|create|lean)\s*\(/, relative(REPO_DIR, file));
  }
});
