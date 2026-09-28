import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import * as M from '../../src/models/index.js';
import { docs } from '../helpers/docs.js';

let t;
before(async () => { t = await startTestDb(); await runMigrations(t.db); });
after(async () => { await t.stop(); });

const DUPLICATE_KEY = { code: 11000 };

test('group slug is unique', async () => {
  await M.Group.create(docs.group({ slug: 'same', fplLeagueId: 1 }));
  await assert.rejects(M.Group.create(docs.group({ slug: 'same', fplLeagueId: 2 })), DUPLICATE_KEY);
});

test('fplLeagueId is unique when set; any number of MANUAL groups may have null', async () => {
  await M.Group.create(docs.group({ slug: 'league-a', fplLeagueId: 555 }));
  await assert.rejects(M.Group.create(docs.group({ slug: 'league-b', fplLeagueId: 555 })), DUPLICATE_KEY);
  await M.Group.create(docs.group({ slug: 'manual-a', memberSource: 'MANUAL', fplLeagueId: null }));
  await M.Group.create(docs.group({ slug: 'manual-b', memberSource: 'MANUAL', fplLeagueId: null }));
  assert.equal(await M.Group.countDocuments({ fplLeagueId: null }), 2);
});

test('fplLeagueId stays unique across archived groups', async () => {
  await M.Group.create(docs.group({ slug: 'archived', fplLeagueId: 777, isActive: false, archivedAt: new Date() }));
  await assert.rejects(M.Group.create(docs.group({ slug: 'reuse', fplLeagueId: 777 })), DUPLICATE_KEY);
});

test('shareToken is unique when set; nulls do not collide', async () => {
  await M.Group.create(docs.group({ slug: 'share-a', fplLeagueId: 11, shareToken: 'tok' }));
  await assert.rejects(M.Group.create(docs.group({ slug: 'share-b', fplLeagueId: 12, shareToken: 'tok' })), DUPLICATE_KEY);
  await M.Group.create(docs.group({ slug: 'share-c', fplLeagueId: 13, shareToken: null }));
});

test('audit chain cannot fork: (groupId, season, event, seq) is unique', async () => {
  await M.GwResultAction.create(docs.gwResultAction());
  await assert.rejects(M.GwResultAction.create(docs.gwResultAction({ hash: `sha256:${'e'.repeat(64)}` })), DUPLICATE_KEY);
  await M.GwResultAction.create(docs.gwResultAction({ event: 6 })); // other GW: its own chain
});

test('deterministic _id makes a natural-key duplicate impossible', async () => {
  await M.ManagerGameweek.create(docs.managerGameweek());
  await assert.rejects(M.ManagerGameweek.create(docs.managerGameweek()), DUPLICATE_KEY);
  await M.Manager.create(docs.manager());
  await assert.rejects(M.Manager.create(docs.manager()), DUPLICATE_KEY);
});
