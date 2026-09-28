import { PointsSemantics, ReconciliationStatus, EventState } from '../analytics/constants.js';
import { CONFIRMED_TIE_BREAK_RULES, DEFAULT_TIE_BREAK_RULES } from '../analytics/tieBreakers.js';

// Enum values shared by Mongoose schemas and the migration 001 validators.
// Points semantics keep UNVERIFIED and CONFLICTED: nothing here assumes gross
// or net until real hit rows prove it (v0.2 §2).
export const POINTS_SEMANTICS = Object.freeze(Object.values(PointsSemantics));
export const RECONCILIATION_STATUSES = Object.freeze(Object.values(ReconciliationStatus));
export const RECONCILED = Object.freeze(['RECONCILED', 'RECONCILED_NO_COST']);
export const UNRECONCILED = Object.freeze(RECONCILIATION_STATUSES.filter((s) => !RECONCILED.includes(s)));
export const EVENT_STATES = Object.freeze(Object.values(EventState));
export const WINNER_RULES = Object.freeze(['NET_POINTS', 'GROSS_POINTS']);
export const MEMBER_SOURCES = Object.freeze(['LEAGUE_STANDINGS', 'MANUAL']);
export const SYNC_TRIGGERS = Object.freeze(['MANUAL', 'FINALIZE', 'SCHEDULER', 'SMOKE', 'STARTUP']);
export const SYNC_STATUSES = Object.freeze(['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'ABANDONED']);
export const RAW_REASONS = Object.freeze(['FINAL_EVIDENCE', 'SCHEMA_FAIL', 'CHIP_RULES_INVALID', 'SMOKE']);
export const CHIP_RULE_SOURCES = Object.freeze(['FPL_BOOTSTRAP', 'CONFIG_FALLBACK']);
export const AUTO_SUB_SOURCES = Object.freeze(['FPL', 'SIMULATED']);
export const RESULT_ACTIONS = Object.freeze(['FINALIZE', 'OVERRIDE', 'RECOMPUTE']);
export const RESULT_PREV_STATUSES = Object.freeze(['PROVISIONAL', 'FINAL', 'OVERRIDDEN']);
export const RESULT_STATUSES = Object.freeze(['FINAL', 'OVERRIDDEN']);
export const SNAPSHOT_KINDS = Object.freeze(['RULE_BASED', 'OVERRIDE']);
// Persisted tie-break config: architecture-documented rules only.
export const TIE_BREAK_RULES = CONFIRMED_TIE_BREAK_RULES;
export { DEFAULT_TIE_BREAK_RULES };
export const SHA256 = /^sha256:[a-f0-9]{64}$/;
export const SEASON_RE = /^\d{4}-\d{2}$/;
