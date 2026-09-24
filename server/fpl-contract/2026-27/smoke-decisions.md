# Step 2 smoke-test decisions — 2026-27

Source: `smoke-report.md` in this directory (run 2026-09-24, GW5, leagues L1/L2, entry E1).
Result: exit 2 — 29 PASS, 0 FAIL, 5 UNVERIFIED, 1 DEFERRED_TO_STEP_3; every response matched the schemas.
The architecture's Step 2 gate (v0.3 §15) accepts "exit 0, or documented decisions per failed assumption";
this file holds those decisions.

## Confirmed by real data

| Topic | Finding | Consequence |
|---|---|---|
| Private league access (L1) | Both leagues readable anonymously (`OK`) | Groups use `member_source = LEAGUE_STANDINGS`; manual entry-ID fallback stays available (v0.2 §10) |
| Chip windows (B5) | `bootstrap-static.chips[]` has 8 valid rules (wildcard/freehit/bboost/3xc × two halves) | Chip rules source = `FPL_BOOTSTRAP`; config fallback not needed this season |
| Event flags (B7) | GW5 `finished = true`, `data_checked = true` | Finalize gate inputs available as designed |
| Picks (P1–P5) | 15 picks, 1 C + 1 VC, `active_chip = null`, picks points = history points, Σ multiplier × live points = picks points (captain ×2, bench ×0) | FPL multipliers usable as the cross-check the engine expects |
| Next GW picks (P6) | Before the deadline: HTTP 404 `{ "detail": … }` | Treat 404 before the deadline as "no picks yet", not an error |
| Transfers (T1–T2) | All fields present; costs are integer tenths (41–80) | Prices stay integer tenths (v0.3 §2 #11) |
| Event status (S1–S2) | Rows per match day with `event, date, bonus_added, points` (`"r"`); `leagues = "Updated"` | Recorded verbatim; `date` is present and now required |
| Caching | `bootstrap-static`: `max-age=300`; all others `no-cache` | Client TTLs (bootstrap 5 min, others ≤ 5 min) are compatible |
| Sizes | bootstrap 1.78 MB, fixtures 232 KB, live 474 KB | Bootstrap stays under the 2 MB raw cap but is never stored (v0.3 §9) |

## UNVERIFIED — decisions

| Check | Why unverified | Decision |
|---|---|---|
| **H3 points semantics** | E1 has no gameweek with `event_transfers_cost > 0`, so gross vs net is unproven | **Open — re-run requested** with `--league-members` to sample every league member and find a hit. The v0.2 §2 design already copes at runtime (season semantics start `UNVERIFIED` and flip on the first reconciling hit row), but Step 3 needs a real hit row as a contract sample |
| F2 fixtures `event = null` | No unscheduled fixture exists right now | Keep `event` and `kickoff_time` nullable (v0.2 §3); the engine ignores `event = null` fixtures. Re-check at every smoke run |
| L3 pagination (L1, L2) | Both leagues fit on one page (10 and 9 members, `has_next = false`) | Not needed for these groups; the client follows `has_next` regardless. Revisit if a group outgrows one page |
| T3 wildcard/free-hit transfers | E1 has not played either chip | Transfers are replaced wholesale per sync (v0.3 §6), so either behaviour is handled; re-check with `--league-members` |
| Auto-subs / history chips shapes | No auto-sub and no chip played by E1 | Element shapes kept per v0.2 §7/§8 (`element_in/element_out`, `name/event`); re-check with `--league-members` |

## Deferred

| Check | Decision |
|---|---|
| V3 (engine effective multiplier × points = gross) | `DEFERRED_TO_STEP_3`: needs `deriveEffectiveSquad`; P5 already verifies the same identity with FPL's multipliers |

## Privacy

Samples are anonymized per v0.2 §11 (names → "Manager N"/"Team N", entry/league IDs remapped). In addition, ranks
(`overall_rank`, `summary_*_rank`, `entry_rank`, …), career history (`past`) and join timestamps are replaced with
placeholders, because an overall rank can be looked up in FPL's public standings and identifies the manager.
