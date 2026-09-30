import { useEffect } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import { statusTone, explain } from '../lib/format.js';

// Shared building blocks (Step 15). Mobile-first: 44px touch targets, cards
// instead of wide tables, bottom sheets on phones. Colours come from the
// semantic tokens in index.css, so dark mode follows the OS.

const TONES = {
  good: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
  warn: 'bg-amber-500/12 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  bad: 'bg-rose-500/12 text-rose-700 ring-rose-500/25 dark:text-rose-300',
  neutral: 'bg-white/6 text-[#cfe3dd] ring-white/10',
  info: 'bg-brand/15 text-[#7fe6d2] ring-brand/30',
};

export function Badge({ tone, status, children, title, testId, icon: Icon }) {
  const t = tone ?? statusTone(status ?? children);
  return (
    <span title={title} data-testid={testId} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${TONES[t] ?? TONES.neutral}`}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children ?? status}
    </span>
  );
}

const BUTTONS = {
  primary: 'bg-brand text-brand-ink shadow-[0_8px_24px_-8px_rgba(60,207,180,0.6)] hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:shadow-none',
  secondary: 'bg-white/7 text-ink ring-1 ring-inset ring-white/10 hover:bg-white/12 disabled:opacity-40',
  danger: 'bg-rose-500 text-white hover:bg-rose-400 disabled:opacity-40',
  ghost: 'text-brand hover:bg-brand/10 disabled:opacity-40',
  subtle: 'bg-white/7 text-ink hover:bg-white/12 disabled:opacity-40',
};

export function Button({ variant = 'primary', size = 'md', icon: Icon, className = '', children, ...props }) {
  const sz = size === 'sm' ? 'min-h-10 px-4 text-sm' : 'min-h-12 px-5 text-sm';
  return (
    <button type="button" className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-bold transition disabled:cursor-not-allowed ${sz} ${BUTTONS[variant]} ${className}`} {...props}>
      {Icon && <Icon size={16} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, className = '', padded = true }) {
  return (
    <section className={`card-raised overflow-hidden rounded-[28px] ring-1 ring-white/7 ${padded ? 'p-4 sm:p-5' : ''} ${className}`}>
      {(title || actions) && (
        <div className={`flex flex-wrap items-start justify-between gap-2 ${padded ? 'mb-3' : 'px-4 pt-4 pb-2 sm:px-5'}`}>
          <div className="min-w-0">
            {title && <h2 className="text-lg font-bold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Loading placeholder shaped like the content that is coming. */
export function Skeleton({ rows = 4, label = 'Loading…' }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <div className="skeleton h-28 rounded-[28px]" />
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-16 rounded-[20px]" />)}
    </div>
  );
}

/** An API error as the server reported it: code, message and any reasons. */
export function ErrorBox({ error, title = 'Something went wrong' }) {
  if (!error) return null;
  const reasons = error.details?.reasons;
  return (
    <div role="alert" className="flex gap-3 rounded-[20px] bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-400/30">
      <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{title}{error.code ? ` (${error.code})` : ''}</p>
        <p className="mt-0.5 break-words">{error.message}</p>
        {Array.isArray(reasons) && reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5">{reasons.map((r) => <li key={r}>{explain(r)}</li>)}</ul>
        )}
      </div>
    </div>
  );
}

export function Notice({ tone = 'warn', children, testId }) {
  const c = tone === 'warn' ? 'bg-amber-500/10 text-amber-900 ring-amber-500/25 dark:text-amber-200'
    : tone === 'good' ? 'bg-emerald-500/10 text-emerald-900 ring-emerald-500/25 dark:text-emerald-200'
      : 'bg-brand/10 text-ink ring-brand/25';
  return (
    <div data-testid={testId} className={`flex gap-2 rounded-[20px] p-3 text-sm ring-1 ${c}`}>
      <Info size={16} className="mt-0.5 shrink-0 opacity-70" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Bottom sheet on phones, side panel on wider screens. Escape or the backdrop closes it. */
export function Drawer({ open, title, onClose, children, testId }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end sm:items-stretch" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="bottom-safe relative flex max-h-[88vh] w-full flex-col rounded-t-[32px] bg-surface shadow-2xl ring-1 ring-white/10 sm:max-h-none sm:w-[30rem] sm:rounded-none sm:rounded-l-[32px]">
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div className="flex items-center justify-between px-5 pt-3 pb-2">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close panel" className="grid h-11 w-11 place-items-center rounded-full bg-white/7 text-ink hover:bg-white/12"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto px-5 pb-6">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block text-sm">
      <span className="font-semibold text-ink">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass = 'block w-full min-h-12 rounded-2xl border-0 bg-white/6 px-4 py-2 text-base text-ink ring-1 ring-inset ring-white/10 placeholder:text-muted focus:bg-white/9 focus:ring-2 focus:ring-focus sm:text-sm';

/** Wide data (ownership, request logs): scrolls sideways inside its card, never the page. */
export function Table({ children, testId }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
      <table data-testid={testId} className="tabular min-w-full text-left text-sm">{children}</table>
    </div>
  );
}

export const Th = ({ children, className = '' }) => <th className={`whitespace-nowrap py-2 pr-3 text-xs font-semibold uppercase tracking-wide text-muted ${className}`}>{children}</th>;

/** Segmented control: two or three mutually exclusive choices. */
export function Segmented({ label, options, value, onChange, testIdPrefix }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full bg-white/6 p-1 ring-1 ring-inset ring-white/10">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          data-testid={testIdPrefix ? `${testIdPrefix}-${v}` : undefined}
          onClick={() => onChange(v)}
          className={`min-h-10 rounded-full px-4 text-sm font-bold transition ${value === v ? 'bg-brand text-brand-ink shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Two-letter avatar from a team name, coloured deterministically by entry id. */
export function Avatar({ name, id, size = 36 }) {
  const initials = (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const hue = ((Number(id) || 0) * 47) % 360;
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-full font-display text-xs font-extrabold text-white ring-1 ring-white/15" style={{ width: size, height: size, background: `hsl(${hue} 42% 32%)` }}>
      {initials}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="rounded-[28px] border border-dashed border-white/15 bg-white/3 px-6 py-10 text-center">
      {Icon && <Icon className="mx-auto text-muted" size={28} aria-hidden="true" />}
      <p className="mt-3 font-semibold">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
