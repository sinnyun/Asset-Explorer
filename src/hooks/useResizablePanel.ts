import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampPanelWidth } from '../services/panelLayout';

export type ResizeDirection = 'left' | 'right';

export function calculateResizeWidth(
  direction: ResizeDirection,
  startWidth: number,
  startPointerX: number,
  currentPointerX: number,
  minWidth: number,
  maxWidth: number,
): number {
  const delta = direction === 'left'
    ? currentPointerX - startPointerX
    : startPointerX - currentPointerX;
  return clampPanelWidth(startWidth + delta, minWidth, maxWidth);
}

interface UseResizablePanelOptions {
  direction: ResizeDirection;
  width: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
  onResizeEnd?: () => void;
}

export function useResizablePanel({
  direction,
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  onResizeEnd,
}: UseResizablePanelOptions) {
  const dragRef = useRef<{ startWidth: number; startPointerX: number } | null>(null);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    onWidthChange(calculateResizeWidth(
      direction,
      drag.startWidth,
      drag.startPointerX,
      event.clientX,
      minWidth,
      maxWidth,
    ));
  }, [direction, maxWidth, minWidth, onWidthChange]);

  const stopDragging = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.classList.remove('is-resizing-panel');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
    onResizeEnd?.();
  }, [onPointerMove, onResizeEnd]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startWidth: width, startPointerX: event.clientX };
    document.body.classList.add('is-resizing-panel');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
  }, [onPointerMove, stopDragging, width]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
    document.body.classList.remove('is-resizing-panel');
  }, [onPointerMove, stopDragging]);

  return { onPointerDown };
}
