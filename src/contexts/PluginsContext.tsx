import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { authenticatedFetch } from '../utils/api';

export type Plugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  type: 'react' | 'module';
  slot: 'tab';
  entry: string;
  server: string | null;
  permissions: string[];
  enabled: boolean;
  serverRunning: boolean;
  dirName: string;
  repoUrl: string | null;
};

type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
};

const PluginsContext = createContext<PluginsContextValue | null>(null);

export function usePlugins() {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error('usePlugins must be used within a PluginsProvider');
  }
  return context;
}

export function PluginsProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const refreshPlugins = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/plugins');
      if (res.ok) {
        const data = await res.json();
        setPlugins(data.plugins || []);
        setPluginsError(null);
      } else {
        let errorMessage = `Failed to fetch plugins (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          errorMessage = res.statusText || errorMessage;
        }
        setPluginsError(errorMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      setPluginsError(message);
      console.error('[Plugins] Failed to fetch plugins:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  return (
    <PluginsContext.Provider value={{ plugins, loading, pluginsError, refreshPlugins }}>
      {children}
    </PluginsContext.Provider>
  );
}
