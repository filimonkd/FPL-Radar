# FPL smoke report

- Started: 2026-09-24T13:13:02.659Z
- Finished: 2026-09-24T13:13:21.364Z
- Season: 2026-27
- Gameweek: 5 (latest data_checked event)
- Leagues: L1, L2; entries: E1
- **Exit code 2 — ASSUMPTION FAILED / UNVERIFIED**: 0 FAIL, 5 UNVERIFIED (every assumption must be decided before M2)
- Checks: 29 PASS, 0 FAIL, 5 UNVERIFIED, 1 DEFERRED_TO_STEP_3 (recorded, not counted toward the exit code)
- Samples/shapes baseline: written by this run

## Requests

| Endpoint | Path | Result | HTTP | Content-Type | Cache-Control | Bytes | ms | Cloudflare | Schema |
|---|---|---|---|---|---|---|---|---|---|
| bootstrap-static | `/bootstrap-static/` | OK | 200 | application/json | max-age=300, stale-while-revalidate=3600, stale-if-error=3600 | 1778695 | 963 | — | ok |
| fixtures | `/fixtures/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 231760 | 943 | — | ok |
| fixtures | `/fixtures/?event=5` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 25468 | 1286 | — | ok |
| event-status | `/event-status/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 224 | 183 | — | ok |
| leagues-classic-standings | `/leagues-classic/{L1}/standings/?page_standings=1` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 2144 | 269 | — | ok |
| leagues-classic-standings | `/leagues-classic/{L2}/standings/?page_standings=1` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 1800 | 696 | — | ok |
| entry | `/entry/{E1}/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 15389 | 227 | — | ok |
| entry-history | `/entry/{E1}/history/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 1981 | 201 | — | ok |
| entry-picks | `/entry/{E1}/event/5/picks/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 1867 | 182 | — | ok |
| entry-transfers | `/entry/{E1}/transfers/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 571 | 170 | — | ok |
| entry-picks | `/entry/{E1}/event/6/picks/ (before deadline)` | HTTP | 404 | application/json | max-age=0, no-cache, no-store, must-revalidate, private | 23 | 193 | — | — |
| event-live | `/event/5/live/` | OK | 200 | application/json | max-age=0, no-cache, no-store, must-revalidate | 474264 | 1002 | — | ok |
| entry | `/entry/{nonexistent}/` | HTTP | 404 | application/json | — | 46 | 216 | — | — |

"Game is being updated" body seen: no.

## Assumption checks

| ID | Endpoint | Check | Verdict | Detail |
|---|---|---|---|---|
| B1 | bootstrap-static | 38 events with id, deadline_time, finished, data_checked, is_current, is_next | **PASS** | events=38; missing keys on events: none |
| B2 | bootstrap-static | Exactly one is_current (or none pre-season) | **PASS** | is_current count=1 |
| B3 | bootstrap-static | 20 teams | **PASS** | teams=20 |
| B4 | bootstrap-static | elements[] required fields; element_type in 1..4 | **PASS** | elements=667; bad element_type=0; missing required keys=0 |
| B5 | bootstrap-static | chips[] present with valid windows (v0.2 §8) | **PASS** | wildcard 2–19 ×1, wildcard 20–38 ×1, freehit 2–19 ×1, bboost 1–19 ×1, 3xc 1–19 ×1, freehit 20–38 ×1, bboost 20–38 ×1, 3xc 20–38 ×1 |
| B6 | bootstrap-static | Derived season string | **PASS** | 2026-27 |
| B7 | bootstrap-static | Selected GW event flags (finished / data_checked) | **PASS** | GW5: finished=true, data_checked=true, is_current=true |
| F1 | fixtures | Fields event, team_h, team_a, team_h_difficulty, team_a_difficulty, kickoff_time, started, finished, finished_provisional | **PASS** | fixtures=380; missing on some rows: none |
| F2 | fixtures | event is nullable (unscheduled fixtures) | **UNVERIFIED** | no event=null fixture observed (none unscheduled right now) |
| F3 | fixtures | ?event=gw returns only that GW | **PASS** | GW5: 10 fixtures, 0 from other GWs |
| S1 | event-status | status[] with event, bonus_added, points | **PASS** | rows=3; missing: none; points values seen: "r" |
| S2 | event-status | leagues value recorded verbatim | **PASS** | leagues="Updated" |
| L1 | leagues-classic-standings | L1: anonymous access classification | **PASS** | OK |
| L2 | leagues-classic-standings | L1: league.id/name, results[].entry/entry_name/player_name, has_next | **PASS** | missing: none; has_next=false |
| L3 | leagues-classic-standings | L1: pagination | **UNVERIFIED** | single page (10 members, has_next=false); multi-page behaviour not exercised by this league |
| L1 | leagues-classic-standings | L2: anonymous access classification | **PASS** | OK |
| L2 | leagues-classic-standings | L2: league.id/name, results[].entry/entry_name/player_name, has_next | **PASS** | missing: none; has_next=false |
| L3 | leagues-classic-standings | L2: pagination | **UNVERIFIED** | single page (9 members, has_next=false); multi-page behaviour not exercised by this league |
| E1 | entry | E1: player_first_name, player_last_name, name | **PASS** | missing: none |
| H1 | entry-history | E1: current[] points, total_points, event_transfers_cost | **PASS** | rows=5; missing: none |
| H2 | entry-history | E1: chips[] names seen | **PASS** | no chips played yet |
| P1 | entry-picks | E1: 15 picks, positions 1–15 unique, one captain + one vice | **PASS** | picks=15, unique positions 1–15=true, captains=1, vices=1 |
| P2 | entry-picks | E1: active_chip value | **PASS** | active_chip=null |
| P3 | entry-picks | E1: automatic_subs[] shape | **PASS** | 0 auto-subs; keys: (none observed) |
| P4 | entry-picks | E1: entry_history.points equals history points (GW5) | **PASS** | picks=64, history=64 |
| T1 | entry-transfers | E1: element_in, element_out, element_in_cost, element_out_cost, event, time | **PASS** | transfers=4; missing: none |
| T2 | entry-transfers | E1: costs are integer tenths | **PASS** | range 41–80 |
| T3 | entry-transfers | E1: whether wildcard/free-hit GWs appear | **UNVERIFIED** | entry has not played wildcard/freehit |
| H3 | entry-history | Points reconciliation semantics (v0.2 §2) | **UNVERIFIED** | season semantics=UNVERIFIED; E1: UNVERIFIED (gross=0, net=0, mismatch=0, incomplete=0) — no row with event_transfers_cost > 0: pass an --entry that took a hit |
| P6 | entry-picks | Next GW picks before deadline (GW6) | **PASS** | status=404; body=keys: detail |
| V1 | event-live | elements[].id, stats.total_points, stats.minutes | **PASS** | elements=667 |
| V2 | event-live | explain[] shape per fixture | **PASS** | explain item keys: fixture, stats |
| P5 | entry-picks | E1: Σ FPL multiplier × live total_points = picks points | **PASS** | Σ=64, entry_history.points=64; active_chip=null, auto-subs=0; captain multiplier=2, bench multipliers=0/0/0/0 |
| V3 | event-live | Σ engine effective multiplier × total_points = gross | **DEFERRED_TO_STEP_3** | needs deriveEffectiveSquad (Step 3); does not affect the exit code. P5 records the same identity using FPL multipliers |
| E2 | entry | 404 for a nonexistent entry ID | **PASS** | status=404 |

