/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 *
 * `import.meta.env` is injected by Vite at build time; guard against it being
 * absent so importing these constants doesn't crash in non-Vite runtimes such
 * as unit tests (`tsx --test`) or any server-side render of a shared component.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Auth Disabled
 * When 'true', the app skips the login/setup screens and runs as the single
 * default user. Unlike IS_PLATFORM, it does not alter workspace paths, the
 * WebSocket URL, or any other platform behavior — it only removes login.
 */
export const AUTH_DISABLED = import.meta.env?.VITE_AUTH_DISABLED === 'true';

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};