import { Fragment, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, FileText, FolderPlus, Pencil, RefreshCw, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useCursorContextMenu } from '../../../shared/view/ui/useCursorContextMenu';

type FileContextItem = {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileContextItem[];
  [key: string]: unknown;
};

type ContextMenuAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  isDanger?: boolean;
  isDisabled?: boolean;
  shortcut?: string;
  showDividerBefore?: boolean;
};

// Narrower than CursorContextMenu's default (220) — preserves the file-tree
// menu's original horizontal flip threshold.
const FILE_CONTEXT_MENU_WIDTH = 200;

export default function FileContextMenu({
  children,
  item,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onRefresh,
  onCopyPath,
  onDownload,
  isLoading = false,
  className = '',
}: {
  children: ReactNode;
  item?: FileContextItem | null;
  onRename?: (item: FileContextItem) => void;
  onDelete?: (item: FileContextItem) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onRefresh?: () => void;
  onCopyPath?: (item: FileContextItem) => void;
  onDownload?: (item: FileContextItem) => void;
  isLoading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { isMenuOpen, menuPosition, menuRef, openContextMenuAtCursor, closeContextMenu } =
    useCursorContextMenu({ menuWidth: FILE_CONTEXT_MENU_WIDTH });

  const runMenuActionAndClose = useCallback((action?: () => void) => {
    closeContextMenu();
    action?.();
  }, [closeContextMenu]);

  const menuActions = useMemo<ContextMenuAction[]>(() => {
    if (item?.type === 'file') {
      return [
        {
          key: 'rename',
          icon: Pencil,
          label: t('fileTree.context.rename', 'Rename'),
          onSelect: () => onRename?.(item),
        },
        {
          key: 'delete',
          icon: Trash2,
          label: t('fileTree.context.delete', 'Delete'),
          onSelect: () => onDelete?.(item),
          isDanger: true,
        },
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'download',
          icon: Download,
          label: t('fileTree.context.download', 'Download'),
          onSelect: () => onDownload?.(item),
        },
      ];
    }

    if (item?.type === 'directory') {
      return [
        {
          key: 'newFile',
          icon: FileText,
          label: t('fileTree.context.newFile', 'New File'),
          onSelect: () => onNewFile?.(item.path),
        },
        {
          key: 'newFolder',
          icon: FolderPlus,
          label: t('fileTree.context.newFolder', 'New Folder'),
          onSelect: () => onNewFolder?.(item.path),
        },
        {
          key: 'rename',
          icon: Pencil,
          label: t('fileTree.context.rename', 'Rename'),
          onSelect: () => onRename?.(item),
          showDividerBefore: true,
        },
        {
          key: 'delete',
          icon: Trash2,
          label: t('fileTree.context.delete', 'Delete'),
          onSelect: () => onDelete?.(item),
          isDanger: true,
        },
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'download',
          icon: Download,
          label: t('fileTree.context.download', 'Download'),
          onSelect: () => onDownload?.(item),
        },
      ];
    }

    return [
      {
        key: 'newFile',
        icon: FileText,
        label: t('fileTree.context.newFile', 'New File'),
        onSelect: () => onNewFile?.(''),
      },
      {
        key: 'newFolder',
        icon: FolderPlus,
        label: t('fileTree.context.newFolder', 'New Folder'),
        onSelect: () => onNewFolder?.(''),
      },
      {
        key: 'refresh',
        icon: RefreshCw,
        label: t('fileTree.context.refresh', 'Refresh'),
        onSelect: onRefresh,
        showDividerBefore: true,
      },
    ];
  }, [item, onCopyPath, onDelete, onDownload, onNewFile, onNewFolder, onRefresh, onRename, t]);

  return (
    <>
      <div onContextMenu={openContextMenuAtCursor} className={cn('contents', className)}>
        {children}
      </div>

      {isMenuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('fileTree.context.menuLabel', 'File context menu')}
          style={{ position: 'fixed', left: menuPosition.x, top: menuPosition.y, zIndex: 9999 }}
          className={cn(
            'min-w-[180px] py-1 px-1',
            'bg-popover border border-border rounded-lg shadow-lg',
            'animate-in fade-in-0 zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">{t('fileTree.context.loading', 'Loading...')}</span>
            </div>
          ) : (
            menuActions.map((action) => (
              <Fragment key={action.key}>
                {action.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
                <button
                  role="menuitem"
                  tabIndex={action.isDisabled ? -1 : 0}
                  disabled={isLoading || action.isDisabled}
                  onClick={() => runMenuActionAndClose(action.onSelect)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm text-left rounded-md transition-colors',
                    'focus:outline-none focus:bg-accent',
                    action.isDisabled
                      ? 'opacity-50 cursor-not-allowed'
                      : action.isDanger
                      ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950'
                      : 'hover:bg-accent',
                    isLoading && 'pointer-events-none',
                  )}
                >
                  {action.icon && <action.icon className="h-4 w-4 flex-shrink-0" />}
                  <span className="flex-1">{action.label}</span>
                  {action.shortcut && <span className="font-mono text-xs text-muted-foreground">{action.shortcut}</span>}
                </button>
              </Fragment>
            ))
          )}
        </div>
      )}
    </>
  );
}
