import type { LLMProvider } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - only the Claude SDK integration surfaces interactive permission requests.
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
};

/**
 * Deployment override for the default permission mode.
 *
 * A trusted single-user install (login off, tailnet/LAN-only, where a spawned
 * agent already inherits full host access — see the "CloudCLI UI — Dante Deploy"
 * design doc) can opt into starting new sessions in a less-prompting mode instead
 * of picking it per session, by setting e.g.
 * `CLOUDCLI_DEFAULT_PERMISSION_MODE=bypassPermissions`.
 *
 * It only changes the *default* the picker starts on — every mode stays available,
 * and the value is ignored for any provider that doesn't list it (so an over-broad
 * value can never produce an invalid default). Read per call rather than at module
 * load so a restart / test picks up the env without a stale cache.
 */
function applyDefaultPermissionModeOverride(caps: ProviderCapabilities): ProviderCapabilities {
  const override = process.env.CLOUDCLI_DEFAULT_PERMISSION_MODE?.trim();
  if (override && override !== caps.defaultPermissionMode && caps.permissionModes.includes(override)) {
    return { ...caps, defaultPermissionMode: override };
  }
  return caps;
}

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return applyDefaultPermissionModeOverride(PROVIDER_CAPABILITIES[provider]);
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES).map(applyDefaultPermissionModeOverride);
  },
};
