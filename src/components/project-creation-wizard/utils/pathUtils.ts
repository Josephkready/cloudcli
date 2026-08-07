const SSH_PREFIXES = ['git@', 'ssh://'];

export const isSshGitUrl = (url: string): boolean => {
  const trimmedUrl = url.trim();
  return SSH_PREFIXES.some((prefix) => trimmedUrl.startsWith(prefix));
};

export const shouldShowGithubAuthentication = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0 && !isSshGitUrl(githubUrl);

export const isCloneWorkflow = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0;

export const getSuggestionRootPath = (inputPath: string): string => {
  const trimmedPath = inputPath.trim();
  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(trimmedPath)) {
    return `${trimmedPath.slice(0, 2)}\\`;
  }

  return lastSeparatorIndex > 0 ? trimmedPath.slice(0, lastSeparatorIndex) : '~';
};

export const joinFolderPath = (basePath: string, folderName: string): string => {
  const normalizedBasePath = basePath.trim().replace(/[\\/]+$/, '');
  const separator =
    normalizedBasePath.includes('\\') && !normalizedBasePath.includes('/') ? '\\' : '/';
  return `${normalizedBasePath}${separator}${folderName.trim()}`;
};