Deferred to Step 3 (engine code; excluded from the exit code): V3 — Σ engine effective multiplier × total_points = gross.

## Schema comparison (current zod schemas vs reality)

Every validated response matched the current schemas.

## Shapes

### bootstrap-static (1 response)

- Nullable paths: `chips[].overrides.pick_multiplier` (null (nullable)), `element_types[].squad_max_select` (null (nullable)), `element_types[].squad_min_select` (null (nullable)), `elements[].chance_of_playing_next_round` (number (nullable)), `elements[].chance_of_playing_this_round` (number (nullable)), `elements[].corners_and_indirect_freekicks_order` (number (nullable)), `elements[].direct_freekicks_order` (number (nullable)), `elements[].news_added` (string (nullable)), `elements[].penalties_order` (number (nullable)), `elements[].price_change_locked_until` (null (nullable)), `elements[].squad_number` (null (nullable)), `events[].highest_score` (number (nullable)), `events[].highest_scoring_entry` (number (nullable)), `events[].most_captained` (number (nullable)), `events[].most_selected` (number (nullable)), `events[].most_transferred_in` (number (nullable)), `events[].most_vice_captained` (number (nullable)), `events[].overrides.pick_multiplier` (null (nullable)), `events[].release_time` (null (nullable)), `events[].top_element` (number (nullable)), `events[].top_element_info` (object (nullable)), `game_config.rules.cup_qualifying_method` (null (nullable)), `game_config.rules.cup_start_event_id` (null (nullable)), `game_config.rules.cup_stop_event_id` (null (nullable)), `game_config.rules.cup_type` (null (nullable)), `game_config.rules.squad_special_max` (null (nullable)), `game_config.rules.squad_special_min` (null (nullable)), `game_settings.cup_qualifying_method` (null (nullable)), `game_settings.cup_start_event_id` (null (nullable)), `game_settings.cup_stop_event_id` (null (nullable)), `game_settings.cup_type` (null (nullable)), `game_settings.squad_special_max` (null (nullable)), `game_settings.squad_special_min` (null (nullable)), `phases[].highest_score` (number (nullable)), `teams[].form` (null (nullable)), `teams[].strength` (null (nullable)), `teams[].team_division` (null (nullable))
- Optional (missing on some objects): none
- Array lengths: `chips` 8–8, `chips[].overrides.element_types` 0–0, `element_stats` 26–26, `element_types` 4–4, `element_types[].sub_positions_locked` 0–1, `elements` 20–20, `elements[].price_change_projections` 3–3, `elements[].scout_risks` 0–0, `events` 38–38, `events[].chip_plays` 0–4, `events[].overrides.element_types` 0–0, `game_config.rules.featured_entries` 0–0, `game_config.rules.league_h2h_tiebreak_stats` 2–2, `game_config.rules.percentile_ranks` 20–20, `game_config.rules.ui_special_shirt_exclusions` 0–0, `game_config.settings.price_change_deadlines` 3–3, `game_settings.featured_entries` 0–0, `game_settings.league_h2h_tiebreak_stats` 2–2, `game_settings.percentile_ranks` 20–20, `game_settings.ui_special_shirt_exclusions` 0–0, `phases` 11–11, `teams` 20–20
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `chips`
  - added `chips[]`
  - added `chips[].chip_type`
  - added `chips[].id`
  - added `chips[].name`
  - added `chips[].number`
  - added `chips[].overrides`
  - added `chips[].overrides.element_types`
  - added `chips[].overrides.pick_multiplier`
  - added `chips[].overrides.rules`
  - added `chips[].overrides.scoring`
  - added `chips[].start_event`
  - added `chips[].stop_event`
  - added `element_stats`
  - added `element_stats[]`
  - added `element_stats[].label`
  - added `element_stats[].name`
  - added `element_types`
  - added `element_types[]`
  - added `element_types[].element_count`
  - added `element_types[].id`
  - added `element_types[].plural_name`
  - added `element_types[].plural_name_short`
  - added `element_types[].singular_name`
  - added `element_types[].singular_name_short`
  - added `element_types[].squad_max_play`
  - added `element_types[].squad_max_select`
  - added `element_types[].squad_min_play`
  - added `element_types[].squad_min_select`
  - added `element_types[].squad_select`
  - added `element_types[].sub_positions_locked`
  - added `element_types[].sub_positions_locked[]`
  - added `element_types[].ui_shirt_specific`
  - added `elements`
  - added `elements[]`
  - added `elements[].assists`
  - added `elements[].birth_date`
  - added `elements[].bonus`
  - added `elements[].bps`
  - added `elements[].can_select`
  - added `elements[].can_transact`
  - added `elements[].chance_of_playing_next_round`
  - added `elements[].chance_of_playing_this_round`
  - added `elements[].clean_sheets`
  - added `elements[].clean_sheets_per_90`
  - added `elements[].clearances_blocks_interceptions`
  - added `elements[].code`
  - added `elements[].corners_and_indirect_freekicks_order`
  - added `elements[].corners_and_indirect_freekicks_text`
  - added `elements[].cost_change_event`
  - added `elements[].cost_change_event_fall`
  - added `elements[].cost_change_start`
  - added `elements[].cost_change_start_fall`
  - added `elements[].creativity`
  - added `elements[].creativity_rank`
  - added `elements[].creativity_rank_type`
  - added `elements[].defensive_contribution`
  - added `elements[].defensive_contribution_per_90`
  - added `elements[].direct_freekicks_order`
  - added `elements[].direct_freekicks_text`
  - added `elements[].dreamteam_count`
  - added `elements[].element_type`
  - added `elements[].ep_next`
  - added `elements[].ep_this`
  - added `elements[].event_points`
  - added `elements[].expected_assists`
  - added `elements[].expected_assists_per_90`
  - added `elements[].expected_goal_involvements`
  - added `elements[].expected_goal_involvements_per_90`
  - added `elements[].expected_goals`
  - added `elements[].expected_goals_conceded`
  - added `elements[].expected_goals_conceded_per_90`
  - added `elements[].expected_goals_per_90`
  - added `elements[].first_name`
  - added `elements[].form`
  - added `elements[].form_rank`
  - added `elements[].form_rank_type`
  - added `elements[].goals_conceded`
  - added `elements[].goals_conceded_per_90`
  - added `elements[].goals_scored`
  - added `elements[].has_temporary_code`
  - added `elements[].ict_index`
  - added `elements[].ict_index_rank`
  - added `elements[].ict_index_rank_type`
  - added `elements[].id`
  - added `elements[].in_dreamteam`
  - added `elements[].influence`
  - added `elements[].influence_rank`
  - added `elements[].influence_rank_type`
  - added `elements[].known_name`
  - added `elements[].minutes`
  - added `elements[].news`
  - added `elements[].news_added`
  - added `elements[].now_cost`
  - added `elements[].now_cost_rank`
  - added `elements[].now_cost_rank_type`
  - added `elements[].opta_code`
  - added `elements[].own_goals`
  - added `elements[].penalties_missed`
  - added `elements[].penalties_order`
  - added `elements[].penalties_saved`
  - added `elements[].penalties_text`
  - added `elements[].photo`
  - added `elements[].points_per_game`
  - added `elements[].points_per_game_rank`
  - added `elements[].points_per_game_rank_type`
  - added `elements[].price_change_calibrating`
  - added `elements[].price_change_hourly_rate`
  - added `elements[].price_change_locked_until`
  - added `elements[].price_change_percent`
  - added `elements[].price_change_projections`
  - added `elements[].price_change_projections[]`
  - added `elements[].price_change_projections[].likelihood`
  - added `elements[].price_change_projections[].offset`
  - added `elements[].price_change_projections[].projected_percent`
  - added `elements[].recoveries`
  - added `elements[].red_cards`
  - added `elements[].region`
  - added `elements[].removed`
  - added `elements[].saves`
  - added `elements[].saves_per_90`
  - added `elements[].scout_news_link`
  - added `elements[].scout_risks`
  - added `elements[].second_name`
  - added `elements[].selected_by_percent`
  - added `elements[].selected_rank`
  - added `elements[].selected_rank_type`
  - added `elements[].special`
  - added `elements[].squad_number`
  - added `elements[].starts`
  - added `elements[].starts_per_90`
  - added `elements[].status`
  - added `elements[].tackles`
  - added `elements[].team`
  - added `elements[].team_code`
  - added `elements[].team_join_date`
  - added `elements[].threat`
  - added `elements[].threat_rank`
  - added `elements[].threat_rank_type`
  - added `elements[].total_points`
  - added `elements[].transfers_in`
  - added `elements[].transfers_in_event`
  - added `elements[].transfers_out`
  - added `elements[].transfers_out_event`
  - added `elements[].value_form`
  - added `elements[].value_season`
  - added `elements[].web_name`
  - added `elements[].yellow_cards`
  - added `events`
  - added `events[]`
  - added `events[].average_entry_score`
  - added `events[].can_enter`
  - added `events[].can_manage`
  - added `events[].chip_plays`
  - added `events[].chip_plays[]`
  - added `events[].chip_plays[].chip_name`
  - added `events[].chip_plays[].num_played`
  - added `events[].cup_leagues_created`
  - added `events[].data_checked`
  - added `events[].deadline_time`
  - added `events[].deadline_time_epoch`
  - added `events[].deadline_time_game_offset`
  - added `events[].finished`
  - added `events[].h2h_ko_matches_created`
  - added `events[].highest_score`
  - added `events[].highest_scoring_entry`
  - added `events[].id`
  - added `events[].is_current`
  - added `events[].is_next`
  - added `events[].is_previous`
  - added `events[].most_captained`
  - added `events[].most_selected`
  - added `events[].most_transferred_in`
  - added `events[].most_vice_captained`
  - added `events[].name`
  - added `events[].overrides`
  - added `events[].overrides.element_types`
  - added `events[].overrides.pick_multiplier`
  - added `events[].overrides.rules`
  - added `events[].overrides.scoring`
  - added `events[].ranked_count`
  - added `events[].release_time`
  - added `events[].released`
  - added `events[].top_element`
  - added `events[].top_element_info`
  - added `events[].top_element_info.id`
  - added `events[].top_element_info.points`
  - added `events[].transfers_made`
  - added `game_config`
  - added `game_config.rules`
  - added `game_config.rules.cup_qualifying_method`
  - added `game_config.rules.cup_start_event_id`
  - added `game_config.rules.cup_stop_event_id`
  - added `game_config.rules.cup_type`
  - added `game_config.rules.element_sell_at_purchase_price`
  - added `game_config.rules.featured_entries`
  - added `game_config.rules.league_h2h_tiebreak_stats`
  - added `game_config.rules.league_h2h_tiebreak_stats[]`
  - added `game_config.rules.league_join_private_max`
  - added `game_config.rules.league_join_public_max`
  - added `game_config.rules.league_ko_first_instead_of_random`
  - added `game_config.rules.league_max_ko_rounds_private_h2h`
  - added `game_config.rules.league_max_size_private_h2h`
  - added `game_config.rules.league_max_size_public_classic`
  - added `game_config.rules.league_max_size_public_h2h`
  - added `game_config.rules.league_points_h2h_draw`
  - added `game_config.rules.league_points_h2h_lose`
  - added `game_config.rules.league_points_h2h_win`
  - added `game_config.rules.league_prefix_public`
  - added `game_config.rules.max_extra_free_transfers`
  - added `game_config.rules.percentile_ranks`
  - added `game_config.rules.percentile_ranks[]`
  - added `game_config.rules.squad_special_max`
  - added `game_config.rules.squad_special_min`
  - added `game_config.rules.squad_squadplay`
  - added `game_config.rules.squad_squadsize`
  - added `game_config.rules.squad_team_limit`
  - added `game_config.rules.squad_total_spend`
  - added `game_config.rules.stats_form_days`
  - added `game_config.rules.sys_vice_captain_enabled`
  - added `game_config.rules.transfers_cap`
  - added `game_config.rules.transfers_sell_on_fee`
  - added `game_config.rules.ui_currency_multiplier`
  - added `game_config.rules.ui_special_shirt_exclusions`
  - added `game_config.rules.ui_use_special_shirts`
  - added `game_config.rules.underdog_differential`
  - added `game_config.scoring`
  - added `game_config.scoring.assists`
  - added `game_config.scoring.bonus`
  - added `game_config.scoring.bps`
  - added `game_config.scoring.clean_sheets`
  - added `game_config.scoring.clean_sheets.DEF`
  - added `game_config.scoring.clean_sheets.FWD`
  - added `game_config.scoring.clean_sheets.GKP`
  - added `game_config.scoring.clean_sheets.MID`
  - added `game_config.scoring.clearances_blocks_interceptions`
  - added `game_config.scoring.creativity`
  - added `game_config.scoring.defensive_contribution`
  - added `game_config.scoring.defensive_contribution.DEF`
  - added `game_config.scoring.defensive_contribution.FWD`
  - added `game_config.scoring.defensive_contribution.GKP`
  - added `game_config.scoring.defensive_contribution.MID`
  - added `game_config.scoring.expected_assists`
  - added `game_config.scoring.expected_goal_involvements`
  - added `game_config.scoring.expected_goals`
  - added `game_config.scoring.expected_goals_conceded`
  - added `game_config.scoring.goals_conceded`
  - added `game_config.scoring.goals_conceded.DEF`
  - added `game_config.scoring.goals_conceded.FWD`
  - added `game_config.scoring.goals_conceded.GKP`
  - added `game_config.scoring.goals_conceded.MID`
  - added `game_config.scoring.goals_scored`
  - added `game_config.scoring.goals_scored.DEF`
  - added `game_config.scoring.goals_scored.FWD`
  - added `game_config.scoring.goals_scored.GKP`
  - added `game_config.scoring.goals_scored.MID`
  - added `game_config.scoring.ict_index`
  - added `game_config.scoring.influence`
  - added `game_config.scoring.long_play`
  - added `game_config.scoring.mng_clean_sheets`
  - added `game_config.scoring.mng_clean_sheets.DEF`
  - added `game_config.scoring.mng_clean_sheets.FWD`
  - added `game_config.scoring.mng_clean_sheets.GKP`
  - added `game_config.scoring.mng_clean_sheets.MID`
  - added `game_config.scoring.mng_draw`
  - added `game_config.scoring.mng_draw.DEF`
  - added `game_config.scoring.mng_draw.FWD`
  - added `game_config.scoring.mng_draw.GKP`
  - added `game_config.scoring.mng_draw.MID`
  - added `game_config.scoring.mng_goals_scored`
  - added `game_config.scoring.mng_goals_scored.DEF`
  - added `game_config.scoring.mng_goals_scored.FWD`
  - added `game_config.scoring.mng_goals_scored.GKP`
  - added `game_config.scoring.mng_goals_scored.MID`
  - added `game_config.scoring.mng_loss`
  - added `game_config.scoring.mng_underdog_draw`
  - added `game_config.scoring.mng_underdog_draw.DEF`
  - added `game_config.scoring.mng_underdog_draw.FWD`
  - added `game_config.scoring.mng_underdog_draw.GKP`
  - added `game_config.scoring.mng_underdog_draw.MID`
  - added `game_config.scoring.mng_underdog_win`
  - added `game_config.scoring.mng_underdog_win.DEF`
  - added `game_config.scoring.mng_underdog_win.FWD`
  - added `game_config.scoring.mng_underdog_win.GKP`
  - added `game_config.scoring.mng_underdog_win.MID`
  - added `game_config.scoring.mng_win`
  - added `game_config.scoring.mng_win.DEF`
  - added `game_config.scoring.mng_win.FWD`
  - added `game_config.scoring.mng_win.GKP`
  - added `game_config.scoring.mng_win.MID`
  - added `game_config.scoring.own_goals`
  - added `game_config.scoring.penalties_missed`
  - added `game_config.scoring.penalties_saved`
  - added `game_config.scoring.recoveries`
  - added `game_config.scoring.red_cards`
  - added `game_config.scoring.saves`
  - added `game_config.scoring.short_play`
  - added `game_config.scoring.special_multiplier`
  - added `game_config.scoring.starts`
  - added `game_config.scoring.tackles`
  - added `game_config.scoring.threat`
  - added `game_config.scoring.yellow_cards`
  - added `game_config.settings`
  - added `game_config.settings.entry_per_event`
  - added `game_config.settings.price_change_deadlines`
  - added `game_config.settings.price_change_deadlines[]`
  - added `game_config.settings.static_content_url`
  - added `game_config.settings.timezone`
  - added `game_config.status`
  - added `game_config.status.price_change_last_updated`
  - added `game_settings`
  - added `game_settings.cup_qualifying_method`
  - added `game_settings.cup_start_event_id`
  - added `game_settings.cup_stop_event_id`
  - added `game_settings.cup_type`
  - added `game_settings.element_sell_at_purchase_price`
  - added `game_settings.featured_entries`
  - added `game_settings.league_h2h_tiebreak_stats`
  - added `game_settings.league_h2h_tiebreak_stats[]`
  - added `game_settings.league_join_private_max`
  - added `game_settings.league_join_public_max`
  - added `game_settings.league_ko_first_instead_of_random`
  - added `game_settings.league_max_ko_rounds_private_h2h`
  - added `game_settings.league_max_size_private_h2h`
  - added `game_settings.league_max_size_public_classic`
  - added `game_settings.league_max_size_public_h2h`
  - added `game_settings.league_points_h2h_draw`
  - added `game_settings.league_points_h2h_lose`
  - added `game_settings.league_points_h2h_win`
  - added `game_settings.league_prefix_public`
  - added `game_settings.max_extra_free_transfers`
  - added `game_settings.percentile_ranks`
  - added `game_settings.percentile_ranks[]`
  - added `game_settings.squad_special_max`
  - added `game_settings.squad_special_min`
  - added `game_settings.squad_squadplay`
  - added `game_settings.squad_squadsize`
  - added `game_settings.squad_team_limit`
  - added `game_settings.squad_total_spend`
  - added `game_settings.stats_form_days`
  - added `game_settings.sys_vice_captain_enabled`
  - added `game_settings.timezone`
  - added `game_settings.transfers_cap`
  - added `game_settings.transfers_sell_on_fee`
  - added `game_settings.ui_currency_multiplier`
  - added `game_settings.ui_special_shirt_exclusions`
  - added `game_settings.ui_use_special_shirts`
  - added `game_settings.underdog_differential`
  - added `phases`
  - added `phases[]`
  - added `phases[].highest_score`
  - added `phases[].id`
  - added `phases[].name`
  - added `phases[].start_event`
  - added `phases[].stop_event`
  - added `teams`
  - added `teams[]`
  - added `teams[].code`
  - added `teams[].draw`
  - added `teams[].form`
  - added `teams[].id`
  - added `teams[].link_url`
  - added `teams[].loss`
  - added `teams[].name`
  - added `teams[].played`
  - added `teams[].points`
  - added `teams[].position`
  - added `teams[].pulse_id`
  - added `teams[].short_name`
  - added `teams[].strength`
  - added `teams[].strength_attack_away`
  - added `teams[].strength_attack_home`
  - added `teams[].strength_defence_away`
  - added `teams[].strength_defence_home`
  - added `teams[].strength_overall_away`
  - added `teams[].strength_overall_home`
  - added `teams[].team_division`
  - added `teams[].unavailable`
  - added `teams[].win`
  - added `total_players`

