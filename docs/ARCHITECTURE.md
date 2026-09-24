FPL Rival Dashboard — v0.2 Architecture Corrections
Sep 23, 2026 · @Filimon
1. Change summary
v0.2 makes every declared winner traceable to verified FPL data. Points are reconciled against season totals before use, finalization is gated on data_checked plus a fresh sync, and every decision is appended to an immutable audit trail. Where this document and v0.1 disagree, v0.2 wins. Sections of v0.1 not listed below stand unchanged.
#
Change
Supersedes (v0.1)
1
Point reconciliation layer. No assumption that points is gross
§7 fields, §10.1
2
Explicit event state machine; finalize only at DATA_CHECKED + a fresh sync
§10.2 step 6, §13
3
Append-only gw_result_actions + immutable result_snapshots
§9 gw_results, §11 finalize/override
4
Archive instead of delete (is_active=false)
§4 settings, §11 DELETE /groups
5
competitionRank and resolvedPosition as separate fields
§10.2 rank note, §12 ResultRow.rank
6
Picked vs effective ownership, derived from auto-subs + chips
§10.5, §10.6, §10.6a
7
bootstrap.chips[] authoritative; config only as a fallback
§10.9
8
sync_run_id on every snapshot row + result → source-run links
§9
9
Tests with node:test / node:assert (explicitly requested)
§16.3 "no test libraries"
10
Smoke test records shapes and verifies assumptions per endpoint
§16.2 step 2
11
Private league access verified; manual entry-ID fallback, never FPL credentials
§16.5
Runtime bump: Node 22 LTS (instead of 20+), for stable node --test glob patterns and built-in coverage.
2. Point reconciliation
Net GW points are only produced when the reported GW points, the transfer cost and the change in season total agree. Otherwise netGwPoints is null and the result is blocked. The meaning of points (gross or net) is proven per row from the totals, and recorded per season from real 2026/27 responses.
Inputs per (entry, GW)
Symbol
Source
Notes
R
history.current[gw].points
reported GW points
C
history.current[gw].event_transfers_cost
≥ 0
T
history.current[gw].total_points
season total after this GW
Tprev
history.current[gw-1].total_points
previous row for this entry
Rpicks
picks.entry_history.points
second source, cross-check only
Tprev resolution:
• If this is the entry's first row of the season and there's no earlier row, Tprev = 0.
• If the previous GW row is missing but later rows exist (a gap), Tprev is unknown → INCOMPLETE.
• Rows are keyed on event, never on array index.
Hypotheses, tested per row
\Delta = T - T_{prev} \qquad H_{gross}: \Delta = R - C \qquad H_{net}: \Delta = R
Case
Result
C = 0 and Δ = R
RECONCILED_NO_COST, net = R. Semantics irrelevant
C > 0, only H_gross holds
Row evidence = GROSS_BEFORE_HITS; net = R − C, gross = R
C > 0, only H_net holds
Row evidence = NET_AFTER_HITS; net = R, gross = R + C
C > 0, row evidence ≠ verified season semantics
SEMANTICS_CONFLICT, net = null
Neither holds
MISMATCH, net = null
Tprev unknown
INCOMPLETE, net = null
Rpicks present and ≠ R (picks fetched after DATA_CHECKED)
SOURCE_DISAGREEMENT, net = null
When C > 0, both hypotheses cannot hold at once, so each row with a hit proves the semantics by itself.
Season semantics (season_semantics table)
• The table holds UNVERIFIED until the first C > 0 row reconciles. It then flips to the proven value, with evidence_rows and first_verified_run_id recorded.
• Every later C > 0 row increments evidence_rows or conflict_rows.
• If conflict_rows > 0, the semantics become CONFLICTED. All rows with C > 0 in that season are then marked SEMANTICS_CONFLICT until the admin investigates. Rows with C = 0 stay valid.
• The smoke test (§11) seeds this from real responses before any group goes live.
Normalized model
type NormalizedGwPoints = {
  entryId: number; season: string; event: number;
  reportedGwPoints: number;             // R, as FPL sent it
  transferCost: number;                 // C
  netGwPoints: number | null;           // null unless reconciled
  grossGwPoints: number | null;         // null unless reconciled
  totalPoints: number;                  // T
  previousTotalPoints: number | null;   // Tprev
  pointsSemantics: 'GROSS_BEFORE_HITS' | 'NET_AFTER_HITS' | 'UNVERIFIED' | 'CONFLICTED';
  reconciliationStatus: 'RECONCILED' | 'RECONCILED_NO_COST' | 'MISMATCH'
    | 'SEMANTICS_CONFLICT' | 'SOURCE_DISAGREEMENT' | 'INCOMPLETE';
  reconciliationDetail: { delta: number | null; hypothesis: 'GROSS'|'NET'|'NONE'|'BOTH'; picksPoints: number | null };
};
Fail-safe rules
• Winner computation uses netGwPoints or grossGwPoints only. A null on any eligible manager makes the GW result BLOCKED, with the failing managers listed. It never silently falls back to R.
• A blocked result can't be finalized. The admin can resync, or record an OVERRIDE with a mandatory note (§4), which captures the failing reconciliation detail in the snapshot.
• Analytics that don't depend on points (ownership, captaincy, chips) still render during a block.
• Before DATA_CHECKED, reconciliation still runs but mismatches show as warnings. Totals can legitimately lag during live updates.
3. Gameweek state and finalization gate
Finalization is allowed only when FPL reports data_checked = true and every eligible manager's data was synced after that flag was first observed. Fixture completion alone never unlocks finalization.
There are two state layers:
• The event state is global per season + GW, derived from FPL.
• The result state is per group + GW, driven by the admin.
FINALIZED_BY_ADMIN lives in the result layer, because two groups can finalize the same GW at different times.
stateDiagram-v2
  [*] --> UPCOMING
  UPCOMING --> LIVE: deadline passed
  LIVE --> MATCHES_FINISHED: all GW fixtures finished_provisional
  MATCHES_FINISHED --> FPL_PROCESSING: event.finished
  FPL_PROCESSING --> DATA_CHECKED: event.data_checked
  DATA_CHECKED --> FINALIZED_BY_ADMIN: admin finalize (per group)
  DATA_CHECKED --> FPL_PROCESSING: data_checked reverts
Derivation (deriveEventState, evaluated in order)
State
Condition
DATA_CHECKED
event.data_checked === true
FPL_PROCESSING
event.finished === true and not data_checked
MATCHES_FINISHED
every fixture with event = gw has finished_provisional === true (or finished), and event.finished === false
LIVE
now ≥ deadline_time
UPCOMING
otherwise
UPCOMING and LIVE are added for the UI; the four required states are unchanged. Fixtures moved to another GW (or with event = null) are ignored for the GW they left. If the fixtures data is missing, the state can't advance past LIVE unless event.finished is true.
Tracking
• events.state is stored.
• events.data_checked_observed_at is set by the first sync that sees the flag true. It is cleared if the flag reverts.
Result states (per group + GW)
Status
Meaning
PROVISIONAL
Computed on read; nothing stored
BLOCKED
Computed on read; a reconciliation failure or missing data prevents a winner
FINAL
= FINALIZED_BY_ADMIN; frozen snapshot stored
OVERRIDDEN
Admin-declared winner(s) with a note; frozen snapshot stored
Finalize gate: canFinalize returns { allowed, reasons[] }. Every check must pass:
1. The group is active (not archived).
2. eventState === 'DATA_CHECKED'.
3. The result status is PROVISIONAL (not already FINAL/OVERRIDDEN; use recompute or override for those).
4. For each eligible manager, the GW row's sync_run_id points to a SUCCESS run whose started_at > data_checked_observed_at. The finalize endpoint runs that sync itself first, so in practice this is one click.
5. Every eligible manager's reconciliationStatus is RECONCILED or RECONCILED_NO_COST.
6. At least one manager is eligible.
If data_checked later reverts, existing FINAL results stay, but carry a SOURCE_STATE_REGRESSED warning until DATA_CHECKED returns and a recompute preview shows no diff.
4. Result audit trail
Every finalize, override and recompute appends one row to gw_result_actions and one immutable row to result_snapshots. Nothing is ever updated or deleted in either table. gw_results is just a pointer to the current snapshot.
Tables
• result_snapshots (immutable) holds the complete frozen computation: the standings, winners, rule and tie-break chain used, the normalized inputs, inputs_hash, the engine version, and the event state.
• gw_result_actions (append-only) holds the decision log.
• gw_results holds the current projection: (group, season, event) → status, current_snapshot_id. It's the only mutable table of the three.
gw_result_actions fields
Field
Notes
id
bigserial
group_id, season, event

