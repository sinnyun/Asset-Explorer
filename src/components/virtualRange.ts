export interface VirtualRangeInput {
  itemCount: number;
  columnCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollOffset: number;
  overscanRows?: number;
}

export interface VirtualRange {
  startRow: number;
  endRow: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
}

export function calculateVirtualRange(input: VirtualRangeInput): VirtualRange {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const columnCount = Math.max(1, Math.floor(input.columnCount));
  const rowHeight = Math.max(1, input.rowHeight);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscanRows ?? 2));
  const totalRows = Math.ceil(itemCount / columnCount);

  if (totalRows === 0) {
    return { startRow: 0, endRow: 0, startIndex: 0, endIndex: 0, totalRows: 0 };
  }

  const firstVisible = Math.min(totalRows - 1, Math.max(0, Math.floor(input.scrollOffset / rowHeight)));
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const startRow = Math.max(0, firstVisible - overscan);
  const endRow = Math.min(totalRows, firstVisible + visibleRows + overscan);
  return {
    startRow,
    endRow,
    startIndex: startRow * columnCount,
    endIndex: Math.min(itemCount, endRow * columnCount),
    totalRows,
  };
}
