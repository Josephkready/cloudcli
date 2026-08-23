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

export function validateGitHubCloneUrl(value) {
  const cloneUrl = typeof value === 'string' ? value.trim() : '';
  if (/^git@github\.com:[^/\s]+\/[^/\s]+\/?$/.test(cloneUrl)) {
    return cloneUrl;
  }

  let parsed;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new Error('Invalid GitHub URL');
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || pathParts.length !== 2
  ) {
    throw new Error('Invalid GitHub URL');
  }
  return cloneUrl;
}

export function redactGitHubUrlCredentials(value) {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value;
  }
}