action
FINALIZE | OVERRIDE | RECOMPUTE
prev_status / new_status
PROVISIONAL | FINAL | OVERRIDDEN
prev_winner_entry_ids / new_winner_entry_ids
int[]. Previous is {} on the first finalize
prev_snapshot_id / new_snapshot_id
FK → result_snapshots
note
required for OVERRIDE, and for RECOMPUTE when winners change
sync_run_id
the run that fed the new snapshot (null for an override without resync)
actor
'admin' for now
created_at
timestamptz
Action rules
Action
Allowed from
Result
Note required
FINALIZE
PROVISIONAL + gate passes (§3)
FINAL
No (optional)
OVERRIDE
PROVISIONAL/BLOCKED at DATA_CHECKED, or FINAL, or OVERRIDDEN
OVERRIDDEN
Yes, 3–280 chars
RECOMPUTE
FINAL or OVERRIDDEN, at DATA_CHECKED, reconciliation clean
FINAL (rule-based again)
Yes, if winners change
• An override snapshot stores the computed standings too, so you can always see what the rules said versus what was declared.
• Recompute first returns a preview diff (dryRun: true) showing the old vs new winners and changed rows. Committing requires a second call.
• Enforcement: a migration adds BEFORE UPDATE OR DELETE triggers on gw_result_actions and result_snapshots that raise an exception. The app DB role also gets no UPDATE/DELETE grant on them where the host allows it.
• The Results page shows a "History" drawer, listing all actions newest first with the old → new winners, notes and sync run links.
API additions
• GET /groups/:groupId/gw/:gw/actions → the action list.
• GET /result-snapshots/:snapshotId → the full snapshot, including inputs and source runs.
• POST /groups/:groupId/gw/:gw/recompute with body { dryRun: boolean, note? }.
5. Archive groups
Groups are never physically deleted in the MVP. Archiving sets is_active = false and archived_at, and removes the group from syncs and from the scheduler. All snapshots, results and audit rows stay readable.
• UI: Settings → Archive group, with a confirm dialog. Archived groups appear under a collapsed "Archived" section on Home, with an Unarchive action.
• Archived = read-only: no sync, finalize, override, recompute or settings edits (except unarchive). These return 409 GROUP_ARCHIVED.
• API: DELETE /groups/:id is removed. Use POST /groups/:id/archive and POST /groups/:id/unarchive. GET /groups?includeArchived=true lists them.
• DB: foreign keys to groups use ON DELETE RESTRICT (was CASCADE), so an accidental SQL delete fails loudly.
• League ID reuse: fpl_league_id stays unique across active and archived groups. Creating a group with an archived group's league ID returns 409 LEAGUE_ALREADY_CONFIGURED with the archived group's ID, and the UI offers Unarchive.
6. Ranking model
Every results row carries two independent fields. competitionRank comes from the score only. resolvedPosition is a unique, deterministic order after tie-breaks. Winners are decided separately and never inferred from either field alone.
Field
Definition
Ties
Example (scores 78, 78, 71, 71, 60)
competitionRank
1 + count(score > mine) among eligible managers
Equal scores share a rank
1, 1, 3, 3, 5
resolvedPosition
1…N after sorting by score desc, then the group's tie-break chain (without SHARED), then entryId asc as the final deterministic key
Always unique
1, 2, 3, 4, 5
tiedWith
entryIds sharing this row's competitionRank

row 1 → [row 2]
positionDecidedBy
the tie-break rule that separated this row from the one above, or ENTRY_ID_FALLBACK, or null

row 2 → FEWER_TRANSFER_COST
Winners are computed separately:
1. candidates = rows with competitionRank = 1.
2. Apply the tie-break chain until it hits SHARED or one candidate remains.
3. The remaining candidates are the winners.
The entryId fallback is never used to pick a winner. It only makes the table order stable. So if two managers share the win, they get resolvedPosition 1 and 2 but both appear in winners, and the UI shows both with a "shared" badge.
Ineligible rows (excluded, joined later, no team) get competitionRank = null, resolvedPosition = null and an ineligibleReason, and sort to the bottom by name.
UI: the column "Rank" shows competitionRank (with "=" for ties, e.g. "=1"). The table order follows resolvedPosition. A tie-break icon on a row explains positionDecidedBy on hover or tap.
7. Picked vs effective ownership
Ownership now has two families. Picked metrics describe the team as submitted at the deadline. Effective metrics describe what actually scored, after auto-subs, chips and captain failure. The engine derives effective multipliers itself and treats FPL's multiplier field only as a cross-check, never as the source.
Five distinct measures
Measure
Per manager
Source
Picked squad
player ∈ 15 picks
picks
Picked XI
squad_position ≤ 11
picks
Picked captaincy
is_captain (plus isTriple if active_chip = 3xc)
picks + chip
Effective multiplier
0–3 after the derivation below
picks + chip + auto-subs + live minutes
Effective captain
captain, VC or none, after failure handling
picks + live minutes
Effective multiplier derivation (deriveEffectiveSquad, per manager per GW)
1. Base: positions 1–11 get 1, and 12–15 get 0. If active_chip = 'bboost', all 15 get 1.
2. Auto-subs:
    ◦ Not applied under bench boost.
    ◦ Otherwise, for each {element_in, element_out} in FPL's automatic_subs, out → 0 and in → 1. autoSubSource = 'FPL'.
    ◦ If FPL provides none and the event is before DATA_CHECKED, then in V1 the engine simulates them (formation rules, bench order, GK↔GK). autoSubSource = 'SIMULATED'. In the MVP it uses NONE and flags the result as provisional.
3. Captain multiplier: capMult = 3 if active_chip = '3xc', else 2.
4. Captain resolution. A player "played" means live.minutes > 0 summed across all of their fixtures this GW. "Settled" means all of their GW fixtures are finished, or they have minutes > 0.
    ◦ Captain played → captain gets capMult, and effectiveCaptain = { via: 'CAPTAIN' }.
    ◦ Captain settled with 0 min and VC played → VC gets capMult (triple under 3xc), and via: 'VICE'.
    ◦ Both settled with 0 min → no one is multiplied, and via: 'NONE'.
    ◦ Captain not settled → via: 'PENDING'. The picked multiplier is used provisionally.
    ◦ The captain's own effective base drops to 0 when they're auto-subbed out, which happens automatically with 0 min.
