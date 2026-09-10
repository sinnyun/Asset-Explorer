import React from 'react';
import { Box, ChevronDown, ChevronRight, FileText, Folder as FolderIcon, Image as ImageIcon, Layers, Video } from 'lucide-react';
import type { Asset, Folder, Tag } from '../types';
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
  tagMap: Map<string, Tag>;
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

function AdaptiveTagRow({ tagIds, tagMap, maxRowWidth }: { tagIds: string[]; tagMap: Map<string, Tag>; maxRowWidth?: number }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(maxRowWidth ?? 0);
  React.useLayoutEffect(() => {
    if (maxRowWidth) { setContainerWidth(maxRowWidth); return; }
    const element = containerRef.current;
    if (!element) return;
    const update = () => { if (element.clientWidth > 0) setContainerWidth(element.clientWidth); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxRowWidth]);

  const validTags = tagIds.map(id => tagMap.get(id)).filter((tag): tag is Tag => Boolean(tag));
  const width = containerWidth > 0 ? containerWidth : 170;
  const visible: Tag[] = [];
  let used = 0;
  for (let index = 0; index < validTags.length; index += 1) {
    const tag = validTags[index];
    const pillWidth = Math.min(Math.max(24 + Math.min(tag.name.length * 6.8, 68), 38), 92);
    const reserve = index < validTags.length - 1 ? 36 : 0;
    if (used + pillWidth + reserve <= width || visible.length === 0) {
      visible.push(tag);
      used += pillWidth + 4;
    } else break;
  }
  const overflow = validTags.length - visible.length;
  return (
    <div ref={containerRef} className="flex w-full items-center gap-1 overflow-hidden flex-nowrap">
      {visible.map(tag => <span key={tag.id} className="inline-flex max-w-[90px] shrink-0 items-center gap-1 truncate rounded-full border border-neutral-700/60 bg-neutral-800/90 px-1.5 py-0.5 text-[10px] text-neutral-300 shadow-xs transition-all hover:border-neutral-500 hover:text-white" title={`标签: ${tag.name}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full shadow-sm ring-1 ring-black/40" style={{ backgroundColor: tag.color || '#3B82F6' }} /><span className="truncate">{tag.name}</span></span>)}
      {overflow > 0 && <span className="inline-flex shrink-0 cursor-help items-center rounded-full border border-neutral-700/60 bg-neutral-800/90 px-1.5 py-0.5 text-[9px] font-mono text-neutral-400 hover:text-neutral-200" title={`折叠更多标签 (${overflow}):\n${validTags.slice(visible.length).map(tag => tag.name).join('、')}`}>+{overflow}</span>}
    </div>
  );
}

function CollectionBadge({ asset, collectionLabels, overlay = false }: { asset: Asset; collectionLabels: Map<string, string>; overlay?: boolean }) {
  if (asset.collections.length === 0) return null;
  const first = collectionLabels.get(asset.collections[0]);
  if (!first) return null;
  const names = asset.collections.map(id => collectionLabels.get(id) ?? id).join(', ');
  return <div className={overlay ? 'pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[85%] flex-nowrap items-center gap-1' : 'flex shrink-0 items-center gap-1'}>
    <span className={cn('inline-flex max-w-[120px] min-w-0 shrink items-center gap-1 truncate rounded-md border px-2 py-0.5 text-[10px] font-medium text-amber-300', overlay ? 'border-amber-500/40 bg-black/80 shadow-md' : 'border-amber-500/25 bg-amber-500/10 shadow-xs')} title={`所属集合: ${names}`}><Layers size={overlay ? 10 : 9} className="shrink-0 text-amber-400" /><span className={cn('truncate', overlay ? 'max-w-[95px]' : '')}>{first}</span></span>
    {asset.collections.length > 1 && <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-mono text-amber-300', overlay ? 'border-amber-500/40 bg-black/80 shadow-md' : 'border-amber-500/25 bg-amber-500/10')} title={`所属集合: ${names}`}>+{asset.collections.length - 1}</span>}
  </div>;
}

export function VirtualGroupedAssetView({
  items, viewMode, selectedAssetIds, selectedFolderIds, loading, hasNextPage, onLoadNextPage,
  onToggleSelection, onContextMenuAsset, onContextMenuFolder, onPreviewAsset, onToggleGroupCollapse,
  tagMap, collectionLabels,
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
                if (viewMode === 'list') return (
                  <div key={asset.id} onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, 'asset', event.ctrlKey || event.metaKey); }} onContextMenu={event => onContextMenuAsset(event, asset.id)} onDoubleClick={() => onPreviewAsset?.(asset)} className={cn('flex h-12 cursor-pointer items-center gap-3 rounded-md border px-3', selectedAssetIds.has(asset.id) ? 'border-blue-500/40 bg-blue-500/10' : 'border-transparent hover:bg-white/5')}>
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-black"><ThumbnailImage asset={asset} className="h-full w-full object-contain" fallbackIcon={fallbackIcon(asset.type)} /></div>
                    <div className="flex min-w-0 flex-1 items-center gap-3"><span className="max-w-[220px] shrink-0 truncate text-sm font-medium text-neutral-200" title={asset.name}>{asset.name}</span><div className="hidden max-w-[360px] min-w-0 flex-1 items-center gap-2 overflow-hidden md:flex"><CollectionBadge asset={asset} collectionLabels={collectionLabels} />{asset.tags.length > 0 && <div className="min-w-0 max-w-[220px] flex-1"><AdaptiveTagRow tagIds={asset.tags} tagMap={tagMap} maxRowWidth={210} /></div>}</div></div>
                    <span className="w-20 shrink-0 text-right text-xs text-neutral-500">{formatBytes(asset.size)}</span>
                    <span className="w-24 shrink-0 text-right text-xs text-neutral-500">{asset.dateModified.slice(0, 10)}</span>
                  </div>
                );
                return (
                  <div key={asset.id} onClick={event => { event.stopPropagation(); onToggleSelection(asset.id, 'asset', event.ctrlKey || event.metaKey); }} onContextMenu={event => onContextMenuAsset(event, asset.id)} onDoubleClick={() => onPreviewAsset?.(asset)} className={cn('group h-full cursor-pointer overflow-hidden rounded-lg border bg-[#1e1e1e]', selectedAssetIds.has(asset.id) ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-800 hover:border-neutral-600')}>
                    <div className="relative h-[calc(100%_-_82px)] min-h-0 bg-black"><ThumbnailImage asset={asset} className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105" fallbackIcon={fallbackIcon(asset.type)} /><span className="absolute right-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/90">{asset.type}</span><CollectionBadge asset={asset} collectionLabels={collectionLabels} overlay />{asset.collections.length > 0 && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-black/70 to-transparent" />}</div>
                    <div className="flex h-[82px] shrink-0 flex-col justify-between p-2.5"><div className="truncate text-sm font-medium leading-snug text-neutral-200" title={asset.name}>{asset.name}</div><div className="my-0.5 flex h-5 items-center overflow-hidden">{asset.tags.length > 0 ? <AdaptiveTagRow tagIds={asset.tags} tagMap={tagMap} /> : <div className="flex select-none items-center gap-1 text-[10px] italic text-neutral-600/40"><span className="h-1 w-1 rounded-full bg-neutral-800" />无标签</div>}</div><div className="mt-auto flex items-center justify-between border-t border-neutral-800/60 pt-1 text-[11px] text-neutral-500"><span className="truncate pr-2">{formatBytes(asset.size)}</span><span className="shrink-0">{asset.dateModified.slice(0, 10)}</span></div></div>
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
