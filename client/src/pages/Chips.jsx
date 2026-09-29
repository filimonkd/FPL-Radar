import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { explain } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Avatar, Badge, Card, ErrorBox, Notice, Skeleton } from '../components/ui.jsx';

// Chips page (v0.2 §8, Step 11 API): rule source badge, this GW's chip state
// per manager (never "no chip" from missing data), and availability per window.
const STATE_TEXT = {
  PLAYED: 'Played',
  NONE: 'No chip',
  ACTIVE_UNCONFIRMED: 'Active, not yet in history',
  SOURCE_DISAGREEMENT: 'FPL sources disagree',
  UNKNOWN: 'Unknown',
};

export default function Chips({ group, season, gw }) {
  const chips = useQuery({ queryKey: ['chips', group.id, season, gw], queryFn: () => endpoints.chips(group.id, season, gw) });
  const name = useNames(group, season, gw);
  if (chips.isLoading) return <Skeleton rows={5} />;
  if (chips.error) return <ErrorBox error={chips.error} title="Chips unavailable" />;
  const c = chips.data.chips;
  const chipNames = [...new Set((c.rules?.rules ?? []).map((r) => r.chipName))];
  const label = (n) => c.rules?.rules.find((r) => r.chipName === n)?.label ?? n;

  return (
    <div className="space-y-4">
      <Card
        padded={false}
        title={`Chips · GW${c.event}`}
        actions={c.rules && <Badge tone={c.rules.source === 'FPL_BOOTSTRAP' ? 'good' : 'warn'} testId="chip-source">{c.rules.source === 'FPL_BOOTSTRAP' ? 'Rules from FPL' : 'Fallback rules'}</Badge>}
      >
        {(c.provisional || c.warnings.length > 0 || c.missingEntryIds.length > 0) && (
          <div className="space-y-2 px-4 pb-3 sm:px-5">
            {c.provisional && <Notice>Provisional: GW{c.event} is not data-checked yet.</Notice>}
            {c.warnings.map((w, i) => <Notice key={i}>{explain(w.code)}</Notice>)}
            {c.missingEntryIds.length > 0 && <Notice>Not synced: {c.missingEntryIds.map(name).join(', ')}</Notice>}
          </div>
        )}
        <ul className="divide-y divide-line" data-testid="chip-states">
          {c.gameweek.map((m) => (
            <li key={m.entryId} className="flex items-center gap-3 px-4 py-3 sm:px-5" data-testid={`chip-row-${m.entryId}`}>
              <Avatar name={name(m.entryId)} id={m.entryId} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{name(m.entryId)}{m.isExcluded && <> <Badge tone="neutral">excluded</Badge></>}</p>
                <p className="truncate text-xs text-muted">{m.applied ? (m.applied.unknownChip ? 'Unknown chip: no effect applied' : `Effect: ${m.applied.scoringEffect.replace('_', ' ').toLowerCase()}`) : 'Effect: –'}{m.reason ? ` · ${m.reason}` : ''}</p>
              </div>
              <div className="text-right">
                <Badge status={m.state}>{STATE_TEXT[m.state] ?? m.state}</Badge>
                {(m.declaredLabel ?? m.squadChipLabel) && <p className="mt-0.5 text-xs font-semibold">{m.declaredLabel ?? m.squadChipLabel}</p>}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Chips left" subtitle="Current window per manager" padded={false}>
        {!c.availability ? <p className="px-4 pb-4 text-sm text-muted sm:px-5">Chip rules are unavailable, so availability is not shown (nothing is invented).</p> : (
          <ul className="divide-y divide-line" data-testid="chip-availability">
            {c.availability.managers.map((m) => (
              <li key={m.entryId} className="px-4 py-3 sm:px-5">
                <p className="text-sm font-semibold">{name(m.entryId)}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chipNames.map((n) => {
                    const cur = m.chips.find((x) => x.chipName === n && x.current) ?? m.chips.find((x) => x.chipName === n);
                    if (!cur) return null;
                    return <Badge key={n} tone={cur.available ? 'good' : 'neutral'}>{label(n)}{cur.available ? '' : ` · GW${cur.playedEvents?.join(', ') || '?'}`}</Badge>;
                  })}
                  {m.unmapped.map((u) => <Badge key={`${u.chipName}-${u.event}`} tone="warn">{u.chipName} · GW{u.event}</Badge>)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
