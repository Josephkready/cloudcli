/**
 * Supplies a GitHub token to git for one process only. The remote URL stays
 * credential-free in both process arguments and the cloned repository config.
 */
export function buildGitHubCloneEnvironment(githubToken = null, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment, GIT_TERMINAL_PROMPT: '0' };
  if (!githubToken) {
    return environment;
  }

  const basicCredential = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  return {
    ...environment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicCredential}`,
  };
}
