export type WizardStep = 1 | 2;

export type TokenMode = 'stored' | 'new' | 'none';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
  /**
   * True when the folder is a git repository root. Only present when the browse
   * request opted into repository flags (`?repoFlags=1`); absent means "not
   * asked", not "not a repo".
   */
  isRepository?: boolean;
};

export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

export type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  /** True when `path` is the configured WORKSPACES_ROOT — i.e. it has no navigable parent. */
  isAtRoot?: boolean;
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type CreateProjectPayload = {
  path: string;
  customName?: string;
};

export type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

export type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};
