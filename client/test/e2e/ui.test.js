import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { chromium } from 'playwright-core';
import { startTestDb } from '../../../server/test/helpers/memoryReplSet.js';
import { createWorld, LEAGUE, GW } from '../../../server/test/helpers/fplWorld.js';
import { serveWorld, startProdServer } from '../../../server/test/helpers/prodServer.js';

// Step 13 (v0.2 §17 step 8 gate, "M3: a real finished GW finalized from a phone;
// trace path opens"): the built client, served by the real production server,
// driven in headless Chromium at phone size. Synthetic FPL data only.

const DIST = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
const PASSWORD = `pw-${randomUUID()}`;
const SEASON = '2026-27';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let t;
let fpl;
let app;
let browser;
let dbName;
const problems = []; // page errors, CSP violations, failed API calls

before(async () => {
  assert.ok(existsSync(DIST), 'build the client first (npm run build)');
  t = await startTestDb();
  dbName = `fpl_rival_ui_${randomUUID().slice(0, 8)}`;
  const world = createWorld();
  world.state.elementPatch = {
    2: { status: 'd', news: 'Knock - 75% chance of playing', news_added: '2026-09-21T10:00:00Z', chance_of_playing_next_round: 75 },
    5: { status: 'i', news: 'Hamstring injury - Expected back 04 Oct', news_added: '2026-09-20T10:00:00Z', chance_of_playing_next_round: 0 },
    25: { status: 'i', news: 'Nobody owns him', news_added: '2026-09-22T10:00:00Z' },
  };
  fpl = await serveWorld(world);
  app = await startProdServer({
    MONGODB_URI: t.uri,
    MONGODB_DB: dbName,
    JWT_SECRET: randomUUID() + randomUUID(),
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
    TICK_SECRET: randomUUID() + randomUUID(),
    FPL_API_BASE_URL: fpl.baseUrl,
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  if (app) assert.equal((await app.stop()).code, 0);
  await fpl?.close();
  await mongoose.connection.client.db(dbName).dropDatabase().catch(() => {});
  await t?.stop();
});

async function newPage() {
  // The server sets a Secure cookie; Chromium accepts it on http://127.0.0.1 (a potentially trustworthy origin).
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return { ctx, page };
}

const noHorizontalScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

let adminPage;
let groupUrl;
let shareUrl;

test('anonymous visitors land on the sign-in page; a wrong password is refused', async () => {
  const { page } = await newPage();
  adminPage = page;
  await page.goto(app.base);
  await page.waitForURL('**/login');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').getByText('INVALID_CREDENTIALS').waitFor();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Groups' }).waitFor();
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'fpl_admin');
  assert.deepEqual([c.httpOnly, c.secure, c.sameSite, c.path], [true, true, 'Strict', '/api']);
  assert.equal(await page.evaluate(() => document.cookie), '', 'the session is invisible to scripts');
});

test('create a league group from a phone: preview, pick "me", create', async () => {
  const page = adminPage;
  await page.getByRole('link', { name: 'New group' }).click();
  await page.getByLabel('Name').fill('Rivals');
  await page.getByLabel('League ID').fill(String(LEAGUE));
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByTestId('league-preview').getByText('3 members').waitFor();
  await page.getByLabel('Me (optional)').selectOption({ label: 'Team 101 (Manager 101)' });
  assert.ok(await noHorizontalScroll(page), 'form fits a phone screen');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByTestId('group-name').getByText('Rivals').waitFor();
  groupUrl = page.url().replace(/\?.*$/, '');
  assert.match(groupUrl, /\/groups\/[a-f0-9]{24}\/results$/);
});

test('results: blocked before sync with reasons, then sync and finalize a finished GW', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('result-status').getByText('BLOCKED').waitFor();
  const gate = await page.getByTestId('finalize-gate').innerText();
  assert.match(gate, /not marked this gameweek as data-checked/);
  await page.getByTestId('sync').click();
  await page.getByTestId('sync-result').getByText('Sync SUCCESS').waitFor();
  await page.getByTestId('result-status').getByText('PROVISIONAL').waitFor();
  await page.getByTestId('finalize').click();
  await page.getByTestId('result-status').getByText('FINAL').waitFor();
  assert.match(await page.getByTestId('winners').innerText(), /Winner: Team 103 \(Manager 103\) — 61 pts/);
  assert.equal(await page.getByTestId('announcement').innerText(), `Rivals · GW${GW} ${SEASON}: Team 103 (Manager 103) wins with 61 pts.`);
  const ranks = await page.getByTestId('standings').locator('[data-testid^="rank-"]').allInnerTexts();
  assert.deepEqual(ranks.map((r) => r.trim()), ['1', '2', '3']);
  assert.ok(await page.getByTestId('row-101').getByText('me').isVisible(), '"me" is highlighted');
  assert.ok(await noHorizontalScroll(page), 'results fit a phone screen');
});

