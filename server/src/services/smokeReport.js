// Reads the committed smoke report (server/fpl-contract/<season>/smoke-report.md,
// written by `npm run fpl:smoke`) for the Status page's smoke verdicts
// (v0.3 §15 step 11). Pure: parses our own report format; anything it cannot
// read is reported as unavailable rather than guessed.

const VERDICT = /\*\*(PASS|FAIL|UNVERIFIED|DEFERRED_TO_STEP_\d+)\*\*/;

export function parseSmokeReport(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('# FPL smoke report')) return { available: false };
  const line = (label) => markdown.match(new RegExp(`^- ${label}: (.+)$`, 'm'))?.[1] ?? null;
  const section = markdown.split(/^## Assumption checks\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const checks = [];
  for (const row of section.split('\n')) {
    if (!row.startsWith('| ') || row.startsWith('| ID ') || row.startsWith('|---')) continue;
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const verdict = cells[3]?.match(VERDICT)?.[1];
    if (!verdict) continue;
    checks.push({ id: cells[0], endpoint: cells[1], check: cells[2], verdict, detail: cells[4] ?? '' });
  }
  const counts = checks.reduce((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }), {});
  return {
    available: true,
    season: line('Season'),
    gameweek: line('Gameweek'),
    started: line('Started'),
    exit: markdown.match(/^- \*\*(Exit code \d+[^*]*)\*\*/m)?.[1] ?? null,
    counts,
    checks,
  };
}
