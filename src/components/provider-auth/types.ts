import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'antigravity'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  codex: '/api/providers/codex/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  antigravity: { authenticated: false, email: null, method: null, error: null, loading },
});