test('history drawer: newest first, chain badge valid; the trace path opens and verifies', async () => {
  const page = adminPage;
  await page.getByTestId('open-history').click();
  const drawer = page.getByTestId('history-drawer');
  await drawer.getByTestId('chain-badge').getByText('Chain valid').waitFor();
  assert.match(await drawer.getByTestId('action-1').innerText(), /#1 FINALIZE[\s\S]*PROVISIONAL[\s\S]*FINAL[\s\S]*Team 103/);
  await page.keyboard.press('Escape');
  await page.getByTestId('trace-link').click();
  const verify = page.getByTestId('snapshot-verify');
  await verify.getByText('Content hash valid').waitFor();
  await verify.getByText('Reproduces from its inputs').waitFor();
  assert.match(await page.getByTestId('trace').innerText(), /Source run[\s\S]*\/entry\/101\/history\//);
});

test('ownership, captaincy, transfers and chips render for the GW', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl.replace(/results$/, 'ownership')}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('ownership-table').waitFor();
  assert.match(await page.getByTestId('denominators').innerText(), /Out of 2 rivals/);
  await page.getByTestId('view-picked').click();
  await page.getByText('Picked: the team as submitted at the deadline.').waitFor();
  assert.equal(await page.getByTestId('captaincy-table').locator('[data-testid^="cap-"]').count(), 3);
  await page.getByTestId('transfer-totals').waitFor();
  await page.getByRole('link', { name: 'Chips' }).click();
  await page.getByTestId('chip-source').getByText('Rules from FPL').waitFor();
  assert.equal(await page.getByTestId('chip-states').locator('[data-testid^="chip-row-"]').count(), 3);
  assert.ok(await noHorizontalScroll(page));
});

test('commissioner tools: podium and WhatsApp summary on Results and Leaderboards', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('podium').waitFor();
  assert.equal(await page.getByTestId('podium').locator('[data-testid^="podium-"]').count(), 3);
  await page.getByTestId('whatsapp').getByRole('button', { name: 'Preview' }).click();
  const text = await page.getByTestId('whatsapp-text').innerText();
  assert.match(text, new RegExp(`^🏆 \\*Rivals — GW${GW}\\* \\(${SEASON}\\)`));
  assert.match(text, /👑 GW winner: Team 103 \(Manager 103\) — 61 pts/);
  assert.match(text, /🥇 .* pts/);
  assert.equal(await page.getByTestId('whatsapp').getByRole('link', { name: 'Open WhatsApp' }).getAttribute('href'), `https://wa.me/?text=${encodeURIComponent(text)}`);
  await page.getByRole('link', { name: 'Boards' }).click();
  await page.getByTestId('board-rivals').waitFor();
  assert.match(await page.getByTestId('gw-winner-rivals').innerText(), /GW5 winner[\s\S]*Team 103/i);
  assert.equal(await page.getByTestId('podium-rivals').locator('[data-testid^="podium-rivals-"]').count(), 3);
  assert.ok(await noHorizontalScroll(page));
});

test('spy vs me, rival radar and strategy lab render from the rivals API', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl.replace(/results$/, 'rivals')}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('spy').waitFor();
  assert.match(await page.getByTestId('threat').innerText(), /(🔥 HIGH|⚠️ MEDIUM|🧊 LOW)/);
  assert.match(await page.getByTestId('h2h').innerText(), /Head to head: (You lead|They lead|Level) \d+–\d+/);
  assert.match(await page.locator('[data-testid="spy"] + div').innerText(), /XI OVERLAP[\s\S]*11\/11/i);
  assert.equal(await page.getByTestId('radar').locator('li').count(), 2, 'two rivals besides me');
  await page.getByTestId('pick-102').click();
  assert.match(await page.getByTestId('spy').innerText(), /Team 102/);
  await page.getByRole('link', { name: 'Strategy' }).click();
  await page.getByTestId('xpts').waitFor();
  assert.equal(await page.getByTestId('xpts').locator('li').count(), 3);
  assert.equal(await page.getByTestId('fdr').locator('li').count(), 3);
  assert.ok(await noHorizontalScroll(page));
});

