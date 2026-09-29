import { Crown } from 'lucide-react';
import { Avatar } from './ui.jsx';

// Overall top 3 as a podium: 2nd · 1st · 3rd. Ties share a step's rank.
const STEP = { 1: 'h-24 bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950', 2: 'h-16 bg-gradient-to-b from-slate-200 to-slate-400 text-slate-800', 3: 'h-12 bg-gradient-to-b from-orange-300 to-orange-500 text-orange-950' };

export function Podium({ podium, testId }) {
  if (!podium?.length) return null;
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  return (
    <div className="grid grid-cols-3 items-end gap-2" data-testid={testId}>
      {order.map((p) => (
        <div key={p.entryId} className="flex min-w-0 flex-col items-center text-center" data-testid={testId ? `${testId}-${p.rank}` : undefined}>
          {p.rank === 1 && <Crown size={18} className="mb-1 text-amber-500" aria-hidden="true" />}
          <Avatar name={p.teamName} id={p.entryId} size={p.rank === 1 ? 48 : 40} />
          <p className="mt-1 w-full truncate text-sm font-bold">{p.teamName}</p>
          <p className="w-full truncate text-xs text-muted">{p.playerName}</p>
          <p className="text-sm font-black tabular">{p.total}</p>
          <div className={`mt-1 grid w-full place-items-center rounded-t-xl text-lg font-black ${STEP[p.rank] ?? STEP[3]}`}>{p.rank}</div>
        </div>
      ))}
    </div>
  );
}
