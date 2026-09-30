import { Crown } from 'lucide-react';
import { Avatar } from './ui.jsx';

// Overall top 3 as a podium: 2nd · 1st · 3rd. Ties share a step's rank.
const STEP = {
  1: 'h-24 bg-gradient-to-b from-[#f5b84a]/45 to-[#f5b84a]/5 text-[#f5cf85] ring-[#f5b84a]/45',
  2: 'h-16 bg-gradient-to-b from-[#cfe3dd]/30 to-[#cfe3dd]/5 text-[#e4efec] ring-[#cfe3dd]/30',
  3: 'h-12 bg-gradient-to-b from-[#e58a2f]/40 to-[#e58a2f]/5 text-[#f2b27a] ring-[#e58a2f]/40',
};

export function Podium({ podium, testId }) {
  if (!podium?.length) return null;
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  return (
    <div className="grid grid-cols-3 items-end gap-2" data-testid={testId}>
      {order.map((p) => (
        <div key={p.entryId} className="flex min-w-0 flex-col items-center text-center" data-testid={testId ? `${testId}-${p.rank}` : undefined}>
          {p.rank === 1 && <Crown size={18} className="mb-1 text-[#f5b84a]" aria-hidden="true" />}
          <Avatar name={p.teamName} id={p.entryId} size={p.rank === 1 ? 48 : 40} />
          <p className="mt-1 w-full truncate text-sm font-bold">{p.teamName}</p>
          <p className="w-full truncate text-xs text-muted">{p.playerName}</p>
          <p className="font-display text-base font-extrabold tabular">{p.total}</p>
          <div className={`mt-1 grid w-full place-items-center rounded-t-2xl font-display text-xl font-extrabold ring-1 ring-inset ${STEP[p.rank] ?? STEP[3]}`}>{p.rank}</div>
        </div>
      ))}
    </div>
  );
}