5. Unknown chip: multipliers follow steps 1–4 with no chip effect, and a warning UNKNOWN_CHIP is attached.
Cross-checks (warnings, not blockers)
• Points reconstruction: at DATA_CHECKED, Σ effectiveMultiplier × live.total_points must equal grossGwPoints. If it doesn't → EFFECTIVE_POINTS_MISMATCH on that manager.
• FPL multiplier agreement: if FPL's final multiplier differs from the derived one → FPL_MULTIPLIER_DIFFERS. The smoke test (§11) records how FPL behaves here.
Group metrics (scope S, player p)
\text{pickedEO}_S(p) = \frac{\sum_{m} \text{pickedMult}_m(p)}{N_S} \qquad \text{effectiveEO}_S(p) = \frac{\sum_{m} \text{effMult}_m(p)}{N_S}
pickedMult = 1 for XI, capMult for the captain, 0 for bench, or 1 for bench under bench boost. Exposure is reported both ways: pickedExposure = pickedMult_me − pickedEO_rivals and effectiveExposure = effMult_me − effectiveEO_rivals.
Denominators
Symbol
Definition
N_S
eligible members in scope with picks for this GW
Excluded from N_S
excluded members, joined-later members, managers with no picks row (missingEntryIds reported)
N_rivals
N_all − 1 when Me is eligible and has picks, otherwise N_all
Every ownership response returns { denominator, missingEntryIds } per scope. The UI shows "7/8 (1 missing)" instead of silently shrinking.
Default view by state: picked metrics before MATCHES_FINISHED, and effective metrics after (with a toggle). Captaincy shows both "picked captain" and "effective captain" columns.
8. Chip rules
bootstrap-static.chips[] is the only source of chip windows whenever it is present and valid. The season config file is read only when bootstrap lacks chips[] or fails validation, and results show a visible CONFIG_FALLBACK warning. The two sources are never merged.
• Stored in chip_rules per season: chip_name, number, start_event, stop_event, chip_type, source, sync_run_id. Each bootstrap sync replaces the season's FPL_BOOTSTRAP rows atomically.
• Validation of chips[]: each item needs name (string), number ≥ 1, and 1 ≤ start_event ≤ stop_event ≤ 38. Windows for the same name must not overlap. If any item fails, the whole set is rejected: the previous valid rules are kept, and CHIP_RULES_INVALID is logged with the raw payload.
• Fallback: server/config/chipRules.<season>.json is loaded only when there are no valid FPL_BOOTSTRAP rows for the season. Its rows are stored with source = CONFIG_FALLBACK. They are replaced the first time bootstrap provides valid rules.
• Matching played chips: history.chips[].name must match chip_rules.chip_name exactly. An unmatched name → UNMAPPED status, shown with its raw name, and it doesn't count against any window.
• Availability: for rule r and manager m, used = count(played chips with name = r.name and r.start ≤ event ≤ r.stop), and available = used < r.number. A chip is "current" when r.start ≤ currentEvent ≤ r.stop.
• No hard-coded windows in code. Chip display labels ("Bench Boost") come from a label map with a raw-name fallback.
9. Snapshot traceability
The unit of provenance is the sync_run. Every snapshot row records the run that last wrote it, and every finalized result links to the exact runs and request hashes that produced its inputs.
• sync_run_id on every snapshot table: events, teams, players, fixtures, chip_rules, manager_gameweeks, manager_picks, manager_auto_subs, manager_transfers, manager_chips and player_gameweek_points.
• sync_run_requests: one row per FPL call in a run, holding the path, HTTP status, body_sha256, bytes, duration, schema_ok and an optional raw_response_id. This proves which response bytes fed a row.
• result_snapshots:
    ◦ Stores inputs (the normalized rows used: GW points, picks, effective squads, tie-break data) as JSONB, plus inputs_hash = sha256(canonical JSON).
    ◦ result_snapshot_sources(snapshot_id, sync_run_id) lists every distinct run behind those inputs.
    ◦ result_snapshots.id is the source_snapshot_id referenced by gw_results.current_snapshot_id and by gw_result_actions.new_snapshot_id.
• Raw evidence retention: fpl_raw_responses rows are kept permanently when their run is referenced by a FINAL/OVERRIDDEN snapshot (retain_until = null). Otherwise they're pruned after 14 days. For a finalize sync, raw bodies are stored for the history, picks and live calls: about 25 responses per group per GW, well under 1 MB.
• Tamper check: GET /result-snapshots/:id/verify recomputes the result from the stored inputs with the stored engine_version and compares the hashes. A mismatch means the engine changed behaviour, so it's reported but nothing is changed.
Trace path for any declared winner: gw_results → result_snapshots → result_snapshot_sources → sync_runs → sync_run_requests → fpl_raw_responses.
10. Private league access
It's an unverified assumption that private classic league standings can be read without authentication. The app never stores FPL credentials. If standings can't be read anonymously, the group uses a manual list of entry IDs, each validated against the public /entry/{id}/ endpoint.
• Member source per group: member_source = LEAGUE_STANDINGS | MANUAL. fpl_league_id becomes nullable, and is required only for LEAGUE_STANDINGS.
• Verification: the smoke test (§11) and the create-group preview both call standings anonymously. The response is classified as follows:
    ◦ OK: 200 and standings.results.length > 0.
    ◦ AUTH_REQUIRED: 401/403, or a login redirect or login HTML.
    ◦ EMPTY: 200 with 0 results, when the league is known to have members.
    ◦ NOT_FOUND: 404.
