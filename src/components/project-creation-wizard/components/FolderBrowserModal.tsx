import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Folder, FolderGit2, FolderOpen, Loader2, Plus, X } from 'lucide-react';
import { Button, Input } from '../../../shared/view/ui';
import { useFocusTrap } from '../../../shared/view/ui/useFocusTrap';
import { useOverlayDismiss } from '../../../shared/view/ui/useOverlayDismiss';
import { browseFilesystemFolders, createFolderInFilesystem } from '../data/workspaceApi';
import { joinFolderPath } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

/**
 * Picks a workspace folder from the configured WORKSPACES_ROOT.
 *
 * The picker is deliberately *flat*: it lists the repositories sitting directly
 * in the workspace root and never descends. Descending is what made it unusable
 * (#309) — every repo opened into its own `src/`, `docs/`, … when the only
 * folders anyone wants here are the repos themselves and the root (the parent a
 * clone lands in). Anything else can still be typed into the workspace path
 * field, which keeps its own autocomplete.
 *
 * Because it never leaves the root, the ".." row #238 was about is gone too:
 * there is no navigation left to offer a click that could only 403.
 */
export default function FolderBrowserModal({
  isOpen,
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const [rootPath, setRootPath] = useState('~');
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  // Repositories are the default listing; this is the escape hatch for the
  // plain folders beside them (a not-yet-initialised project directory, say).
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders('~', { includeRepositoryFlags: true });
      setRootPath(result.path);
      setFolders(result.suggestions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load folders');
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadFolders();
  }, [isOpen, loadFolders]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showAllFolders || folder.isRepository)
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showAllFolders, showHiddenFolders],
  );

  // Only offer the "there is more here" hint when the repo filter is what is
  // holding entries back — hidden folders have their own toggle.
  const nonRepoCount = useMemo(
    () =>
      folders.filter(
        (folder) =>
          !folder.isRepository && (showHiddenFolders || !folder.name.startsWith('.')),
      ).length,
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = useCallback(() => {
    setError(null);
    resetNewFolderState();
    onClose();
  }, [onClose]);

  // While the inline new-folder field is open it owns Escape (cancelling the
  // field), so the picker only claims the key once that field is gone (#243).
  const { backdropProps } = useOverlayDismiss({
    isActive: isOpen && !showNewFolderInput,
    onDismiss: handleClose,
  });

  // The trap stays on for the whole time the picker is open — unlike Esc, the
  // inline new-folder field never wants Tab to leave the dialog (#274).
  const { containerRef } = useFocusTrap<HTMLDivElement>({ isActive: isOpen });

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(rootPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      resetNewFolderState();
      // A folder created here exists to be used, and a brand-new one is never a
      // repository — it would vanish from the default listing if we merely
      // refreshed. Hand it straight back instead.
      onFolderSelected(createdPath, autoAdvanceOnSelect);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }, [autoAdvanceOnSelect, newFolderName, onFolderSelected, rootPath]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 id="folder-browser-title" className="text-lg font-semibold text-gray-900 dark:text-white">
              Select Folder
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAllFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showAllFolders
                  ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                  : 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
              }`}
              title={showAllFolders ? 'Show repositories only' : 'Show all folders'}
            >
              {showAllFolders ? <Folder className="h-5 w-5" /> : <FolderGit2 className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={showHiddenFolders ? 'Hide hidden folders' : 'Show hidden folders'}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title="Create new folder"
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              title="Close folder browser"
              aria-label="Close folder browser"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {showNewFolderInput && (
          <div className="border-b border-gray-200 bg-blue-50 px-4 py-3 dark:border-gray-700 dark:bg-blue-900/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder="New folder name"
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {showAllFolders ? 'No folders found' : 'No repositories found'}
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <button
                    key={folder.path}
                    onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                    className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    {folder.isRepository ? (
                      <FolderGit2 className="h-5 w-5 flex-shrink-0 text-blue-500" />
                    ) : (
                      <Folder className="h-5 w-5 flex-shrink-0 text-gray-400" />
                    )}
                    <span className="truncate font-medium text-gray-900 dark:text-white">
                      {folder.name}
                    </span>
                  </button>
                ))
              )}

              {!showAllFolders && nonRepoCount > 0 && (
                <button
                  onClick={() => setShowAllFolders(true)}
                  className="w-full px-4 py-2 text-left text-xs text-gray-500 underline dark:text-gray-400"
                >
                  Show all folders ({nonRepoCount} more)
                </button>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/50">
            <span className="text-sm text-gray-600 dark:text-gray-400">Workspace root:</span>
            <code className="flex-1 truncate font-mono text-sm text-gray-900 dark:text-white">
              {rootPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => onFolderSelected(rootPath, autoAdvanceOnSelect)}>
              Use this folder
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