### fixtures (2 responses)

- Nullable paths: `[].team_a_score` (number (nullable)), `[].team_h_score` (number (nullable))
- Optional (missing on some objects): none
- Array lengths: `<root>` 10–380, `[].stats` 0–11, `[].stats[].a` 0–16, `[].stats[].h` 0–17
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `[]`
  - added `[].code`
  - added `[].event`
  - added `[].finished`
  - added `[].finished_provisional`
  - added `[].id`
  - added `[].kickoff_time`
  - added `[].minutes`
  - added `[].provisional_start_time`
  - added `[].pulse_id`
  - added `[].started`
  - added `[].stats`
  - added `[].stats[]`
  - added `[].stats[].a`
  - added `[].stats[].a[]`
  - added `[].stats[].a[].element`
  - added `[].stats[].a[].value`
  - added `[].stats[].h`
  - added `[].stats[].h[]`
  - added `[].stats[].h[].element`
  - added `[].stats[].h[].value`
  - added `[].stats[].identifier`
  - added `[].team_a`
  - added `[].team_a_difficulty`
  - added `[].team_a_score`
  - added `[].team_h`
  - added `[].team_h_difficulty`
  - added `[].team_h_score`

### event-status (1 response)

- Nullable paths: none observed
- Optional (missing on some objects): none
- Array lengths: `status` 3–3
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `leagues`
  - added `status`
  - added `status[]`
  - added `status[].bonus_added`
  - added `status[].date`
  - added `status[].event`
  - added `status[].points`