• On AUTH_REQUIRED or EMPTY during create: the form switches to manual mode, with the league ID kept as a label only. The admin pastes entry IDs (comma or newline separated, from fantasy.premierleague.com/entry/{id}/… URLs). Each is validated with /entry/{id}/, which fills in the name and team.
• On AUTH_REQUIRED during a later sync of a league-sourced group: members are frozen to the last known list, the run is marked PARTIAL with LEAGUE_AUTH_REQUIRED, and a banner offers "Switch to manual (prefilled with 10 known IDs)".
• Manual members: added with POST /groups/:id/members { entryIds: number[] } and removed by exclusion (isExcluded = true), never deleted, so history stays intact.
• Out of scope: FPL login, session cookies, or any credential storage.
11. FPL API smoke test
npm run fpl:smoke calls all 9 endpoints the app uses and records each response's exact shape. It then checks the zod schemas and every API assumption against real 2026/27 data. It must pass before M2 starts and is re-run at every season start. Nothing in the integration is trusted until the smoke test has confirmed it.
Invocation
npm run fpl:smoke -- --league 123456 --league 654321 --entry 111 --entry 222 --gw 5 [--update-baseline]
--entry should include at least one manager who took a hit this season, so the reconciliation hypotheses get evidence.
Outputs (committed to server/fpl-contract/2026-27/)
• <endpoint>.shape.json: the type tree. Key paths with types (number|string|boolean|null|object|array<…>), nullability seen, and array length ranges.
• <endpoint>.sample.json: an anonymized sample (manager and player names replaced with Manager N/Team N; bootstrap trimmed to 20 elements). These double as test fixtures.
• smoke-report.md: pass/fail per check, a shape diff vs the baseline (added, removed or retyped keys), and verdicts on each assumption.
Exit codes: 0 = all pass. 1 = schema break (a required field is missing or retyped). 2 = an assumption failed (e.g. reconciliation CONFLICTED, league AUTH_REQUIRED). 3 = network or blocked (403/429 from Cloudflare).
Explicit checks per endpoint
Endpoint
Checks
bootstrap-static
38 events with id, deadline_time, finished, data_checked, is_current, is_next; exactly one is_current (or none pre-season); 20 teams; elements[] required fields; element_type ∈ 1..4; presence and shape of chips[] (records whether windows are provided); derived season string
fixtures
Fields event, team_h, team_a, team_h_difficulty, team_a_difficulty, kickoff_time, started, finished, finished_provisional; event nullable; ?event=gw filter returns only that GW
event-status
status[] with event, bonus_added, points; leagues value recorded verbatim
leagues-classic/{id}/standings
Anonymous access classification (§10); league.id/name; standings.results[].entry, entry_name, player_name; has_next; page size recorded
entry/{id}
player_first_name, player_last_name, name; 404 for a nonexistent ID
entry/{id}/history
current[] fields incl. points, total_points, event_transfers_cost; chips[] names seen; reconciliation hypotheses evaluated for every row, with season semantics derived and written to the report
entry/{id}/event/{gw}/picks
15 picks, positions 1–15 unique, one captain + one VC; active_chip values; automatic_subs[] shape; entry_history.points equals history points; FPL multiplier after auto-subs and captain failure recorded; response for the next GW before its deadline recorded (status + body)
entry/{id}/transfers
element_in, element_out, element_in_cost, element_out_cost, event, time; costs in tenths; whether wildcard/free-hit GWs appear
event/{gw}/live
elements[].id, stats.total_points, stats.minutes; explain[] shape per fixture; Σ effective multiplier × total_points = gross for the sampled entries
Also recorded: HTTP status, content-type, cache-control, response time, whether a "game is being updated" body was seen, and any Cloudflare challenge. Recording these makes block and update behaviour explicit instead of guessed.
Runtime use: the zod schemas in fplSchemas.js are hand-written from the recorded shapes. test/contract/*.test.js parses every committed sample, so schema drift shows up in npm test after a baseline refresh.
12. Revised data model
The model has 22 tables in four families: config, FPL snapshots (all carrying sync_run_id), provenance, and results/audit. Seven are new, and every other table gained or changed fields.
flowchart LR
  G[groups] --> GM[group_members]
  GM --> M[managers]
  M --> MG[manager_gameweeks]
  M --> MP[manager_picks]
  M --> MA[manager_auto_subs]
  SR[sync_runs] --> SRR[sync_run_requests]
  SRR --> RAW[fpl_raw_responses]
  SR -.-> MG
  SR -.-> MP
  G --> GR[gw_results]
  GR --> RS[result_snapshots]
  RS --> RSS[result_snapshot_sources]
  RSS --> SR
  G --> GA[gw_result_actions]
  GA --> RS
Dotted lines mean every snapshot table carries sync_run_id; only two are drawn.
Table
Family
Status
Key changes
groups
Config
Changed
+ member_source, archived_at; fpl_league_id nullable; FKs RESTRICT
group_members
Config
Changed
+ added_manually, added_at
managers
Config
Changed
+ sync_run_id
events
Snapshot
Changed
+ state, data_checked_observed_at, sync_run_id
teams, players, fixtures
Snapshot
Changed
+ sync_run_id; fixtures + finished_provisional
chip_rules
Snapshot
New
Season chip windows + source
season_semantics
Snapshot
New
Proven meaning of points per season
manager_gameweeks
Snapshot
Changed
Normalized points model (§2) + reconciliation_status/detail, picks_reported_points
manager_picks
Snapshot
Changed
multiplier → fpl_multiplier (cross-check only)
manager_auto_subs
Snapshot
New
FPL or simulated auto-subs
manager_transfers, manager_chips
Snapshot
Changed
+ sync_run_id
player_gameweek_points
Snapshot
Changed
+ fixtures_settled, sync_run_id
sync_runs
Provenance
Changed
+ trigger, event
sync_run_requests
Provenance
New
One row per FPL call, with body hash
fpl_raw_responses
Provenance
Changed
+ sync_run_id, retain_until
result_snapshots
Results
New
Immutable frozen computation
result_snapshot_sources
Results
New
snapshot ↔ sync runs
gw_results
Results
Changed
Now only a pointer: status, current_snapshot_id
gw_result_actions
Results
New
Append-only audit
Computed-only (never stored): PROVISIONAL/BLOCKED results, effective squads outside snapshots, and ownership tables.
13. Revised Prisma schema
This is the complete target schema.prisma, with PostgreSQL as the provider. The append-only triggers and the check constraints can't be expressed in Prisma, so they ship in a hand-written SQL migration shown after the schema.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── Enums ───────────────────────────────────────────────
enum WinnerRule { NET_POINTS GROSS_POINTS }
enum MemberSource { LEAGUE_STANDINGS MANUAL }
enum Position { GKP DEF MID FWD }
enum EventState { UPCOMING LIVE MATCHES_FINISHED FPL_PROCESSING DATA_CHECKED }
enum PointsSemantics { GROSS_BEFORE_HITS NET_AFTER_HITS UNVERIFIED CONFLICTED }
enum ReconciliationStatus {
  RECONCILED
  RECONCILED_NO_COST
  MISMATCH
  SEMANTICS_CONFLICT
  SOURCE_DISAGREEMENT
  INCOMPLETE
}
enum AutoSubSource { FPL SIMULATED }
enum ChipRuleSource { FPL_BOOTSTRAP CONFIG_FALLBACK }
enum SyncStatus { RUNNING SUCCESS PARTIAL FAILED }
enum SyncTrigger { MANUAL FINALIZE SCHEDULER SMOKE STARTUP }
enum ResultStatus { PROVISIONAL FINAL OVERRIDDEN }
enum ResultActionType { FINALIZE OVERRIDE RECOMPUTE }

// ─── Config ──────────────────────────────────────────────
model Group {
  id            String       @id @default(uuid()) @db.Uuid
  name          String
  slug          String       @unique
  memberSource  MemberSource @default(LEAGUE_STANDINGS) @map("member_source")
  fplLeagueId   Int?         @unique @map("fpl_league_id")
  myEntryId     Int?         @map("my_entry_id")
  winnerRule    WinnerRule   @default(NET_POINTS) @map("winner_rule")
  tieBreakRules String[]     @default(["FEWER_TRANSFER_COST", "HIGHER_SEASON_TOTAL", "SHARED"]) @map("tie_break_rules")
  shareToken    String?      @unique @map("share_token")
  isActive      Boolean      @default(true) @map("is_active")
  archivedAt    DateTime?    @map("archived_at") @db.Timestamptz
  createdAt     DateTime     @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime     @updatedAt @map("updated_at") @db.Timestamptz

  members   GroupMember[]
  results   GwResult[]
  snapshots ResultSnapshot[]
  actions   GwResultAction[]

  @@map("groups")
}

model Manager {
  entryId    Int      @id @map("entry_id")
  playerName String   @map("player_name")
  teamName   String   @map("team_name")
  syncRunId  BigInt?  @map("sync_run_id")
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz

  syncRun     SyncRun?          @relation(fields: [syncRunId], references: [id])
  memberships GroupMember[]
  gameweeks   ManagerGameweek[]
  picks       ManagerPick[]
  autoSubs    ManagerAutoSub[]
  transfers   ManagerTransfer[]
  chips       ManagerChip[]

  @@map("managers")
}

model GroupMember {
  groupId       String   @map("group_id") @db.Uuid
  entryId       Int      @map("entry_id")
  isExcluded    Boolean  @default(false) @map("is_excluded")
  joinedEvent   Int?     @map("joined_event") @db.SmallInt
  leftLeague    Boolean  @default(false) @map("left_league")
  addedManually Boolean  @default(false) @map("added_manually")
  addedAt       DateTime @default(now()) @map("added_at") @db.Timestamptz

  group   Group   @relation(fields: [groupId], references: [id], onDelete: Restrict)
  manager Manager @relation(fields: [entryId], references: [entryId], onDelete: Restrict)

  @@id([groupId, entryId])
  @@map("group_members")
}

// ─── FPL snapshots (season-scoped, all carry syncRunId) ───
model Event {
  season               String
  id                   Int        @db.SmallInt
  deadlineTime         DateTime   @map("deadline_time") @db.Timestamptz
  isCurrent            Boolean    @map("is_current")
  isNext               Boolean    @map("is_next")
  finished             Boolean
  dataChecked          Boolean    @map("data_checked")
  state                EventState
  dataCheckedObservedAt DateTime? @map("data_checked_observed_at") @db.Timestamptz
  syncRunId            BigInt     @map("sync_run_id")
  updatedAt            DateTime   @updatedAt @map("updated_at") @db.Timestamptz

  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, id])
  @@map("events")
}

model Team {
  season    String
  id        Int    @db.SmallInt
  name      String
  shortName String @map("short_name")
  syncRunId BigInt @map("sync_run_id")

  syncRun SyncRun  @relation(fields: [syncRunId], references: [id])
  players Player[]

  @@id([season, id])
  @@map("teams")
}

model Player {
  season     String
  id         Int
  webName    String   @map("web_name")
  teamId     Int      @map("team_id") @db.SmallInt
  position   Position
  price      Decimal  @db.Decimal(4, 1)
  status     String?
  selectedBy Decimal? @map("selected_by") @db.Decimal(5, 2)
  syncRunId  BigInt   @map("sync_run_id")
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz

  team    Team    @relation(fields: [season, teamId], references: [season, id])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, id])
  @@map("players")
}

model Fixture {
  season              String
  id                  Int
  event               Int?      @db.SmallInt
  teamH               Int       @map("team_h") @db.SmallInt
  teamA               Int       @map("team_a") @db.SmallInt
  teamHFdr            Int?      @map("team_h_fdr") @db.SmallInt
  teamAFdr            Int?      @map("team_a_fdr") @db.SmallInt
  kickoffTime         DateTime? @map("kickoff_time") @db.Timestamptz
  started             Boolean   @default(false)
  finished            Boolean   @default(false)
  finishedProvisional Boolean   @default(false) @map("finished_provisional")
  teamHScore          Int?      @map("team_h_score") @db.SmallInt
  teamAScore          Int?      @map("team_a_score") @db.SmallInt
  syncRunId           BigInt    @map("sync_run_id")

  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, id])
  @@index([season, event])
  @@map("fixtures")
}

model ChipRule {
  season     String
  chipName   String         @map("chip_name")
  startEvent Int            @map("start_event") @db.SmallInt
  stopEvent  Int            @map("stop_event") @db.SmallInt
  number     Int            @db.SmallInt
  chipType   String?        @map("chip_type")
  source     ChipRuleSource
  syncRunId  BigInt?        @map("sync_run_id")

  syncRun SyncRun? @relation(fields: [syncRunId], references: [id])

  @@id([season, chipName, startEvent])
  @@map("chip_rules")
}

model SeasonSemantics {
  season             String          @id
  pointsSemantics    PointsSemantics @default(UNVERIFIED) @map("points_semantics")
  evidenceRows       Int             @default(0) @map("evidence_rows")
  conflictRows       Int             @default(0) @map("conflict_rows")
  firstVerifiedRunId BigInt?         @map("first_verified_run_id")
  updatedAt          DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  firstVerifiedRun SyncRun? @relation(fields: [firstVerifiedRunId], references: [id])

  @@map("season_semantics")
}

model ManagerGameweek {
  season               String
  entryId              Int                  @map("entry_id")
  event                Int                  @db.SmallInt
  reportedGwPoints     Int                  @map("reported_gw_points") @db.SmallInt
  transferCost         Int                  @default(0) @map("transfer_cost") @db.SmallInt
  netGwPoints          Int?                 @map("net_gw_points") @db.SmallInt
  grossGwPoints        Int?                 @map("gross_gw_points") @db.SmallInt
  totalPoints          Int                  @map("total_points")
  previousTotalPoints  Int?                 @map("previous_total_points")
  picksReportedPoints  Int?                 @map("picks_reported_points") @db.SmallInt
  pointsSemantics      PointsSemantics      @map("points_semantics")
  reconciliationStatus ReconciliationStatus @map("reconciliation_status")
  reconciliationDetail Json                 @map("reconciliation_detail")
  eventTransfers       Int                  @default(0) @map("event_transfers") @db.SmallInt
  pointsOnBench        Int                  @default(0) @map("points_on_bench") @db.SmallInt
  overallRank          Int?                 @map("overall_rank")
  bank                 Decimal?             @db.Decimal(4, 1)
  teamValue            Decimal?             @map("team_value") @db.Decimal(5, 1)
  activeChip           String?              @map("active_chip")
  syncRunId            BigInt               @map("sync_run_id")
  fetchedAt            DateTime             @default(now()) @map("fetched_at") @db.Timestamptz

  manager Manager @relation(fields: [entryId], references: [entryId])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, entryId, event])
  @@index([season, event])
  @@map("manager_gameweeks")
}

model ManagerPick {
  season        String
  entryId       Int     @map("entry_id")
  event         Int     @db.SmallInt
  elementId     Int     @map("element_id")
  squadPosition Int     @map("squad_position") @db.SmallInt
  fplMultiplier Int     @map("fpl_multiplier") @db.SmallInt
  isCaptain     Boolean @map("is_captain")
  isViceCaptain Boolean @map("is_vice_captain")
  syncRunId     BigInt  @map("sync_run_id")

  manager Manager @relation(fields: [entryId], references: [entryId])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, entryId, event, elementId])
  @@index([season, event, elementId])
  @@map("manager_picks")
}

model ManagerAutoSub {
  season     String
  entryId    Int           @map("entry_id")
  event      Int           @db.SmallInt
  elementOut Int           @map("element_out")
  elementIn  Int           @map("element_in")
  source     AutoSubSource
  syncRunId  BigInt        @map("sync_run_id")

  manager Manager @relation(fields: [entryId], references: [entryId])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, entryId, event, elementOut])
  @@map("manager_auto_subs")
}

model ManagerTransfer {
  id             BigInt   @id @default(autoincrement())
  season         String
  entryId        Int      @map("entry_id")
  event          Int      @db.SmallInt
  elementIn      Int      @map("element_in")
  elementInCost  Decimal  @map("element_in_cost") @db.Decimal(4, 1)
  elementOut     Int      @map("element_out")
  elementOutCost Decimal  @map("element_out_cost") @db.Decimal(4, 1)
  madeAt         DateTime @map("made_at") @db.Timestamptz
  syncRunId      BigInt   @map("sync_run_id")

  manager Manager @relation(fields: [entryId], references: [entryId])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@unique([season, entryId, madeAt, elementIn, elementOut])
  @@index([season, entryId, event])
  @@map("manager_transfers")
}

model ManagerChip {
  season    String
  entryId   Int    @map("entry_id")
  chipName  String @map("chip_name")
  event     Int    @db.SmallInt
  syncRunId BigInt @map("sync_run_id")

  manager Manager @relation(fields: [entryId], references: [entryId])
  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, entryId, chipName, event])
  @@map("manager_chips")
}

model PlayerGameweekPoints {
  season          String
  event           Int      @db.SmallInt
  elementId       Int      @map("element_id")
  totalPoints     Int      @map("total_points") @db.SmallInt
  minutes         Int      @db.SmallInt
  fixturesSettled Boolean  @default(false) @map("fixtures_settled")
  syncRunId       BigInt   @map("sync_run_id")
  fetchedAt       DateTime @default(now()) @map("fetched_at") @db.Timestamptz

  syncRun SyncRun @relation(fields: [syncRunId], references: [id])

  @@id([season, event, elementId])
  @@map("player_gameweek_points")
}

// ─── Provenance ──────────────────────────────────────────
model SyncRun {
  id         BigInt      @id @default(autoincrement())
  job        String
  target     String?
  season     String?
  event      Int?        @db.SmallInt
  trigger    SyncTrigger
  status     SyncStatus
  requests   Int         @default(0)
  errorCode  String?     @map("error_code")
  errorMsg   String?     @map("error_msg")
  startedAt  DateTime    @default(now()) @map("started_at") @db.Timestamptz
  finishedAt DateTime?   @map("finished_at") @db.Timestamptz

  requestLog   SyncRunRequest[]
  rawResponses FplRawResponse[]
  managers     Manager[]
  events       Event[]
  teams        Team[]
  players      Player[]
  fixtures     Fixture[]
  chipRules    ChipRule[]
  semantics    SeasonSemantics[]
  gameweeks    ManagerGameweek[]
  picks        ManagerPick[]
  autoSubs     ManagerAutoSub[]
  transfers    ManagerTransfer[]
  chips        ManagerChip[]
  livePoints   PlayerGameweekPoints[]
  snapshotRefs ResultSnapshotSource[]
  actions      GwResultAction[]

  @@index([job, startedAt])
  @@map("sync_runs")
}

model SyncRunRequest {
  id            BigInt   @id @default(autoincrement())
  syncRunId     BigInt   @map("sync_run_id")
  path          String
  httpStatus    Int?     @map("http_status") @db.SmallInt
  bodySha256    String?  @map("body_sha256")
  bytes         Int?
  durationMs    Int      @map("duration_ms")
  schemaOk      Boolean? @map("schema_ok")
  fromCache     Boolean  @default(false) @map("from_cache")
  rawResponseId BigInt?  @unique @map("raw_response_id")
  fetchedAt     DateTime @default(now()) @map("fetched_at") @db.Timestamptz

  syncRun     SyncRun         @relation(fields: [syncRunId], references: [id])
  rawResponse FplRawResponse? @relation(fields: [rawResponseId], references: [id])

  @@index([syncRunId])
  @@map("sync_run_requests")
}

model FplRawResponse {
  id          BigInt    @id @default(autoincrement())
  syncRunId   BigInt?   @map("sync_run_id")
  path        String
  httpStatus  Int?      @map("http_status") @db.SmallInt
  body        Json?
  bodyText    String?   @map("body_text")
  reason      String    // SCHEMA_FAIL | FINAL_EVIDENCE | SMOKE | CHIP_RULES_INVALID
  retainUntil DateTime? @map("retain_until") @db.Timestamptz
  capturedAt  DateTime  @default(now()) @map("captured_at") @db.Timestamptz

  syncRun SyncRun?        @relation(fields: [syncRunId], references: [id])
  request SyncRunRequest?

  @@index([retainUntil])
  @@map("fpl_raw_responses")
}

// ─── Results & audit ─────────────────────────────────────
model ResultSnapshot {
  id              BigInt     @id @default(autoincrement())
  groupId         String     @map("group_id") @db.Uuid
  season          String
  event           Int        @db.SmallInt
  winnerRule      WinnerRule @map("winner_rule")
  tieBreakRules   String[]   @map("tie_break_rules")
  winnerEntryIds  Int[]      @map("winner_entry_ids")
  winningScore    Int?       @map("winning_score") @db.SmallInt
  tieBreakApplied String?    @map("tie_break_applied")
  tieBreakTrace   Json       @map("tie_break_trace")
  standings       Json
  inputs          Json
  inputsHash      String     @map("inputs_hash")
  eventState      EventState @map("event_state")
  engineVersion   String     @map("engine_version")
  warnings        Json       @default("[]")
  computedAt      DateTime   @default(now()) @map("computed_at") @db.Timestamptz

  group         Group                  @relation(fields: [groupId], references: [id], onDelete: Restrict)
  sources       ResultSnapshotSource[]
  currentFor    GwResult[]
  actionsAsPrev GwResultAction[]       @relation("prevSnapshot")
  actionsAsNew  GwResultAction[]       @relation("newSnapshot")

  @@index([groupId, season, event])
  @@map("result_snapshots")
}

model ResultSnapshotSource {
  snapshotId BigInt @map("snapshot_id")
  syncRunId  BigInt @map("sync_run_id")

  snapshot ResultSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Restrict)
  syncRun  SyncRun        @relation(fields: [syncRunId], references: [id], onDelete: Restrict)

  @@id([snapshotId, syncRunId])
  @@map("result_snapshot_sources")
}

model GwResult {
  groupId           String       @map("group_id") @db.Uuid
  season            String
  event             Int          @db.SmallInt
  status            ResultStatus
  currentSnapshotId BigInt       @map("current_snapshot_id")
  updatedAt         DateTime     @updatedAt @map("updated_at") @db.Timestamptz

  group           Group          @relation(fields: [groupId], references: [id], onDelete: Restrict)
  currentSnapshot ResultSnapshot @relation(fields: [currentSnapshotId], references: [id], onDelete: Restrict)

  @@id([groupId, season, event])
  @@map("gw_results")
}

model GwResultAction {
  id                BigInt           @id @default(autoincrement())
  groupId           String           @map("group_id") @db.Uuid
  season            String
  event             Int              @db.SmallInt
  action            ResultActionType
  prevStatus        ResultStatus     @map("prev_status")
  newStatus         ResultStatus     @map("new_status")
  prevWinnerEntryIds Int[]           @map("prev_winner_entry_ids")
  newWinnerEntryIds Int[]            @map("new_winner_entry_ids")
  prevSnapshotId    BigInt?          @map("prev_snapshot_id")
  newSnapshotId     BigInt           @map("new_snapshot_id")
  note              String?
  syncRunId         BigInt?          @map("sync_run_id")
  actor             String           @default("admin")
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz

  group        Group           @relation(fields: [groupId], references: [id], onDelete: Restrict)
  prevSnapshot ResultSnapshot? @relation("prevSnapshot", fields: [prevSnapshotId], references: [id], onDelete: Restrict)
  newSnapshot  ResultSnapshot  @relation("newSnapshot", fields: [newSnapshotId], references: [id], onDelete: Restrict)
  syncRun      SyncRun?        @relation(fields: [syncRunId], references: [id], onDelete: Restrict)

  @@index([groupId, season, event, createdAt])
  @@map("gw_result_actions")
}
Hand-written migration (prisma/migrations/<ts>_audit_guards/migration.sql)
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gw_result_actions_append_only
  BEFORE UPDATE OR DELETE ON gw_result_actions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER result_snapshots_immutable
  BEFORE UPDATE OR DELETE ON result_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER result_snapshot_sources_immutable
  BEFORE UPDATE OR DELETE ON result_snapshot_sources
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TABLE group_members ADD CONSTRAINT group_members_joined_event_chk
  CHECK (joined_event IS NULL OR joined_event BETWEEN 1 AND 38);

ALTER TABLE groups ADD CONSTRAINT groups_league_required_chk
  CHECK (member_source = 'MANUAL' OR fpl_league_id IS NOT NULL);

ALTER TABLE manager_gameweeks ADD CONSTRAINT mgw_net_requires_reconciled_chk
  CHECK ((net_gw_points IS NULL) = (reconciliation_status NOT IN ('RECONCILED','RECONCILED_NO_COST')));
Notes
• net_gw_points is no longer a generated column. It's written by the reconciler, and the check constraint guarantees it's null unless the row is reconciled.
• ManagerPick.multiplier was renamed to fpl_multiplier to signal that it's a cross-check value, not the engine's source.
• Pruning fpl_raw_responses deletes only rows with retain_until < now(). Finalize sets retain_until = null on its evidence rows.
14. Revised analytics contracts
Every analytics module exports pure functions: no I/O, no clock reads (now is passed in), and deterministic output. Contracts are written as TS-style signatures, and are implemented in JS with JSDoc @typedefs. ENGINE_VERSION (semver, in analytics/version.js) is bumped on any behaviour change and stamped into every snapshot.
analytics/reconcile.js
reconcileSeason(input: {
  season: string;
  historyRows: { event: number; points: number; eventTransfersCost: number; totalPoints: number }[]; // one entry, all GWs
  picksPoints: Map<number, number | null>;     // event → picks.entry_history.points
  seasonSemantics: PointsSemantics;
  eventStates: Map<number, EventState>;
}): { rows: NormalizedGwPoints[]; evidence: { gross: number; net: number } }
Invariants:
• The output has one row per input event.
• netGwPoints !== null ⇔ the status ∈ {RECONCILED, RECONCILED_NO_COST}.
• It never throws on bad data; it returns statuses instead.
analytics/eventState.js
deriveEventState(event: EventSnapshot, fixtures: FixtureSnapshot[], now: Date): EventState
canFinalize(ctx: {
  groupActive: boolean; eventState: EventState; resultStatus: ResultStatus | null;
  dataCheckedObservedAt: Date | null;
  eligibleRows: { entryId: number; reconciliationStatus: ReconciliationStatus; syncRunStartedAt: Date; syncRunStatus: SyncStatus }[];
}): { allowed: boolean; reasons: FinalizeBlockReason[] }
// FinalizeBlockReason: GROUP_ARCHIVED | NOT_DATA_CHECKED | ALREADY_FINAL | STALE_SYNC | RECONCILIATION_FAILED | NO_ELIGIBLE_MANAGERS
analytics/eligibility.js
selectEligible(members: GroupMemberSnapshot[], gwRows: Map<number, NormalizedGwPoints>, event: number):
  { eligible: number[]; ineligible: { entryId: number; reason: 'EXCLUDED'|'JOINED_LATER'|'NO_TEAM' }[] }
Only one reason is reported per manager, with precedence EXCLUDED > JOINED_LATER > NO_TEAM.
NO_TEAM means FPL returned the entry's history successfully and it has no row for this GW. That's a genuine absence, so the manager is ineligible and doesn't block the result.
Two situations block the result instead of making a manager ineligible:
• A manager whose data failed to sync (NOT_SYNCED).
• A manager whose row isn't reconciled.
In both cases the manager stays eligible and the result becomes BLOCKED, because dropping them could hand someone else the win.
analytics/ranking.js
competitionRanks(scores: { entryId: number; score: number }[]): Map<number, number>
resolvePositions(rows: TieBreakRow[], rules: TieBreakRule[]):
  { entryId: number; resolvedPosition: number; positionDecidedBy: TieBreakRule | 'ENTRY_ID_FALLBACK' | null }[]
analytics/tieBreakers.js
// each rule: (candidates: TieBreakRow[]) => TieBreakRow[]   (non-empty subset; returns input if the rule can't separate)
TIE_BREAKERS: Record<Exclude<TieBreakRule,'SHARED'>, (c: TieBreakRow[]) => TieBreakRow[]>
type TieBreakRow = { entryId: number; score: number; grossGwPoints: number; transferCost: number;
  captainPoints: number | null; pointsOnBench: number; activeChip: string | null;
  totalPoints: number; overallRank: number | null };
A rule whose data is null for any candidate returns the input unchanged and records TIE_BREAK_DATA_MISSING in the trace.
analytics/winner.js
computeGwResult(input: {
  group: { winnerRule: WinnerRule; tieBreakRules: TieBreakRule[]; myEntryId: number | null };
  event: number; eventState: EventState;
  members: GroupMemberSnapshot[];
  gwRows: NormalizedGwPoints[];
  effectiveSquads: Map<number, EffectiveSquad>;   // for captain points
  managers: Map<number, ManagerRef>;
}): {
  status: 'PROVISIONAL' | 'BLOCKED';
  blockedBy: { entryId: number; reconciliationStatus: ReconciliationStatus }[];
  winners: number[]; winningScore: number | null;
  tieBreakApplied: TieBreakRule | null;
  tieBreakTrace: { rule: TieBreakRule; remaining: number[]; note?: string }[];
  rows: ResultRow[];        // competitionRank, resolvedPosition, tiedWith, positionDecidedBy, ineligibleReason
  inputs: object; inputsHash: string; engineVersion: string; warnings: Warning[];
}
It's BLOCKED when any member who would otherwise be eligible has a non-reconciled status. In that case winners = [], but the rows are still returned with reported points.
analytics/effectiveSquad.js
deriveEffectiveSquad(input: {
  picks: { elementId: number; squadPosition: number; isCaptain: boolean; isViceCaptain: boolean; fplMultiplier: number }[];
  activeChip: string | null;
  autoSubs: { elementIn: number; elementOut: number; source: AutoSubSource }[];
  live: Map<number, { minutes: number; totalPoints: number; fixturesSettled: boolean }>;
}): EffectiveSquad

type EffectiveSquad = {
  picks: { elementId: number; pickedMultiplier: number; effectiveMultiplier: number; autoSubbed: 'IN'|'OUT'|null }[];
  pickedCaptain: number; pickedVice: number; capMult: 2 | 3;
  effectiveCaptain: { elementId: number | null; via: 'CAPTAIN'|'VICE'|'NONE'|'PENDING' };
  benchBoost: boolean; autoSubSource: AutoSubSource | 'NONE';
  reconstructedPoints: number;               // Σ effectiveMultiplier × totalPoints
  warnings: ('UNKNOWN_CHIP'|'FPL_MULTIPLIER_DIFFERS'|'EFFECTIVE_POINTS_MISMATCH')[];
}
analytics/ownership.js
computeOwnership(input: {
  squads: Map<number, EffectiveSquad>;      // eligible managers with picks only
  eligible: number[]; myEntryId: number | null;
  players: Map<number, PlayerRef>;
}): {
  denominators: { rivals: number; all: number };
  missingEntryIds: number[];                 // eligible but no picks
  rows: {
    player: PlayerRef;
    pickedSquad: ScopeShare; pickedXi: ScopeShare; pickedCaptain: ScopeShare; pickedTriple: ScopeShare;
    effectiveCaptain: ScopeShare;
    pickedEo: { rivals: number; all: number }; effectiveEo: { rivals: number; all: number };
    myPickedMultiplier: number | null; myEffectiveMultiplier: number | null;
    pickedExposure: number | null; effectiveExposure: number | null;
    owners: number[];
  }[];
}
type ScopeShare = { rivals: { count: number; of: number; pct: number }; all: { count: number; of: number; pct: number } };
When the denominator is 0, pct is null (not NaN), and the UI shows "—".
analytics/chips.js
chipAvailability(rules: ChipRuleSnapshot[], played: { entryId: number; chipName: string; event: number }[],
  currentEvent: number, entryIds: number[]):
  { source: ChipRuleSource; managers: { entryId: number; chips: { chipName: string; window: [number, number];
    used: number; allowed: number; available: boolean; current: boolean; playedEvents: number[] }[];
    unmapped: { chipName: string; event: number }[] }[] }
analytics/differentials.js, transfers.js, trends.js: signatures unchanged from v0.1 §10, except they consume NormalizedGwPoints and EffectiveSquad, and treat netGwPoints = null as a gap (not 0) in trend series.
API response deltas
• ResultRow gains competitionRank, resolvedPosition, tiedWith, positionDecidedBy, ineligibleReason, reportedGwPoints, grossGwPoints, netGwPoints, reconciliationStatus. rank is removed.
• GwResults.status gains BLOCKED, and adds blockedBy, eventState, finalizeGate: { allowed, reasons }, currentSnapshotId.
• OwnershipRow is replaced by the computeOwnership row shape above, plus denominators and missingEntryIds at the top level.
15. Revised synchronization flow
Every sync is a sync_run. It fetches through the FPL client, which logs each call to sync_run_requests. Before writing, it normalizes and reconciles, and it writes each manager's rows in one transaction stamped with the run ID. Finalize is its own flow: fresh sync → gate → frozen snapshot → audit row, all in one DB transaction after the sync.
Group GW sync (syncGroupGameweek)
sequenceDiagram
  participant C as Controller
  participant S as SyncService
  participant F as FplClient
  participant D as Postgres
  C->>S: syncGroupGameweek(group, gw, trigger)
  S->>D: advisory lock + insert sync_run RUNNING
  S->>F: bootstrap (cached) + fixtures
  S->>D: upsert events(state), chip_rules
  S->>F: members (standings or manual list)
  loop each member
    S->>F: history, picks(gw), transfers
    S->>S: reconcile + normalize
    S->>D: tx: upsert gw rows, picks, auto_subs, chips, transfers
  end
  S->>F: event/{gw}/live
  S->>D: upsert player_gameweek_points
  S->>D: update season_semantics, finish run
  S-->>C: SyncResponse
Steps in detail
1. Open the run. Take pg_try_advisory_lock(hash(groupId)), and return 409 SYNC_IN_PROGRESS if it's taken. Insert sync_runs with status = RUNNING and the trigger.
2. Bootstrap. Fetch bootstrap-static (cache allowed, but the request is logged with from_cache). Validate it, upsert teams, players and events, and derive events.state. Set data_checked_observed_at on the first true, and clear it if the flag reverts. Validate and replace chip_rules (§8).
3. Members. For LEAGUE_STANDINGS, page through standings, upsert managers and group_members, and mark missing members left_league. On AUTH_REQUIRED, keep the last known members and flag the run PARTIAL. For MANUAL, use the stored list.
4. Per member, with concurrency limited by the client (not the loop):
    ◦ Fetch history, then picks for the GW (404 before the deadline → no picks), then transfers.
    ◦ Reconcile the whole season history (reconcileSeason).
    ◦ In one transaction: upsert all manager_gameweeks rows (every GW, since reconciliation needs the full series); replace the picks and auto-subs for this GW; upsert chips and transfers. Every row gets sync_run_id = run.id.
    ◦ A failure is recorded in failures[]. That member's previous rows are kept, but they don't get this run's ID, so the finalize gate will see them as stale.
5. Live. Fetch event/{gw}/live once the deadline has passed. Upsert player_gameweek_points, with fixtures_settled derived from the fixtures.
6. Semantics. Update season_semantics from the evidence counts gathered in step 4.
7. Close the run. SUCCESS if there were no failures, PARTIAL if some members failed, FAILED if bootstrap or members failed. Release the lock.
Finalize flow (POST /groups/:id/gw/:gw/finalize)
1. Run syncGroupGameweek with trigger = FINALIZE. Raw bodies are stored for history, picks and live, with reason = FINAL_EVIDENCE.
2. Load the snapshot rows and run canFinalize. If it's blocked, return 409 with reasons[], and change nothing else.
3. computeGwResult → status must be PROVISIONAL (not BLOCKED).
4. In one DB transaction:
    ◦ Insert result_snapshots and result_snapshot_sources (the distinct sync_run_ids of all input rows).
    ◦ Upsert gw_results(status = FINAL, current_snapshot_id).
    ◦ Insert gw_result_actions(FINALIZE, prev = PROVISIONAL).
    ◦ Set retain_until = null on the evidence raw responses.
5. Return the final GwResults.
Override and recompute:
• Override skips step 3's PROVISIONAL requirement. It computes the rule-based snapshot anyway, for the record, then stores the admin's winners.
• Recompute with dryRun = true stops after step 3 and returns a diff against the current snapshot.
• Both append an action row. Neither updates or deletes any earlier snapshot or action.
Freshness rules
• Finished GW rows written by a run that started after data_checked_observed_at are considered settled. Later syncs still refetch history, because totals feed reconciliation, but they log SETTLED_ROW_CHANGED when a settled value differs.
• A settled change never alters a finalized result. It only surfaces as a warning on the Results page, and the recompute preview shows its impact.
16. Revised test plan
Tests use Node's built-in node:test and node:assert/strict. No framework is needed, because the engine is pure functions over plain objects. There are three suites:
• Unit tests (pure analytics, no DB, under 2 s).
• Contract tests (recorded FPL samples against the zod schemas).
• Integration tests (finalize, audit and triggers against a throwaway Postgres; skipped when DATABASE_URL_TEST is unset).
Layout and scripts
server/test/
  helpers/builders.js        # makeGwRow(), makePicks(), makeLive(), makeGroup() with sensible defaults
  unit/*.test.js
  contract/*.test.js         # reads server/fpl-contract/2026-27/*.sample.json
  integration/*.test.js

npm test                      → node --test "test/unit/**/*.test.js" "test/contract/**/*.test.js"
npm run test:integration      → node --test "test/integration/**/*.test.js"
npm run test:coverage         → node --test --experimental-test-coverage "test/unit/**/*.test.js"
Unit cases
File
Case
Input → expected
reconcile.test.js
No hit
Tprev 50, R 60, C 0, T 110 → RECONCILED_NO_COST, net 60, gross 60

