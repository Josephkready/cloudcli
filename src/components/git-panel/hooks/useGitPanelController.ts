import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { recordFeatureUse } from '../../../utils/featureUsage';
import { DEFAULT_BRANCH, RECENT_COMMITS_LIMIT } from '../constants/constants';
import type {
  GitApiErrorResponse,
  GitBranchesResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffMap,
  GitDiffResponse,
  GitFileWithDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
  GitPanelController,
  GitRemoteStatus,
  GitStatusResponse,
  UseGitPanelControllerOptions,
} from '../types/types';
import { getAllChangedFiles } from '../utils/gitPanelUtils';
import { useSelectedProvider } from './useSelectedProvider';

// ! use authenticatedFetch directly. fetchWithAuth is redundant 
const fetchWithAuth = authenticatedFetch as (url: string, options?: RequestInit) => Promise<Response>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  return data;
}

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Tracks the DB projectId so async requests can detect stale responses when
  // the user switches projects mid-flight.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);
  const selectedProjectGenerationRef = useRef(0);
  const selectedProjectId = selectedProject?.projectId ?? null;
  if (selectedProjectIdRef.current !== selectedProjectId) {
    selectedProjectIdRef.current = selectedProjectId;
    selectedProjectGenerationRef.current += 1;
  }
  const selectedProjectGeneration = selectedProjectGenerationRef.current;

  const isCurrentProject = useCallback(
    (projectId: string, signal?: AbortSignal) => (
      !signal?.aborted
      && selectedProjectIdRef.current === projectId
      && selectedProjectGenerationRef.current === selectedProjectGeneration
    ),
    [selectedProjectGeneration],
  );

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }
      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth(
          `/api/git/diff?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(filePath)}`,
          { signal },
        );
        const data = await readJson<GitDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          !isCurrentProject(projectId, signal)
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [isCurrentProject, selectedProject],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;

    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/git/status?project=${encodeURIComponent(projectId)}`, { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (
        signal?.aborted ||
        !isCurrentProject(projectId, signal)
      ) {
        return;
      }

      if (data.error) {
        console.error('Git status error:', data.error);
        setGitStatus({ error: data.error, details: data.details });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        !isCurrentProject(projectId, signal)
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      if (isCurrentProject(projectId, signal)) {
        setIsLoading(false);
      }
    }
  }, [fetchFileDiff, isCurrentProject, selectedProject]);

  const fetchBranches = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;

    try {
      const response = await fetchWithAuth(`/api/git/branches?project=${encodeURIComponent(projectId)}`, { signal });
      const data = await readJson<GitBranchesResponse>(response, signal);

      if (!isCurrentProject(projectId, signal)) {
        return;
      }

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || !isCurrentProject(projectId)) {
        return;
      }
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [isCurrentProject, selectedProject]);

  const fetchRemoteStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;

    try {
      const response = await fetchWithAuth(`/api/git/remote-status?project=${encodeURIComponent(projectId)}`, { signal });
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response, signal);

      if (!isCurrentProject(projectId, signal)) {
        return;
      }

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || !isCurrentProject(projectId)) {
        return;
      }
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [isCurrentProject, selectedProject]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.branch_switch');

      try {
        const response = await fetchWithAuth('/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            branch: branchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, isCurrentProject, selectedProject],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.branch_create');

      setIsCreatingBranch(true);
      try {
        const response = await fetchWithAuth('/api/git/create-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            branch: trimmedBranchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        console.error('Error creating branch:', error);
        return false;
      } finally {
        if (isCurrentProject(projectId)) {
          setIsCreatingBranch(false);
        }
      }
    },
    [fetchBranches, fetchGitStatus, isCurrentProject, selectedProject],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: projectId, branch: branchName }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, isCurrentProject, selectedProject],
  );

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;

    setIsFetching(true);
    try {
      const response = await fetchWithAuth('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (!isCurrentProject(projectId)) {
        return;
      }
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      if (!isCurrentProject(projectId)) {
        return;
      }
      setOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      if (isCurrentProject(projectId)) {
        setIsFetching(false);
      }
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;

    setIsPulling(true);
    try {
      const response = await fetchWithAuth('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (!isCurrentProject(projectId)) {
        return;
      }
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      if (!isCurrentProject(projectId)) {
        return;
      }
      setOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      if (isCurrentProject(projectId)) {
        setIsPulling(false);
      }
    }
  }, [fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;

    setIsPushing(true);
    try {
      const response = await fetchWithAuth('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (!isCurrentProject(projectId)) {
        return;
      }
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Push failed');
    } catch (error) {
      if (!isCurrentProject(projectId)) {
        return;
      }
      setOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      if (isCurrentProject(projectId)) {
        setIsPushing(false);
      }
    }
  }, [fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;

    setIsPublishing(true);
    try {
      const response = await fetchWithAuth('/api/git/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
          branch: currentBranch,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (!isCurrentProject(projectId)) {
        return;
      }
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      console.error('Publish failed:', data.error);
    } catch (error) {
      if (!isCurrentProject(projectId)) {
        return;
      }
      console.error('Error publishing branch:', error);
    } finally {
      if (isCurrentProject(projectId)) {
        setIsPublishing(false);
      }
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.discard');

      try {
        const response = await fetchWithAuth('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return;
        }
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return;
        }
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, isCurrentProject, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth('/api/git/delete-untracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return;
        }
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return;
        }
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, isCurrentProject, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.stage');

      try {
        const response = await fetchWithAuth('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return isCurrentProject(projectId);
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, isCurrentProject, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth('/api/git/unstage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return isCurrentProject(projectId);
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, isCurrentProject, selectedProject],
  );

  const fetchRecentCommits = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;

    try {
      const response = await fetchWithAuth(
        `/api/git/commits?project=${encodeURIComponent(projectId)}&limit=${RECENT_COMMITS_LIMIT}`,
        { signal },
      );
      const data = await readJson<GitCommitsResponse>(response, signal);

      if (!isCurrentProject(projectId, signal)) {
        return;
      }

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || !isCurrentProject(projectId)) {
        return;
      }
      console.error('Error fetching commits:', error);
    }
  }, [isCurrentProject, selectedProject]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth(
          `/api/git/commit-diff?project=${encodeURIComponent(projectId)}&commit=${commitHash}`,
        );
        const data = await readJson<GitDiffResponse>(response);

        if (!isCurrentProject(projectId)) {
          return;
        }

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return;
        }
        console.error('Error fetching commit diff:', error);
      }
    },
    [isCurrentProject, selectedProject],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.ai_commit_message');

      try {
        const response = await authenticatedFetch('/api/git/generate-commit-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            files,
            provider,
          }),
        });

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (!isCurrentProject(projectId)) {
          return null;
        }
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return null;
        }
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [isCurrentProject, provider, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }
      const projectId = selectedProject.projectId;

      recordFeatureUse('git.commit');

      try {
        const response = await fetchWithAuth('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: projectId,
            message,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!isCurrentProject(projectId)) {
          return false;
        }
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return false;
        }
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('No project selected');
    }
    const projectId = selectedProject.projectId;

    setIsCreatingInitialCommit(true);
    try {
      const response = await fetchWithAuth('/api/git/initial-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (!isCurrentProject(projectId)) {
        return false;
      }
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      if (!isCurrentProject(projectId)) {
        return false;
      }
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      if (isCurrentProject(projectId)) {
        setIsCreatingInitialCommit(false);
      }
    }
  }, [fetchGitStatus, fetchRemoteStatus, isCurrentProject, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth(
          `/api/git/file-with-diff?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(filePath)}`,
        );
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (!isCurrentProject(projectId)) {
          return;
        }

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(filePath);
          return;
        }

        onFileOpen(filePath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        if (!isCurrentProject(projectId)) {
          return;
        }
        console.error('Error opening file:', error);
        onFileOpen(filePath);
      }
    },
    [isCurrentProject, onFileOpen, selectedProject],
  );

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setIsCreatingBranch(false);
    setIsFetching(false);
    setIsPulling(false);
    setIsPushing(false);
    setIsPublishing(false);
    setIsCreatingInitialCommit(false);
    setOperationError(null);

    if (!selectedProject) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    void fetchBranches(controller.signal);
    void fetchRemoteStatus(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }
    const controller = new AbortController();
    void fetchRecentCommits(controller.signal);
    return () => {
      controller.abort();
    };
  }, [activeView, fetchRecentCommits, selectedProject]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    openFile,
  };
}