### leagues-classic-standings (2 responses)

- Nullable paths: `league.cup_league` (null (nullable)), `league.max_entries` (null (nullable)), `league.rank` (null (nullable)), `standings.results[].club_badge_src` (string (nullable))
- Optional (missing on some objects): none
- Array lengths: `new_entries.results` 0–0, `standings.results` 9–10
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `last_updated_data`
  - added `league`
  - added `league.admin_entry`
  - added `league.closed`
  - added `league.code_privacy`
  - added `league.created`
  - added `league.cup_league`
  - added `league.has_cup`
  - added `league.id`
  - added `league.league_type`
  - added `league.max_entries`
  - added `league.name`
  - added `league.rank`
  - added `league.scoring`
  - added `league.start_event`
  - added `new_entries`
  - added `new_entries.has_next`
  - added `new_entries.page`
  - added `new_entries.results`
  - added `standings`
  - added `standings.has_next`
  - added `standings.page`
  - added `standings.results`
  - added `standings.results[]`
  - added `standings.results[].club_badge_src`
  - added `standings.results[].entry`
  - added `standings.results[].entry_name`
  - added `standings.results[].event_total`
  - added `standings.results[].last_rank`
  - added `standings.results[].player_name`
  - added `standings.results[].rank`
  - added `standings.results[].rank_sort`
  - added `standings.results[].total`

