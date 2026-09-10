import React from 'react';
import { Box, ChevronDown, ChevronRight, FileText, Folder as FolderIcon, Image as ImageIcon, Video } from 'lucide-react';
import type { Asset, Folder, SortOption } from '../types';
import type { GroupedAssetItem } from './groupedAssetModel';
import { cn, formatBytes } from '../lib/utils';
import { ThumbnailImage } from './ThumbnailImage';
import { captureScrollPosition } from './scrollPosition';

interface Props {
  items: GroupedAssetItem[];
  viewMode: 'grid' | 'list';
  selectedAssetIds: Set<string>;
  selectedFolderIds: Set<string>;
  loading: boolean;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
  onToggleSelection: (id: string, type: 'asset' | 'folder', multi: boolean) => void;
  onContextMenuAsset: (event: React.MouseEvent, id: string) => void;
  onContextMenuFolder: (event: React.MouseEvent, id: string) => void;
  onPreviewAsset?: (asset: Asset) => void;
  onToggleGroupCollapse: (id: string) => void;
  tagLabels: Map<string, string>;
  collectionLabels: Map<string, string>;
}

type VirtualRow =
  | { kind: 'header'; groupId: string; folder: Folder; assetCount: number }
  | { kind: 'assets'; groupId: string; assets: Asset[] };

function fallbackIcon(type: string) {
  if (type === 'image') return <ImageIcon size={28} className="text-blue-400" />;
  if (type === 'video') return <Video size={28} className="text-purple-400" />;
  if (type === 'model' || type === '3d') return <Box size={28} className="text-amber-400" />;
  return <FileText size={28} className="text-neutral-500" />;
}

