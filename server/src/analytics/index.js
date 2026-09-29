// Step 3: pure analytics engine
// Pure functions only (architecture v0.3 §10): no I/O, no clock reads, no db
// imports, no process.env. Enforced by test/unit/architecture.test.js.
export { ENGINE_VERSION } from './version.js';
export * from './constants.js';
export { reconcileSeason } from './reconcile.js';
export { deriveEventState, canFinalize, FinalizeBlockReason } from './eventState.js';
export { selectEligible, IneligibleReason } from './eligibility.js';
export { competitionRanks, resolvePositions } from './ranking.js';
export { TIE_BREAKERS, TIE_BREAK_RULES, CONFIRMED_TIE_BREAK_RULES, DEFAULT_TIE_BREAK_RULES, SHARED, isValidRuleChain } from './tieBreakers.js';
export { computeGwResult } from './winner.js';
export { deriveEffectiveSquad } from './effectiveSquad.js';
export { computeOwnership } from './ownership.js';
export { summarizeTransfers } from './transfers.js';
export { chipAvailability, validateChipRules } from './chips.js';
export { computeRivals, THREAT_RULE, FDR_WINDOW } from './rivals.js';
export { pointsOver, rotationRisk, fixtureRun, sellingPrice, purchasePrice, startPrice, ROTATION_RULE, FIXTURE_WINDOW } from './playerStats.js';
export { playerFlags, buildNewsFeed, OUT_STATUS, PRICE_PRESSURE_NET, FLAG_ORDER, ALERT_FLAGS } from './news.js';
