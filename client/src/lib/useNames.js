import { useQuery } from '@tanstack/react-query';
import { endpoints } from './api.js';
import { managerName } from './format.js';

/** Manager names come from the result standings (same cached query as the Results page). */
export function useNames(group, season, gw) {
  const r = useQuery({ queryKey: ['result', group.id, season, gw], queryFn: () => endpoints.result(group.id, gw, season) });
  const standings = r.data?.result?.standings ?? [];
  return (entryId) => managerName(standings, entryId);
}
