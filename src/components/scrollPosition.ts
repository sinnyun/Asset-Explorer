export interface ScrollEventLike {
  currentTarget: { scrollTop: number } | null;
}

export function captureScrollPosition<T extends { scrollTop: number }>(
  setState: (updater: (state: T) => T) => void,
  event: ScrollEventLike,
): void {
  // React may release currentTarget before a functional state updater runs.
  const scrollTop = event.currentTarget?.scrollTop ?? 0;
  setState(state => ({ ...state, scrollTop }));
}