Gross semantics
Tprev 100, R 70, C 4, T 166 → RECONCILED, evidence GROSS, net 66, gross 70

Net semantics
Tprev 100, R 66, C 4, T 166 → RECONCILED, evidence NET, net 66, gross 70

Mismatch
Tprev 100, R 70, C 4, T 170 → MISMATCH, net null, gross null

Semantics conflict
season GROSS verified; row matches NET only → SEMANTICS_CONFLICT, net null

First row
first event of entry, no earlier row → Tprev 0 → reconciled

Gap
rows for GW 3 and 5, not 4 → GW 5 INCOMPLETE

Source disagreement
history R 70, picks 68 at DATA_CHECKED → SOURCE_DISAGREEMENT

Keyed by event
rows passed out of order → same output as sorted
winner.test.js
Net rule
A: R 70 C 8 (net 62), B: R 65 C 0 (net 65) → winner B

Gross rule
same data → winner A

Blocked
one eligible manager MISMATCH → status BLOCKED, winners [] , blockedBy lists them

Not synced
eligible member without a row this run → BLOCKED
tieBreakers.test.js
Fewer transfer cost
2 × net 70, costs 4 vs 0 → cost-0 wins, tieBreakApplied FEWER_TRANSFER_COST

Chain falls through
equal cost, season totals 400 vs 410 → 410 wins via HIGHER_SEASON_TOTAL

