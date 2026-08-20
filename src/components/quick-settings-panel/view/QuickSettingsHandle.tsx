import type {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuickSettingsHandleStyle } from '../types';

/**
 * Deliberately BELOW the mobile sidebar overlay, which is `z-50` (#361).
 *
 * Both used to be `z-50`, and that is not a tie the stacking context resolves in
 * anyone's favour — it falls through to DOM order, and this handle happens to
 * render later. So it floated on top of the sidebar's dimmed backdrop and stayed
 * hit-testable while a modal surface was open. On a phone it sits exactly where
 * a thumb rests on the right edge, which made it a realistic mis-tap into a
 * state neither component is designed for: the settings panel sliding out from
 * under an open sidebar.
 *
 * Dropping a level costs nothing. The handle only has to out-stack the chat
 * surface (`z-10`/`z-20`), and it never overlaps its own panel — when the panel
 * is open the handle sits at `right-64`, immediately left of the panel's
 * `right-0 w-64`, so sharing `z-40` with it is not a collision.
 *
 * The slash-command popover is a portal at `z-index: 1000` and was never at
 * risk; the handle merely shows *beside* it, outside its box.
 */
const STACKING_CLASS = 'z-40';

type QuickSettingsHandleProps = {
  isOpen: boolean;
  isDragging: boolean;
  style: QuickSettingsHandleStyle;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
};

export default function QuickSettingsHandle({
  isOpen,
  isDragging,
  style,
  onClick,
  onMouseDown,
  onTouchStart,
}: QuickSettingsHandleProps) {
  const { t } = useTranslation('settings');

  const placementClass = isOpen ? 'right-64' : 'right-0';
  const borderClass = isDragging
    ? 'border-blue-500 dark:border-blue-400'
    : 'border-gray-200 dark:border-gray-700';
  // While dragging, the handle follows the pointer, so only its colours may
  // animate. Otherwise it slides with the panel: `right` is a layout property,
  // but it is what positions this handle, so the list names it explicitly
  // rather than letting a blanket transition watch every property (#271).
  const transitionClass = isDragging
    ? 'transition-colors duration-fast'
    : 'transition-[right,color,background-color,border-color] duration-base ease-out';
  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-pointer';
  const ariaLabel = isDragging
    ? t('quickSettings.dragHandle.dragging')
    : isOpen
      ? t('quickSettings.dragHandle.closePanel')
      : t('quickSettings.dragHandle.openPanel');
  const title = isDragging
    ? t('quickSettings.dragHandle.draggingStatus')
    : t('quickSettings.dragHandle.toggleAndMove');

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={`fixed ${placementClass} ${STACKING_CLASS} ${transitionClass} border bg-white dark:bg-gray-800 ${borderClass} rounded-l-md p-2 shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 ${cursorClass} touch-none`}
      style={{
        ...style,
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label={ariaLabel}
      title={title}
    >
      {isDragging ? (
        <GripVertical className="h-5 w-5 text-blue-500 dark:text-blue-400" />
      ) : isOpen ? (
        <ChevronRight className="h-5 w-5 text-gray-600 dark:text-gray-400" />
      ) : (
        <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-gray-400" />
      )}
    </button>
  );
}