### entry (1 response)

- Nullable paths: `club_badge_src` (null (nullable)), `kit` (null (nullable)), `leagues.classic[].admin_entry` (null (nullable)), `leagues.classic[].cup_league` (null (nullable)), `leagues.classic[].cup_qualified` (null (nullable)), `leagues.classic[].max_entries` (null (nullable)), `leagues.classic[].rank` (null (nullable)), `leagues.cup.cup_league` (null (nullable)), `leagues.cup.status.qualification_event` (null (nullable)), `leagues.cup.status.qualification_numbers` (null (nullable)), `leagues.cup.status.qualification_rank` (null (nullable)), `leagues.cup.status.qualification_state` (null (nullable)), `leagues.h2h[].cup_league` (null (nullable)), `leagues.h2h[].cup_qualified` (null (nullable)), `leagues.h2h[].entry_percentile_rank` (null (nullable)), `leagues.h2h[].max_entries` (null (nullable)), `leagues.h2h[].rank` (null (nullable)), `leagues.h2h[].rank_count` (null (nullable)), `leagues.h2h[].short_name` (null (nullable))
- Optional (missing on some objects): none
- Array lengths: `entered_events` 5–5, `leagues.classic` 2–2, `leagues.classic[].active_phases` 2–2, `leagues.classic[].featured_entry_ids` 0–0, `leagues.cup.matches` 0–0, `leagues.cup_matches` 0–0, `leagues.event` 0–0, `leagues.h2h` 2–2, `leagues.h2h[].active_phases` 0–0, `leagues.h2h[].featured_entry_ids` 0–0
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `club_badge_src`
  - added `current_event`
  - added `entered_events`
  - added `entered_events[]`
  - added `favourite_team`
  - added `id`
  - added `joined_time`
  - added `kit`
  - added `last_deadline_bank`
  - added `last_deadline_total_transfers`
  - added `last_deadline_value`
  - added `leagues`
  - added `leagues.classic`
  - added `leagues.classic[]`
  - added `leagues.classic[].active_phases`
  - added `leagues.classic[].active_phases[]`
  - added `leagues.classic[].active_phases[].entry_percentile_rank`
  - added `leagues.classic[].active_phases[].last_rank`
  - added `leagues.classic[].active_phases[].league_id`
  - added `leagues.classic[].active_phases[].phase`
  - added `leagues.classic[].active_phases[].rank`
  - added `leagues.classic[].active_phases[].rank_count`
  - added `leagues.classic[].active_phases[].rank_sort`
  - added `leagues.classic[].active_phases[].total`
  - added `leagues.classic[].admin_entry`
  - added `leagues.classic[].closed`
  - added `leagues.classic[].created`
  - added `leagues.classic[].cup_league`
  - added `leagues.classic[].cup_qualified`
  - added `leagues.classic[].entry_can_admin`
  - added `leagues.classic[].entry_can_invite`
  - added `leagues.classic[].entry_can_leave`
  - added `leagues.classic[].entry_last_rank`
  - added `leagues.classic[].entry_percentile_rank`
  - added `leagues.classic[].entry_rank`
  - added `leagues.classic[].featured_entry_ids`
  - added `leagues.classic[].has_cup`
  - added `leagues.classic[].id`
  - added `leagues.classic[].league_type`
  - added `leagues.classic[].max_entries`
  - added `leagues.classic[].name`
  - added `leagues.classic[].rank`
  - added `leagues.classic[].rank_count`
  - added `leagues.classic[].scoring`
  - added `leagues.classic[].short_name`
  - added `leagues.classic[].start_event`
  - added `leagues.cup`
  - added `leagues.cup.cup_league`
  - added `leagues.cup.matches`
  - added `leagues.cup.status`
  - added `leagues.cup.status.qualification_event`
  - added `leagues.cup.status.qualification_numbers`
  - added `leagues.cup.status.qualification_rank`
  - added `leagues.cup.status.qualification_state`
  - added `leagues.cup_matches`
  - added `leagues.event`
  - added `leagues.h2h`
  - added `leagues.h2h[]`
  - added `leagues.h2h[].active_phases`
  - added `leagues.h2h[].admin_entry`
  - added `leagues.h2h[].closed`
  - added `leagues.h2h[].created`
  - added `leagues.h2h[].cup_league`
  - added `leagues.h2h[].cup_qualified`
  - added `leagues.h2h[].entry_can_admin`
  - added `leagues.h2h[].entry_can_invite`
  - added `leagues.h2h[].entry_can_leave`
  - added `leagues.h2h[].entry_last_rank`
  - added `leagues.h2h[].entry_percentile_rank`
  - added `leagues.h2h[].entry_rank`
  - added `leagues.h2h[].featured_entry_ids`
  - added `leagues.h2h[].has_cup`
  - added `leagues.h2h[].id`
  - added `leagues.h2h[].league_type`
  - added `leagues.h2h[].max_entries`
  - added `leagues.h2h[].name`
  - added `leagues.h2h[].rank`
  - added `leagues.h2h[].rank_count`
  - added `leagues.h2h[].scoring`
  - added `leagues.h2h[].short_name`
  - added `leagues.h2h[].start_event`
  - added `name`
  - added `name_change_blocked`
  - added `player_first_name`
  - added `player_last_name`
  - added `player_region_id`
  - added `player_region_iso_code_long`
  - added `player_region_iso_code_short`
  - added `player_region_name`
  - added `started_event`
  - added `summary_event_points`
  - added `summary_event_rank`
  - added `summary_overall_points`
  - added `summary_overall_rank`
  - added `years_active`