test('injury & news: the squad alert strip on Results and the News tab', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('squad-alerts').waitFor();
  const strip = await page.getByTestId('squad-alerts').innerText();
  assert.match(strip, /Your squad: 2 alerts/);
  assert.match(strip, /P5[\s\S]*Injured[\s\S]*P2[\s\S]*Doubt · 75%/, 'most severe first');
  await page.getByRole('link', { name: 'All news' }).click();
  await page.getByTestId('news-list').waitFor();
  const list = page.getByTestId('news-list');
  assert.equal(await list.locator('li').count(), 2, 'only players someone in the group owns');
  assert.match(await list.locator('li').first().innerText(), /P2[\s\S]*Knock/, 'newest news first');
  assert.match(await page.getByTestId('news-5').innerText(), /🔴 Injured[\s\S]*Hamstring/);
  assert.match(await page.getByTestId('news-asof').innerText(), /FPL data as of/);
  await page.getByTestId('news-filter-rivals').click();
  assert.equal(await list.locator('li').count(), 2, 'rivals own the same players in this world');
  assert.ok(await noHorizontalScroll(page));
});

test('differential finder: filters in the URL, group vs world ownership', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl.replace(/results$/, 'finder')}?season=${SEASON}&gw=${GW}&maxGroupOwners=0`);
  await page.getByTestId('finder-list').waitFor();
  assert.match(await page.getByTestId('finder-count').innerText(), /^15 players$/, 'players 16–30: nobody in the group owns them');
  assert.match(await page.getByTestId('finder-list').locator('li').first().getByTestId('finder-ownership').innerText(), /world · 0\/3 /);
  await page.getByTestId('finder-fit').click();
  await page.waitForURL(/fit=true/);
  await page.getByTestId('finder-count').filter({ hasText: /^14 players$/ }).waitFor();
  await page.getByTestId('finder-pos-DEF').click();
  await page.waitForURL(/position=DEF/);
  await page.getByTestId('finder-count').filter({ hasText: /^4 players$/ }).waitFor();
  assert.ok(new URL(page.url()).searchParams.get('maxGroupOwners') === '0', 'earlier filters kept');
  assert.ok(await noHorizontalScroll(page));
});

test('override with a note appends to the history; the chain stays valid', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl}?season=${SEASON}&gw=${GW}`);
  await page.getByRole('button', { name: 'Override…' }).click();
  const panel = page.getByTestId('override-panel');
  await panel.getByLabel('Team 102 (Manager 102)').check();
  const submit = panel.getByRole('button', { name: 'Declare winner' });
  assert.equal(await submit.isDisabled(), true, 'a note is required');
  await panel.getByLabel(/Note/).fill('Agreed in the group chat');
  await submit.click();
  await page.getByTestId('result-status').getByText('OVERRIDDEN').waitFor();
  await page.getByTestId('open-history').click();
  const drawer = page.getByTestId('history-drawer');
  await drawer.getByTestId('chain-badge').getByText('Chain valid').waitFor();
  assert.match(await drawer.getByTestId('action-2').innerText(), /#2 OVERRIDE[\s\S]*Team 103[\s\S]*Team 102[\s\S]*Agreed in the group chat/);
  await page.keyboard.press('Escape');
});

test('status page and a run\'s request log', async () => {
  const page = adminPage;
  await page.getByRole('link', { name: 'Status' }).click();
  await page.getByTestId('semantics').waitFor();
  assert.match(await page.getByTestId('storage').innerText(), /of 512\.0 MB/);
  await page.getByTestId('runs').getByRole('link', { name: 'Details' }).first().click();
  await page.getByTestId('requests').waitFor();
  assert.ok((await page.getByTestId('requests').locator('tbody tr').count()) > 0);
});

test('share link: a viewer opens the group read-only; revoking closes it', async () => {
  const page = adminPage;
  await page.goto(`${groupUrl.replace(/results$/, 'settings')}?season=${SEASON}&gw=${GW}`);
  await page.getByTestId('rotate-share').click();
  shareUrl = await page.getByTestId('share-link').inputValue();
  assert.match(shareUrl, /\/share#[A-Za-z0-9_-]{43}$/, 'token in the fragment, not the path');

  const { ctx, page: viewer } = await newPage();
  const requested = [];
  viewer.on('request', (r) => requested.push(r.url()));
  await viewer.goto(shareUrl);
  await viewer.getByTestId('result-status').getByText('OVERRIDDEN').waitFor();
  assert.ok(!viewer.url().includes('#'), 'token removed from the address bar');
  assert.equal(await viewer.getByRole('link', { name: 'Settings' }).count(), 0, 'no settings tab');
  assert.equal(await viewer.getByTestId('sync').count(), 0, 'no admin actions');
  const token = shareUrl.split('#')[1];
  assert.ok(requested.every((u) => !u.includes(token)), 'the token never appears in a request URL');
  await viewer.goto(app.base);
  await viewer.waitForURL(/\/groups\/[a-f0-9]{24}\/results/);

  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Create link' }).waitFor();
  await viewer.reload();
  await viewer.waitForURL('**/login');
  await ctx.close();
});

test('no page errors, CSP violations or server errors along the way; no secrets in the server log', () => {
  assert.deepEqual(problems, []);
  assert.ok(!app.out().includes(PASSWORD));
});
