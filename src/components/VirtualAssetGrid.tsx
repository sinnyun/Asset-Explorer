import React from 'react';
import { Box, FileText, Image as ImageIcon, Video } from 'lucide-react';
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

function fallbackIcon(type: string) {
  if (type === 'image') return <ImageIcon size={28} className="text-blue-400" />;
  if (type === 'video') return <Video size={28} className="text-purple-400" />;
  if (type === 'model' || type === '3d') return <Box size={28} className="text-amber-400" />;
  return <FileText size={28} className="text-neutral-500" />;
}

export function VirtualAssetGrid({ assets, selectedIds, loading, hasNextPage, onLoadNextPage, onToggleSelection, onContextMenu, onPreview }: Props) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = React.useState({ width: 900, height: 600, scrollTop: 0 });
  const gap = 16;
  const columns = Math.max(1, Math.floor((viewport.width + gap) / (180 + gap)));
  const cellWidth = viewport.width / columns;
  const rowHeight = Math.max(238, cellWidth + 86);
  const range = calculateVirtualRange({
    itemCount: assets.length,
    columnCount: columns,
    rowHeight,
    viewportHeight: viewport.height,
    scrollOffset: viewport.scrollTop,
    overscanRows: 4,
  });

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewport(current => ({ ...current, width: element.clientWidth, height: element.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (hasNextPage && !loading && range.endIndex >= Math.max(0, assets.length - columns * 2)) onLoadNextPage();
  }, [assets.length, columns, hasNextPage, loading, onLoadNextPage, range.endIndex]);

  return (
    <div
      ref={viewportRef}
      className="h-full overflow-y-auto custom-scrollbar"
      onScroll={event => setViewport(current => ({ ...current, scrollTop: event.currentTarget.scrollTop }))}
    >
      <div className="relative" style={{ height: range.totalRows * rowHeight }}>
        {assets.slice(range.startIndex, range.endIndex).map((asset, offset) => {
          const index = range.startIndex + offset;
          const row = Math.floor(index / columns);
          const column = index % columns;
          const selected = selectedIds.has(asset.id);
          return (
            <div
              key={asset.id}
              style={{
                position: 'absolute',
                top: row * rowHeight + 8,
                left: column * cellWidth + 8,
                width: Math.max(1, cellWidth - gap),
                height: rowHeight - gap,
              }}
              onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, event.ctrlKey || event.metaKey); }}
              onContextMenu={event => onContextMenu(event, asset.id)}
              onDoubleClick={() => onPreview?.(asset)}
              className={cn(
                'group overflow-hidden rounded-lg border bg-[#1e1e1e] cursor-pointer transition-colors',
                selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-800 hover:border-neutral-600',
              )}
            >
              <div className="relative bg-black" style={{ height: rowHeight - 96 }}>
                <ThumbnailImage asset={asset} className="w-full h-full object-contain" fallbackIcon={fallbackIcon(asset.type)} />
                <span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] uppercase">{asset.type}</span>
              </div>
              <div className="h-20 p-2.5 flex flex-col justify-between">
                <div className="truncate text-sm font-medium" title={asset.name}>{asset.name}</div>
                <div className="flex justify-between border-t border-neutral-800 pt-1 text-[11px] text-neutral-500">
                  <span>{formatBytes(asset.size)}</span><span>{asset.dateModified.slice(0, 10)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