Each rule
one case per rule key, incl. NO_CHIP_PLAYED with nobody qualifying → no-op

Missing data
HIGHER_CAPTAIN_POINTS with null captain points → input unchanged, trace note TIE_BREAK_DATA_MISSING

Order matters
same data, chain reversed → different winner
sharedWins.test.js
Full tie
3 equal on all rules → winners [3 ids], positions 1–3 by entryId, positionDecidedBy ENTRY_ID_FALLBACK

Rules empty
tieBreakRules = ['SHARED'] with 2 tied → shared

entryId never decides
shared winners unaffected by entryId order
eligibility.test.js
Excluded
excluded top scorer → not winner, not in denominators, ineligibleReason EXCLUDED

Joined later
joinedEvent 6, GW 5 → ineligible JOINED_LATER; GW 6 → eligible

No team
history OK but no GW row → NO_TEAM, result not blocked

Precedence
excluded + joined later → EXCLUDED only
ranking.test.js
Competition rank
scores 78,78,71,71,60 → 1,1,3,3,5

Resolved position
same → 1–5 unique, deterministic across 100 shuffled runs

Ineligible rows
rank and position null, sorted last
effectiveSquad.test.js
Plain XI
no chip, captain plays → XI 1, captain 2, bench 0

Triple captain
3xc, captain plays → captain 3

