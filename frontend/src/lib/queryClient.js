import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep parity with the old "loadAllData on every page nav" pattern, but smarter:
      // refetch on window focus (catches stale data after coming back to a tab),
      // 30s stale time so rapid page switches reuse cached data.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1
    }
  }
});
