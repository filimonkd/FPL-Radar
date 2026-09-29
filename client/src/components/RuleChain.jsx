import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { explain } from '../lib/format.js';

// Tie-break chain editor: only documented rules, in order; SHARED is always last.
export const RULE_OPTIONS = ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'HIGHER_CAPTAIN_POINTS', 'NO_CHIP_PLAYED'];

export function RuleChain({ rules, onChange, disabled }) {
  const move = (i, d) => { const n = [...rules]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  const toggle = (r) => onChange(rules.includes(r) ? rules.filter((x) => x !== r) : [...rules, r]);
  const iconBtn = 'grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-30';
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold">Tie-breaks, in order</legend>
      <p className="text-xs text-muted">Only documented rules. A tie still unresolved at the end is shared.</p>
      <ol className="mt-2 space-y-1.5">
        {rules.map((r, i) => (
          <li key={r} className="flex items-center gap-1 rounded-xl bg-surface-2 py-1 pr-1 pl-3 ring-1 ring-line">
            <span className="w-5 font-bold text-muted">{i + 1}</span><span className="flex-1 font-medium">{explain(r)}</span>
            <button type="button" className={iconBtn} disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r} up`}><ArrowUp size={16} /></button>
            <button type="button" className={iconBtn} disabled={disabled || i === rules.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r} down`}><ArrowDown size={16} /></button>
            <button type="button" className={iconBtn} disabled={disabled} onClick={() => toggle(r)} aria-label={`Remove ${r}`}><X size={16} /></button>
          </li>
        ))}
        <li className="flex items-center gap-1 rounded-xl py-2 pl-3 text-muted ring-1 ring-dashed ring-line"><span className="w-5 font-bold">{rules.length + 1}</span>Shared</li>
      </ol>
      {RULE_OPTIONS.some((r) => !rules.includes(r)) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {RULE_OPTIONS.filter((r) => !rules.includes(r)).map((r) => (
            <button key={r} type="button" disabled={disabled} onClick={() => toggle(r)} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-surface px-3 text-xs font-semibold ring-1 ring-line hover:ring-brand/40 disabled:opacity-40"><Plus size={14} />{explain(r)}</button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
