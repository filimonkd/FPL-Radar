import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappSummary, money, signed } from '../../src/lib/format.js';

// Step 16: the group-chat summary uses only API facts. Synthetic data.

const leaderboard = [
  { entryId: 2, teamName: 'Team B', playerName: 'Bob', rank: 1, total: 330, gwScore: 70, gwHit: 4, form: 72.3 },
  { entryId: 1, teamName: 'Team A', playerName: 'Ann', rank: 2, total: 320, gwScore: 64, gwHit: 0, form: 60 },
  { entryId: 3, teamName: 'Team C', playerName: 'Cy', rank: 3, total: 300, gwScore: 50, gwHit: 8, form: null },
  { entryId: 4, teamName: 'Team D', playerName: 'Di', rank: 4, total: 280, gwScore: null, gwHit: null, form: 55 },
];
const rivals = {
  event: 5, leaderboard, podium: leaderboard.slice(0, 3), gwTop: [{ ...leaderboard[0], score: 70 }],
  captains: [{ entryId: 1, captain: 10, squadEvent: 5 }, { entryId: 2, captain: 10, squadEvent: 5 }, { entryId: 3, captain: 11, squadEvent: 5 }, { entryId: 4, captain: 10, squadEvent: 4 }],
  players: [{ id: 10, webName: 'Haaland' }, { id: 11, webName: 'Salah' }],
  strategy: { bandwagon: [{ elementId: 20, webName: 'Palmer', count: 3 }] },
};

test('full summary: winner, podium with medals and facts', () => {
  const text = whatsappSummary({ groupName: 'FFM300', season: '2026-27', result: { status: 'FINAL', winners: [2], winningScore: 70 }, rivals });
  assert.equal(text, [
    '🏆 *FFM300 — GW5* (2026-27)',
    '👑 GW winner: Team B (Bob) — 70 pts',
    '',
    '📊 *Overall standings*',
    '🥇 Team B (Bob) — 330 pts',
    '🥈 Team A (Ann) — 320 pts',
    '🥉 Team C (Cy) — 300 pts',
    '',
    '💸 Biggest hit: Team C (Cy) (−8)',
    '🎯 Most captained: Haaland (2/4)',
    '🚀 Bandwagon: Palmer bought by 3',
    '🔥 In form: Team B (Bob) (72.3 avg, last 3)',
  ].join('\n'));
});

test('shared, overridden and provisional results are worded honestly', () => {
  const shared = whatsappSummary({ groupName: 'G', season: 's', result: { status: 'FINAL', winners: [2, 1], winningScore: 64 }, rivals });
  assert.match(shared, /🤝 GW winners \(shared\): Team B \(Bob\) & Team A \(Ann\) — 64 pts/);
  const over = whatsappSummary({ groupName: 'G', season: 's', result: { status: 'OVERRIDDEN', winners: [1], winningScore: 70 }, rivals });
  assert.match(over, /👑 GW winner: Team A \(Ann\) \(declared by the admin\)/);
  const prov = whatsappSummary({ groupName: 'G', season: 's', result: { status: 'PROVISIONAL', winners: [2], winningScore: 70 }, rivals });
  assert.match(prov, /⏳ Leading \(not final yet\)/);
  const none = whatsappSummary({ groupName: 'G', season: 's', result: { status: 'BLOCKED', winners: [] }, rivals });
  assert.match(none, /⏳ Top this GW \(not final yet\): Team B \(Bob\) — 70 pts/);
});

test('big ties stay short: 3 names + "N more", podium capped at 3 lines', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ entryId: i + 1, teamName: `T${i + 1}`, playerName: '', rank: 1, total: 300, gwScore: 64, gwHit: 0, form: null }));
  const text = whatsappSummary({ groupName: 'G', season: 's', result: { status: 'FINAL', winners: many.map((m) => m.entryId), winningScore: 64 }, rivals: { ...rivals, leaderboard: many, podium: many, captains: [], strategy: { bandwagon: [] } } });
  assert.match(text, /🤝 GW winners \(shared\): T1 & T2 & T3 & 7 more — 64 pts/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('🥇')).length, 3);
  assert.match(text, /…and 7 more tied/);
});

test('sections without data are omitted; no rivals → no summary', () => {
  const bare = whatsappSummary({ groupName: 'G', season: 's', result: null, rivals: { ...rivals, leaderboard: leaderboard.map((l) => ({ ...l, gwHit: 0, form: null })), captains: [], strategy: { bandwagon: [{ elementId: 9, count: 1 }] } } });
  assert.doesNotMatch(bare, /Biggest hit|Most captained|Bandwagon|In form/);
  assert.equal(whatsappSummary({ groupName: 'G', season: 's', result: null, rivals: null }), null);
});

test('money and signed numbers', () => {
  assert.deepEqual([money(1002), money(5), money(null)], ['£100.2m', '£0.5m', '–']);
  assert.deepEqual([signed(5), signed(-3), signed(0), signed(null)], ['+5', '−3', '0', '–']);
});
