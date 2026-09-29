import { useState } from 'react';
import { Check, Copy, MessageCircle } from 'lucide-react';
import { Button } from './ui.jsx';

// Copy the ready-made group-chat summary, or open WhatsApp with it prefilled.
export function WhatsAppShare({ text, testId = 'whatsapp' }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={copied ? Check : Copy} onClick={copy} className="bg-emerald-600! text-white!">{copied ? 'Copied' : 'Copy WhatsApp summary'}</Button>
        <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-600/40 hover:bg-emerald-500/10 dark:text-emerald-300"><MessageCircle size={16} aria-hidden="true" />Open WhatsApp</a>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>{open ? 'Hide preview' : 'Preview'}</Button>
      </div>
      {open && <pre className="whitespace-pre-wrap rounded-xl bg-[#e7fbe4] p-3 font-sans text-sm text-[#111b21] ring-1 ring-emerald-600/20 dark:bg-[#1f2c33] dark:text-[#e9edef]" data-testid={`${testId}-text`}>{text}</pre>}
    </div>
  );
}