TC captain fails
3xc, captain 0 min settled, VC plays → VC 3, captain 0, via VICE

Captain fails
captain 0 min settled, VC plays → VC 2, via VICE

Both fail
both 0 min settled → no ×2, via NONE

Pending
captain's fixture not settled → via PENDING, picked multiplier kept

Bench boost
bboost → all 15 effective 1, captain 2; auto-subs ignored

Auto-sub
auto_subs [{in: 12th, out: 7th}] → out 0, in 1

Auto-sub captain
captain auto-subbed out → captain 0, VC promoted

Unknown chip
active_chip 'mystery' → no chip effect, warning UNKNOWN_CHIP

Reconstruction
Σ mult × pts = gross → no warning; off by 2 → EFFECTIVE_POINTS_MISMATCH
ownership.test.js
Denominators (Group B)
9 members, Me eligible → rivals 8, all 9

Missing picks
1 rival without picks → rivals 7, missingEntryIds [id]

Excluded
excluded member not counted in any denominator

Zero denominator
only Me eligible → rivals pct null

Squad vs XI
player on 3 benches + 2 XIs → squad 5/8, XI 2/8

Picked captaincy
5 of 8 captain X, 1 with TC → pickedCaptain 5/8, pickedTriple 1/8

Effective captaincy
X blanks, 3 of those 5 have VC Y → effectiveCaptain Y 3/8

