/**
 * Classifies how a persisted session entered CloudCLI.
 *
 * Provider transcripts discovered on disk use the provider-native id as the
 * app-facing id too. Sessions created in CloudCLI receive a distinct app id
 * (or have no provider id until the runtime announces one).
 */
export function deriveSessionOrigin(
  sessionId: string,
  providerSessionId: string | null | undefined,
): 'cli' | 'cloudcli' {
  return providerSessionId === sessionId ? 'cli' : 'cloudcli';
}