### entry-history (1 response)

- Nullable paths: none observed
- Optional (missing on some objects): none
- Array lengths: `chips` 0–0, `current` 5–5, `past` 9–9
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `chips`
  - added `current`
  - added `current[]`
  - added `current[].bank`
  - added `current[].event`
  - added `current[].event_transfers`
  - added `current[].event_transfers_cost`
  - added `current[].overall_rank`
  - added `current[].overall_rank_percentage`
  - added `current[].percentile_rank`
  - added `current[].points`
  - added `current[].points_on_bench`
  - added `current[].rank`
  - added `current[].rank_sort`
  - added `current[].total_points`
  - added `current[].value`
  - added `past`
  - added `past[]`
  - added `past[].rank`
  - added `past[].rank_percentage`
  - added `past[].season_name`
  - added `past[].total_points`

### entry-picks (1 response)

- Nullable paths: `active_chip` (null (nullable))
- Optional (missing on some objects): none
- Array lengths: `automatic_subs` 0–0, `picks` 15–15
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `active_chip`
  - added `automatic_subs`
  - added `entry_history`
  - added `entry_history.bank`
  - added `entry_history.event`
  - added `entry_history.event_transfers`
  - added `entry_history.event_transfers_cost`
  - added `entry_history.overall_rank`
  - added `entry_history.overall_rank_percentage`
  - added `entry_history.percentile_rank`
  - added `entry_history.points`
  - added `entry_history.points_on_bench`
  - added `entry_history.rank`
  - added `entry_history.rank_sort`
  - added `entry_history.total_points`
  - added `entry_history.value`
  - added `picks`
  - added `picks[]`
  - added `picks[].element`
  - added `picks[].element_type`
  - added `picks[].is_captain`
  - added `picks[].is_vice_captain`
  - added `picks[].multiplier`
  - added `picks[].position`

