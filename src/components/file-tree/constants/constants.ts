import type { FileTreeViewMode } from '../types/types';

export const FILE_TREE_VIEW_MODE_STORAGE_KEY = 'file-tree-view-mode';

export const FILE_TREE_DEFAULT_VIEW_MODE: FileTreeViewMode = 'detailed';

export const FILE_TREE_VIEW_MODES: FileTreeViewMode[] = ['simple', 'compact', 'detailed'];

/**
 * Column template for the `detailed` view (#245).
 *
 * This used to be a plain `grid-cols-12` split 5/2/3/2. Because those are equal
 * fractions of the pane, NAME was capped at ~42% of the width no matter how
 * wide the pane got, while SIZE / MODIFIED / PERMISSIONS each kept hundreds of
 * unused pixels — so long filenames truncated well before the pane ran out of
 * room. The metadata columns hold bounded strings ("1.2 MB", "29 days ago" or a
 * locale date, "rwxrwxrwx"), so they get fixed widths and NAME takes whatever is
 * left. `minmax(0, 1fr)` — not plain `1fr` — is what lets the name cell shrink
 * below its content width so the `truncate` inside it still applies.
 *
 * The header (`FileTreeDetailedColumns`) and the rows (`FileTreeNode`) must use
 * the same template or the columns stop lining up, hence the shared constant.
 */
export const FILE_TREE_DETAILED_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)_5rem_7rem_6rem] gap-2';

const MAX_FILE_UPLOAD_SIZE_MB = 200;

export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

export const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_FILE_UPLOAD_SIZE_MB}MB`;

export const MAX_FILE_UPLOAD_COUNT = 20;

export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);
