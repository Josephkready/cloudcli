// The version-check poll now lives in a single provider so every component reads one
// shared state instead of each mounting its own interval/listener (follow-up to #458).
// This module stays as the stable import path components already use; see
// `src/contexts/VersionCheckContext.tsx` for the implementation and the rationale.
export type { InstallMode, VersionCheckValue } from '../contexts/VersionCheckContext';
export { VersionCheckProvider, useVersionCheck } from '../contexts/VersionCheckContext';