EO
multipliers [2,2,1,1,0,0,3,1] over 8 → pickedEo 1.25

Bench-boost EO
benched player under bboost counts 1 in effectiveEo, 0 in pickedXi

Exposure
my mult 2, rivals EO 1.25 → exposure +0.75
chips.test.js
Bootstrap windows
rules [bboost 1–19 n1, bboost 20–38 n1], played GW 7 → first window used, second available

Unmapped chip
played 'newchip' → unmapped, no window affected

Fallback source
rules source CONFIG_FALLBACK → output source flagged

Invalid bootstrap
overlapping windows → validator rejects the set
eventState.test.js
Derivation
one case per state incl. postponed fixture moved to another GW

Revert
data_checked true → false → FPL_PROCESSING
finalizeGate.test.js
Allowed
DATA_CHECKED, fresh SUCCESS runs, all reconciled → allowed

Each reason
archived, MATCHES_FINISHED, FPL_PROCESSING, already FINAL, run started before observedAt, PARTIAL run for a member, MISMATCH row, zero eligible → matching reason

Multiple reasons
all reasons returned, not just the first
Contract tests (contract/fplSchemas.test.js): every committed *.sample.json parses with its zod schema. The shape snapshot (*.shape.json) matches deriveShape(sample). Mappers produce internal models without undefined fields.
Integration tests
File
Case
finalize.test.js
Finalize writes exactly 1 snapshot, N sources, 1 action; gw_results points to it
override.test.js
Override after finalize → 2 snapshots, 2 actions, first action still present with its winners
recompute.test.js
dryRun writes nothing; commit with changed winners and no note → 400
appendOnly.test.js
Raw UPDATE/DELETE on gw_result_actions, result_snapshots → DB error
archive.test.js
Archived group: sync/finalize → 409 GROUP_ARCHIVED; results still readable
traceability.test.js
Every input row's sync_run_id appears in result_snapshot_sources; verify endpoint hash matches
Fixture data: builders generate synthetic squads. Contract samples come from the anonymized smoke output. No real names are committed.
17. Updated implementation order
The order moves API verification and the pure engine ahead of any UI. The smoke test must confirm the points semantics, private league access and multiplier behaviour before the reconciler and effective-squad code are finalized. The weekly declaration is still usable at M3.
Step
Work
Gate to move on
0
Repo scaffold, Node 22, env validation, npm test wired with one trivial test
npm test green
1
fplClient (cache, limiter, retries, breaker, request logging hook) + zod schemas from v0.1 §7 as a starting point
Unit tests for retry/breaker logic
2
Smoke test against both real leagues + a hit-taking entry; commit anonymized samples + shapes; update schemas from the recorded reality
Exit 0, or documented decisions on each failed assumption (league access → manual mode, semantics proven)
3
Prisma schema (§13) + audit-guard SQL migration
Migrations apply on a clean DB; appendOnly.test.js passes
4
Pure engine, test-first, in this order: reconcile → eventState → eligibility → ranking → tieBreakers → winner → effectiveSquad → ownership → chips
All §16 unit cases green
5
Sync service: runs, advisory lock, request log, per-member transactions, live, semantics update
Group B syncs with all rows stamped; PARTIAL on a forced member failure
6
Auth, group CRUD, archive/unarchive, league preview with access classification, manual members
archive.test.js passes
7
Results service: provisional/blocked read, finalize flow, override, recompute (dry run), snapshots, actions, verify endpoint
All integration tests green
8
Client: shell, groups, group form (league or manual), Results page with finalize gate reasons, History drawer, announcement copy
M3: a real finished GW finalized from a phone; trace path opens from the result
9
Ownership (picked/effective toggle, denominators, missing), captaincy (picked vs effective), differentials
Numbers match a hand count for one GW in Group B
10
Chips page (source badge), Status page (runs, requests, semantics, smoke verdicts)
MVP complete
11
V1 as in v0.1, with live auto-sub simulation now implementing AutoSubSource = SIMULATED behind the same deriveEffectiveSquad contract
Per feature
Milestone mapping: M1 = steps 0–3, M2 = 4–5, M3 = 6–8, M4 = 9–10. The engine-first order adds about 2 days over v0.1, but it removes rework if the smoke test disproves an assumption.
Explicit non-goals for v0.2: no FPL authentication, no automatic finalization, and no deletion paths for groups, results or audit rows.
