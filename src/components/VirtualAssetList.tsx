import React from 'react';
import { FileText } from 'lucide-react';
import type { Asset } from '../types';
import { cn, formatBytes } from '../lib/utils';
import { ThumbnailImage } from './ThumbnailImage';
import { calculateVirtualRange } from './virtualRange';

interface Props {
  assets: Asset[];
  selectedIds: Set<string>;
  loading: boolean;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
  onToggleSelection: (id: string, multi: boolean) => void;
  onContextMenu: (event: React.MouseEvent, id: string) => void;
  onPreview?: (asset: Asset) => void;
}

export function VirtualAssetList({ assets, selectedIds, loading, hasNextPage, onLoadNextPage, onToggleSelection, onContextMenu, onPreview }: Props) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = React.useState({ height: 600, scrollTop: 0 });
  const rowHeight = 52;
  const range = calculateVirtualRange({
    itemCount: assets.length,
    columnCount: 1,
    rowHeight,
    viewportHeight: geometry.height,
    scrollOffset: geometry.scrollTop,
    overscanRows: 4,
  });

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setGeometry(current => ({ ...current, height: element.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (hasNextPage && !loading && range.endIndex >= Math.max(0, assets.length - 10)) onLoadNextPage();
  }, [assets.length, hasNextPage, loading, onLoadNextPage, range.endIndex]);

  return (
    <div
      ref={viewportRef}
      className="h-full overflow-y-auto custom-scrollbar"
      onScroll={event => setGeometry(current => ({ ...current, scrollTop: event.currentTarget.scrollTop }))}
    >
      <div className="relative" style={{ height: range.totalRows * rowHeight }}>
        {assets.slice(range.startIndex, range.endIndex).map((asset, offset) => {
          const index = range.startIndex + offset;
          const selected = selectedIds.has(asset.id);
          return (
            <div
              key={asset.id}
              style={{ position: 'absolute', top: index * rowHeight + 2, left: 8, right: 8, height: rowHeight - 4 }}
              onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, event.ctrlKey || event.metaKey); }}
              onContextMenu={event => onContextMenu(event, asset.id)}
              onDoubleClick={() => onPreview?.(asset)}
              className={cn('flex items-center gap-3 rounded-md border px-3 cursor-pointer', selected ? 'bg-blue-500/10 border-blue-500/40' : 'border-transparent hover:bg-white/5')}
            >
              <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-black flex items-center justify-center">
                <ThumbnailImage asset={asset} className="w-full h-full object-contain" fallbackIcon={<FileText size={18} className="text-neutral-500" />} />
              </div>
              <span className="min-w-0 flex-1 truncate text-sm" title={asset.name}>{asset.name}</span>
              <span className="w-24 shrink-0 text-right text-xs text-neutral-500">{formatBytes(asset.size)}</span>
              <span className="w-24 shrink-0 text-right text-xs text-neutral-500">{asset.dateModified.slice(0, 10)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
