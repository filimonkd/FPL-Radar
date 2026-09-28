import { useEffect } from 'react';
import { statusTone, explain } from '../lib/format.js';

const TONES = {
  good: 'bg-green-100 text-green-800 ring-green-200',
  warn: 'bg-amber-100 text-amber-900 ring-amber-200',
  bad: 'bg-red-100 text-red-800 ring-red-200',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-sky-100 text-sky-800 ring-sky-200',
};

export function Badge({ tone, status, children, title, testId }) {
  const t = tone ?? statusTone(status ?? children);
  return (
    <span title={title} data-testid={testId} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[t] ?? TONES.neutral}`}>
      {children ?? status}
    </span>
  );
}

export function Button({ variant = 'primary', className = '', ...props }) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300',
    secondary: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300',
    ghost: 'text-indigo-700 hover:bg-indigo-50 disabled:text-slate-400',
  };
  return <button type="button" className={`inline-flex min-h-10 items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed ${styles[variant]} ${className}`} {...props} />;
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return <p role="status" className="py-6 text-center text-sm text-slate-500">{label}</p>;
}

/** An API error as the server reported it: code, message and any reasons. */
export function ErrorBox({ error, title = 'Something went wrong' }) {
  if (!error) return null;
  const reasons = error.details?.reasons;
  return (
    <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
      <p className="font-medium">{title}{error.code ? ` (${error.code})` : ''}</p>
      <p className="mt-1">{error.message}</p>
      {Array.isArray(reasons) && reasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5">{reasons.map((r) => <li key={r}>{explain(r)}</li>)}</ul>
      )}
    </div>
  );
}

export function Notice({ tone = 'warn', children, testId }) {
  const c = tone === 'warn' ? 'bg-amber-50 text-amber-900 ring-amber-200' : tone === 'good' ? 'bg-green-50 text-green-900 ring-green-200' : 'bg-sky-50 text-sky-900 ring-sky-200';
  return <div data-testid={testId} className={`rounded-md p-3 text-sm ring-1 ${c}`}>{children}</div>;
}

/** Bottom sheet on phones, side drawer on wider screens. Escape or the backdrop closes it. */
export function Drawer({ open, title, onClose, children, testId }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-end sm:items-stretch" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative max-h-[85vh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-h-none sm:w-[28rem] sm:rounded-none">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-800">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass = 'block w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-600';

/** Horizontally scrollable table wrapper for phones. */
export function Table({ children, testId }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table data-testid={testId} className="min-w-full text-left text-sm">{children}</table>
    </div>
  );
}
