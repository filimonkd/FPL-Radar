import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonForDate, isSeasonKey, rankLabel, pct, bytes, explain, statusTone, managerName, announcement, validNote, parseEntryIds, tieBreakChain, shortHash } from '../../src/lib/format.js';

// Step 13: the client's display rules. Synthetic data only.

const standings = [
  { entryId: 103, teamName: 'Team C', playerName: 'Carol', competitionRank: 1, tiedWith: [] },
  { entryId: 101, teamName: 'Team A', playerName: 'Ann', competitionRank: 2, tiedWith: [102] },
  { entryId: 102, teamName: 'Team B', playerName: 'Bob', competitionRank: 2, tiedWith: [101] },
  { entryId: 104, teamName: 'Team D', playerName: 'Dan', competitionRank: null, tiedWith: [], ineligibleReason: 'EXCLUDED' },
];

test('season key: August starts the season; keys validate consecutive years', () => {
  assert.equal(seasonForDate(new Date('2026-09-28T12:00:00Z')), '2026-27');
  assert.equal(seasonForDate(new Date('2027-05-20T12:00:00Z')), '2026-27');
  assert.equal(seasonForDate(new Date('2027-07-15T12:00:00Z')), '2027-28');
  assert.equal(seasonForDate(new Date('2099-12-01T00:00:00Z')), '2099-00');
  assert.equal(isSeasonKey('2026-27'), true);
  assert.equal(isSeasonKey('2099-00'), true);
  assert.equal(isSeasonKey('2026-28'), false);
  assert.equal(isSeasonKey('x'), false);
  assert.equal(isSeasonKey(null), false);
});

test('rank column: "=" for ties, "–" when ineligible (v0.2 §6)', () => {
  assert.deepEqual(standings.map(rankLabel), ['1', '=2', '=2', '–']);
});

test('numbers: percentages with denominators, byte sizes, hashes', () => {
  assert.equal(pct({ count: 1, of: 3, pct: 33.33333 }), '33.3%');
  assert.equal(pct({ count: 0, of: 0, pct: 0 }), '–', 'no denominator → no percentage');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(256245), '250.2 KB');
  assert.equal(bytes(536870912), '512.0 MB');
  assert.equal(shortHash('sha256:abcdef0123456789'), 'abcdef0123…');
});

test('codes are explained, never reinterpreted; unknown codes pass through', () => {
  assert.match(explain('STALE_SYNC'), /fresh sync/);
  assert.match(explain('SEMANTICS_UNVERIFIED'), /UNVERIFIED/);
  assert.match(explain('ENTRY_ID_FALLBACK'), /never decides a winner/);
  assert.equal(explain('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.deepEqual(['FINAL', 'OVERRIDDEN', 'BLOCKED', 'UNVERIFIED', 'CONFLICTED', 'x'].map(statusTone), ['good', 'warn', 'bad', 'warn', 'bad', 'neutral']);
});

test('announcement: only decided results; shared winners; overrides say so', () => {
  const base = { season: '2026-27', event: 5, standings, winningScore: 61 };
  assert.equal(announcement({ ...base, status: 'PROVISIONAL', winners: [103] }, 'Rivals'), null);
  assert.equal(announcement({ ...base, status: 'BLOCKED', winners: [] }, 'Rivals'), null);
  assert.equal(announcement({ ...base, status: 'FINAL', winners: [103] }, 'Rivals'), 'Rivals · GW5 2026-27: Team C (Carol) wins with 61 pts.');
  assert.equal(announcement({ ...base, status: 'FINAL', winners: [101, 102], winningScore: 58 }, 'Rivals'), 'Rivals · GW5 2026-27: Team A (Ann) and Team B (Bob) share the win with 58 pts.');
  assert.equal(announcement({ ...base, status: 'OVERRIDDEN', winners: [101] }, 'Rivals'), 'Rivals · GW5 2026-27: Team A (Ann) wins (declared by the admin).');
  assert.equal(managerName(standings, 999), '#999');
});

test('form inputs: notes 3–280 chars, entry ID parsing, tie-break chain ends with SHARED', () => {
  assert.equal(validNote('  ok '), false);
  assert.equal(validNote('why'), true);
  assert.equal(validNote('x'.repeat(280)), true);
  assert.equal(validNote('x'.repeat(281)), false);
  assert.deepEqual(parseEntryIds('101, 102\n103 101;abc 0 -5'), { ids: [101, 102, 103], bad: ['abc', '0', '-5'] });
  assert.deepEqual(parseEntryIds(''), { ids: [], bad: [] });
  assert.deepEqual(tieBreakChain(['HIGHER_SEASON_TOTAL', 'SHARED', 'FEWER_TRANSFER_COST']), ['HIGHER_SEASON_TOTAL', 'FEWER_TRANSFER_COST', 'SHARED']);
  assert.deepEqual(tieBreakChain([]), ['SHARED']);
});
