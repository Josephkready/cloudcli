import React from 'react';

interface FileListContentProps {
  files: string[];
  title?: string;
}

/**
 * Renders a compact comma-separated list of file names (full path on hover)
 * Used by: Grep/Glob results
 */
export const FileListContent: React.FC<FileListContentProps> = ({
  files,
  title
}) => {
  return (
    <div>
      {title && (
        <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">
          {title}
        </div>
      )}
      <div className="flex max-h-48 flex-wrap gap-x-1 gap-y-0.5 overflow-y-auto">
        {files.map((filePath, index) => {
          const fileName = filePath.split('/').pop() || filePath;

          return (
            <span key={index} className="inline-flex items-center">
              <span className="font-mono text-[11px] text-foreground" title={filePath}>
                {fileName}
              </span>
              {index < files.length - 1 && (
                <span className="ml-1 text-[10px] text-gray-300 dark:text-gray-600">,</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