### entry-transfers (1 response)

- Nullable paths: none observed
- Optional (missing on some objects): none
- Array lengths: `<root>` 4–4
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `[]`
  - added `[].element_in`
  - added `[].element_in_cost`
  - added `[].element_out`
  - added `[].element_out_cost`
  - added `[].entry`
  - added `[].event`
  - added `[].time`

### event-live (1 response)

- Nullable paths: none observed
- Optional (missing on some objects): none
- Array lengths: `elements` 35–35, `elements[].explain` 1–1, `elements[].explain[].stats` 1–5
- Diff vs baseline: no baseline (first recording)
  - added `<root>`
  - added `elements`
  - added `elements[]`
  - added `elements[].explain`
  - added `elements[].explain[]`
  - added `elements[].explain[].fixture`
  - added `elements[].explain[].stats`
  - added `elements[].explain[].stats[]`
  - added `elements[].explain[].stats[].identifier`
  - added `elements[].explain[].stats[].points`
  - added `elements[].explain[].stats[].points_modification`
  - added `elements[].explain[].stats[].value`
  - added `elements[].id`
  - added `elements[].modified`
  - added `elements[].stats`
  - added `elements[].stats.assists`
  - added `elements[].stats.bonus`
  - added `elements[].stats.bps`
  - added `elements[].stats.clean_sheets`
  - added `elements[].stats.clearances_blocks_interceptions`
  - added `elements[].stats.creativity`
  - added `elements[].stats.defensive_contribution`
  - added `elements[].stats.expected_assists`
  - added `elements[].stats.expected_goal_involvements`
  - added `elements[].stats.expected_goals`
  - added `elements[].stats.expected_goals_conceded`
  - added `elements[].stats.goals_conceded`
  - added `elements[].stats.goals_scored`
  - added `elements[].stats.ict_index`
  - added `elements[].stats.in_dreamteam`
  - added `elements[].stats.influence`
  - added `elements[].stats.minutes`
  - added `elements[].stats.own_goals`
  - added `elements[].stats.penalties_missed`
  - added `elements[].stats.penalties_saved`
  - added `elements[].stats.played`
  - added `elements[].stats.recoveries`
  - added `elements[].stats.red_cards`
  - added `elements[].stats.saves`
  - added `elements[].stats.starts`
  - added `elements[].stats.tackles`
  - added `elements[].stats.threat`
  - added `elements[].stats.total_points`
  - added `elements[].stats.yellow_cards`

## Points reconciliation evidence

Season semantics: **UNVERIFIED** ({"gross":0,"net":0,"noCost":5,"mismatch":0,"incomplete":0})

- E1: UNVERIFIED; rows with a hit, mismatch or gap:
  - none

