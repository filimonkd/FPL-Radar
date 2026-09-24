import { describe } from './shape.js';

// Renders smoke-report.md. Only report-safe aliases (E1, L1, ...) appear;
// real entry/league IDs and names never reach this file.

const EXIT_LABEL = { 0: 'PASS', 1: 'SCHEMA BREAK', 2: 'ASSUMPTION FAILED / UNVERIFIED', 3: 'NETWORK OR BLOCKED' };
const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(run, { shapes = {}, diffs = {}, baselineWritten = false } = {}) {
  const lines = [];
  const counts = { PASS: 0, FAIL: 0, UNVERIFIED: 0, DEFERRED_TO_STEP_3: 0 };
  for (const c of run.checks) counts[c.status] += 1;

  lines.push('# FPL smoke report', '');
  lines.push(`- Started: ${run.startedAt}`, `- Finished: ${run.finishedAt}`);
  lines.push(`- Season: ${run.season ?? 'unknown (bootstrap unavailable)'}`);
  lines.push(`- Gameweek: ${run.gw ?? 'unknown'}${run.gwSource ? ` (${run.gwSource})` : ''}`);
  lines.push(`- Leagues: ${run.inputs.leagues.join(', ') || 'none given'}; entries: ${run.inputs.entries.join(', ') || 'none given'}` +
    (run.inputs.leagueMembers ? `; plus ${run.inputs.sampledMembers ?? 0} sampled league member(s) (--league-members ${run.inputs.leagueMembers})` : ''));
  lines.push(`- **Exit code ${run.exitCode} — ${EXIT_LABEL[run.exitCode]}**: ${run.exitReason}`);
  lines.push(`- Checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.UNVERIFIED} UNVERIFIED, ${counts.DEFERRED_TO_STEP_3} DEFERRED_TO_STEP_3 (recorded, not counted toward the exit code)`);
  lines.push(`- Samples/shapes baseline: ${baselineWritten ? 'written by this run' : 'not written (no successful responses, or baseline kept; use --update-baseline)'}`, '');

  lines.push('## Requests', '');
  lines.push('| Endpoint | Path | Result | HTTP | Content-Type | Cache-Control | Bytes | ms | Cloudflare | Schema |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of run.requests) {
    lines.push(`| ${cell(r.endpoint)} | \`${cell(r.path)}\` | ${cell(r.classification)}${r.error ? ` (${cell(r.error)})` : ''}${r.denyReason ? ` (x-deny-reason: ${cell(r.denyReason)})` : ''}${r.cfMitigated ? ` (cf-mitigated: ${cell(r.cfMitigated)})` : ''} | ${cell(r.status)} | ${cell(r.contentType)} | ${cell(r.cacheControl)} | ${cell(r.bytes)} | ${cell(r.durationMs)} | ${r.cloudflare ? 'cf-ray' : '—'} | ${r.schemaOk === undefined ? '—' : r.schemaOk ? 'ok' : '**FAIL**'} |`);
  }
  const updating = run.requests.filter((r) => r.gameUpdating);
  lines.push('', `"Game is being updated" body seen: ${updating.length ? updating.map((r) => r.path).join(', ') : 'no'}.`);
  if (run.notAttempted.length) {
    lines.push('', 'Not attempted:', ...run.notAttempted.map((n) => `- ${n.endpoint}: ${n.reason}`));
  }

  lines.push('', '## Assumption checks', '');
  lines.push('| ID | Endpoint | Check | Verdict | Detail |', '|---|---|---|---|---|');
  for (const c of run.checks) lines.push(`| ${c.id} | ${cell(c.endpoint)} | ${cell(c.title)} | **${c.status}** | ${cell(c.detail)} |`);
  const deferred = run.checks.filter((c) => c.status === 'DEFERRED_TO_STEP_3');
  if (deferred.length) {
    lines.push('', `Deferred to Step 3 (engine code; excluded from the exit code): ${deferred.map((c) => `${c.id} — ${c.title}`).join('; ')}.`);
  }

  lines.push('', '## Schema comparison (current zod schemas vs reality)', '');
  const schemaEntries = Object.entries(run.schema);
  if (!schemaEntries.length) {
    lines.push(run.requests.some((r) => r.schemaOk !== undefined) ? 'Every validated response matched the current schemas.' : 'No response was validated.');
  }
  for (const [endpoint, failures] of schemaEntries) {
    lines.push(`### ${endpoint}`, '');
    for (const f of failures) lines.push(`- \`${f.path}\``, ...f.issues.map((i) => `  - ${i}`));
    lines.push('');
  }

  lines.push('', '## Shapes', '');
  if (!Object.keys(shapes).length) lines.push('No shapes recorded (no successful responses).');
  for (const [endpoint, shape] of Object.entries(shapes)) {
    const d = diffs[endpoint];
    lines.push(`### ${endpoint} (${shape.samples} response${shape.samples === 1 ? '' : 's'})`, '');
    const nullable = Object.entries(shape.paths).filter(([, n]) => n.nullable);
    const optional = Object.entries(shape.paths).filter(([, n]) => n.optional);
    const arrays = Object.entries(shape.paths).filter(([, n]) => n.length);
    lines.push(`- Nullable paths: ${nullable.length ? nullable.map(([p, n]) => `\`${p}\` (${describe(n)})`).join(', ') : 'none observed'}`);
    lines.push(`- Optional (missing on some objects): ${optional.length ? optional.map(([p]) => `\`${p}\``).join(', ') : 'none'}`);
    lines.push(`- Array lengths: ${arrays.length ? arrays.slice(0, 25).map(([p, n]) => `\`${p}\` ${n.length.min}–${n.length.max}`).join(', ') : 'none'}${arrays.length > 25 ? ', …' : ''}`);
    if (d) {
      lines.push(`- Diff vs baseline: ${d.baseline ? `${d.added.length} added, ${d.removed.length} removed, ${d.retyped.length} retyped` : 'no baseline (first recording)'}`);
      for (const p of d.added ?? []) lines.push(`  - added \`${p}\``);
      for (const p of d.removed ?? []) lines.push(`  - removed \`${p}\``);
      for (const r of d.retyped ?? []) lines.push(`  - retyped \`${r.path}\`: ${r.from} → ${r.to}`);
    }
    lines.push('');
  }

  if (run.reconciliation) {
    lines.push('## Points reconciliation evidence', '');
    lines.push(`Season semantics: **${run.reconciliation.combined.semantics}** (${JSON.stringify(run.reconciliation.combined.evidence)})`, '');
    for (const e of run.reconciliation.perEntry) {
      const rows = e.rows.filter((r) => r.C > 0 || r.outcome === 'MISMATCH' || r.outcome === 'INCOMPLETE');
      lines.push(`- ${e.alias}: ${e.semantics}; rows with a hit, mismatch or gap:`);
      for (const r of rows) lines.push(`  - GW${r.event}: R=${r.R} C=${r.C} T=${r.T} Tprev=${r.tPrev ?? '?'} → ${r.outcome}`);
      if (!rows.length) lines.push('  - none');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
