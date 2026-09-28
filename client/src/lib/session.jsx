import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints, ApiError } from './api.js';

// Who is looking: { role: 'admin' } | { role: 'viewer', groupId } | { role: 'anonymous' }.
const SessionContext = createContext({ role: 'anonymous', loading: true });

export function SessionProvider({ children }) {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await endpoints.me()).principal;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return { role: 'anonymous' };
        throw err;
      }
    },
    staleTime: 60_000,
  });
  const value = me.data ? { ...me.data, loading: false } : { role: 'anonymous', loading: me.isLoading, error: me.error };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
