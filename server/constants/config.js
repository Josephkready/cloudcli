/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Auth Disabled
 * When 'true', the app skips all login/JWT checks and resolves every request to
 * the single default user (see initializeDatabase seeding). Intended for
 * self-hosted single-user installs where a login screen adds no security.
 * Unlike IS_PLATFORM this flag ONLY disables auth — it does not change the
 * workspace path, WebSocket URL, or any other platform behavior.
 */
export const AUTH_DISABLED = process.env.VITE_AUTH_DISABLED === 'true';