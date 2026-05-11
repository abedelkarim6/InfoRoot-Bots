import { createContext, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const ConfigContext = createContext(null);

/**
 * Mirrors the legacy `loadAllData()` pattern but in TanStack Query terms:
 *   - /api/config  → globalConfig (system flags, bots, collections)
 *   - /api/prompts → globalPrompts ({summaries: {...}, youtube: {...}} — global)
 *
 * Both are cached with the default 30s staleTime; mutations should invalidate
 * `['config']` and/or `['prompts']` instead of refetching manually.
 */
export function ConfigProvider({ children }) {
  const qc = useQueryClient();

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api('/api/config')
  });

  const prompts = useQuery({
    queryKey: ['prompts'],
    queryFn: () => api('/api/prompts')
  });

  const value = {
    config: config.data,
    prompts: prompts.data,
    isLoading: config.isLoading || prompts.isLoading,
    isError: config.isError || prompts.isError,
    refetchAll: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['prompts'] });
    }
  };

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useGlobalConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useGlobalConfig must be used inside <ConfigProvider>');
  return ctx;
}