export function VirtualGroupedAssetView({
  items, viewMode, selectedAssetIds, selectedFolderIds, loading, hasNextPage, onLoadNextPage,
  onToggleSelection, onContextMenuAsset, onContextMenuFolder, onPreviewAsset, onToggleGroupCollapse,
  tagLabels, collectionLabels,
}: Props) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = React.useState({ width: 900, height: 600, scrollTop: 0 });
  const columns = Math.max(1, Math.floor((viewport.width + 16) / 196));
  const cardHeight = Math.max(238, viewport.width / columns + 86);
  const rows = React.useMemo<VirtualRow[]>(() => {
    const result: VirtualRow[] = [];
    for (const item of items) {
      if (item.kind === 'header') {
        result.push(item);
        continue;
      }
      const previous = result[result.length - 1];
      if (viewMode === 'grid' && previous?.kind === 'assets' && previous.groupId === item.groupId && previous.assets.length < columns) {
        previous.assets.push(item.asset);
      } else {
        result.push({ kind: 'assets', groupId: item.groupId, assets: [item.asset] });
      }
    }
    return result;
  }, [columns, items, viewMode]);
  const heights = React.useMemo(() => rows.map(row => row.kind === 'header' ? 54 : viewMode === 'grid' ? cardHeight : 52), [cardHeight, rows, viewMode]);
  const offsets = React.useMemo(() => {
    const values: number[] = [];
    let offset = 0;
    for (const height of heights) { values.push(offset); offset += height; }
    return { values, total: offset };
  }, [heights]);

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewport(current => ({ ...current, width: element.clientWidth, height: element.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const first = React.useMemo(() => {
    const target = Math.max(0, viewport.scrollTop - 320);
    let index = 0;
    while (index < offsets.values.length - 1 && offsets.values[index + 1] < target) index += 1;
    return index;
  }, [offsets.values, viewport.scrollTop]);
  const last = React.useMemo(() => {
    const target = viewport.scrollTop + viewport.height + 320;
    let index = first;
    while (index < offsets.values.length && offsets.values[index] < target) index += 1;
    return Math.min(rows.length, index + 1);
  }, [first, offsets.values, rows.length, viewport.height, viewport.scrollTop]);

  React.useEffect(() => {
    if (hasNextPage && !loading && last >= Math.max(0, rows.length - 2)) onLoadNextPage();
  }, [hasNextPage, last, loading, onLoadNextPage, rows.length]);

  return (
    <div ref={viewportRef} className="h-full overflow-y-auto custom-scrollbar" onScroll={event => captureScrollPosition(setViewport, event)}>
      <div className="relative" style={{ height: offsets.total }}>
        {rows.slice(first, last).map((row, index) => {
          const rowIndex = first + index;
          return row.kind === 'header' ? (
            <div key={`header:${row.groupId}`} style={{ position: 'absolute', top: offsets.values[rowIndex], left: 0, right: 0, height: heights[rowIndex] }} className="px-1 py-1">
              <div
                onClick={event => { event.stopPropagation(); onToggleSelection(row.groupId, 'folder', event.ctrlKey || event.metaKey); }}
                onContextMenu={event => onContextMenuFolder(event, row.groupId)}
                className={cn('flex h-full cursor-pointer items-center gap-2 rounded-md border px-3', selectedFolderIds.has(row.groupId) ? 'border-blue-500/50 bg-blue-500/10' : 'border-neutral-800 bg-[#181818] hover:border-neutral-700')}
              >
                <button onClick={event => { event.stopPropagation(); onToggleGroupCollapse(row.groupId); }} className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white" title="折叠/展开文件夹分组">
                  {items.some(item => item.kind === 'asset' && item.groupId === row.groupId) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <FolderIcon size={18} className="shrink-0 text-blue-400" />
                <span className="truncate font-medium text-neutral-200">{row.folder.name}</span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">{row.assetCount}</span>
                <span className="truncate text-xs text-neutral-500" title={row.folder.path}>{row.folder.path}</span>
              </div>
            </div>
          ) : (
            <div key={`assets:${row.groupId}:${rowIndex}`} style={{ position: 'absolute', top: offsets.values[rowIndex], left: 0, right: 0, height: heights[rowIndex], ...(viewMode === 'grid' ? { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 16, paddingLeft: 4, paddingRight: 4 } : {}) }} className={viewMode === 'list' ? 'flex flex-col gap-1 px-1' : ''}>
              {row.assets.map(asset => {
                const labels = [...asset.tags.map(id => tagLabels.get(id) ?? id), ...asset.collections.map(id => collectionLabels.get(id) ?? id)];
                if (viewMode === 'list') return (
                  <div key={asset.id} onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, 'asset', event.ctrlKey || event.metaKey); }} onContextMenu={event => onContextMenuAsset(event, asset.id)} onDoubleClick={() => onPreviewAsset?.(asset)} className={cn('flex h-12 cursor-pointer items-center gap-3 rounded-md border px-3', selectedAssetIds.has(asset.id) ? 'border-blue-500/40 bg-blue-500/10' : 'border-transparent hover:bg-white/5')}>
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-black"><ThumbnailImage asset={asset} className="h-full w-full object-contain" fallbackIcon={fallbackIcon(asset.type)} /></div>
                    <span className="min-w-0 flex-1 truncate text-sm" title={asset.name}>{asset.name}</span>
                    <span className="hidden max-w-64 truncate text-[10px] text-neutral-500 md:block">{labels.slice(0, 3).join(' · ')}</span>
                    <span className="w-20 shrink-0 text-right text-xs text-neutral-500">{formatBytes(asset.size)}</span>
                  </div>
                );
                return (
                  <div key={asset.id} onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, 'asset', event.ctrlKey || event.metaKey); }} onContextMenu={event => onContextMenuAsset(event, asset.id)} onDoubleClick={() => onPreviewAsset?.(asset)} className={cn('group h-full cursor-pointer overflow-hidden rounded-lg border bg-[#1e1e1e]', selectedAssetIds.has(asset.id) ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-800 hover:border-neutral-600')}>
                    <div className="relative h-[calc(100%_-_68px)] min-h-0 bg-black"><ThumbnailImage asset={asset} className="h-full w-full object-contain" fallbackIcon={fallbackIcon(asset.type)} /><span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] uppercase">{asset.type}</span></div>
                    <div className="flex h-[68px] flex-col justify-between p-2"><div className="truncate text-sm font-medium" title={asset.name}>{asset.name}</div><div className="flex min-w-0 gap-1 overflow-hidden text-[10px] text-neutral-400">{labels.slice(0, 3).map(label => <span key={label} className="truncate rounded bg-neutral-800 px-1">{label}</span>)}</div><div className="flex justify-between border-t border-neutral-800 pt-1 text-[11px] text-neutral-500"><span>{formatBytes(asset.size)}</span><span>{asset.dateModified.slice(0, 10)}</span></div></div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
