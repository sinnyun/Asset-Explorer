import React from 'react';
import { AlertTriangle, Columns2, Folder as FolderIcon, FolderPlus, FolderTree, Grid, List, Loader2, PackageOpen, Search } from 'lucide-react';
import type { Asset, AssetState, Folder, SortOption } from '../types';
import { cn } from '../lib/utils';
import { MonitoredSplitView } from './MonitoredSplitView';
import { VirtualGroupedAssetView } from './VirtualGroupedAssetView';
import { buildGroupedAssetItems } from './groupedAssetModel';

interface MainAreaProps {
  state: AssetState;
  filteredAssets: Asset[];
  filteredFolders: Folder[];
  folderLoading: boolean;
  folderHasNextPage: boolean;
  onLoadNextFolderPage: () => void;
  queryLoading: boolean;
  queryError: string | null;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
  onToggleSelection: (id: string, type: 'asset' | 'folder', multi: boolean) => void;
  onClearSelection: () => void;
  onChangeView: (mode: 'grid' | 'list') => void;
  onToggleGroupByFolder: () => void;
  onToggleIncludeSubfolders: () => void;
  onToggleGroupCollapse: (id: string) => void;
  onSortChange: (option: SortOption) => void;
  onSearchSubmit: (query: string) => void;
  onContextMenuAsset: (event: React.MouseEvent, id: string) => void;
  onContextMenuFolder: (event: React.MouseEvent, id: string) => void;
  onContextMenuCanvas?: (event: React.MouseEvent) => void;
  onSelectFolder?: (id: string) => void;
  onAddMonitoredFolder?: () => void;
  onPreviewAsset?: (asset: Asset) => void;
}

export function MainArea({
  state,
  filteredAssets,
  filteredFolders,
  folderLoading,
  folderHasNextPage,
  onLoadNextFolderPage,
  queryLoading,
  queryError,
  hasNextPage,
  onLoadNextPage,
  onToggleSelection,
  onClearSelection,
  onChangeView,
  onToggleGroupByFolder: _onToggleGroupByFolder,
  onToggleIncludeSubfolders,
  onToggleGroupCollapse,
  onSortChange,
  onSearchSubmit,
  onContextMenuAsset,
  onContextMenuFolder,
  onContextMenuCanvas,
  onSelectFolder,
  onAddMonitoredFolder,
  onPreviewAsset,
}: MainAreaProps) {
  const [search, setSearch] = React.useState('');
  const [splitView, setSplitView] = React.useState(false);
  const selectedAssetIds = React.useMemo(
    () => new Set(state.selectedItems.filter(item => item.type === 'asset').map(item => item.id)),
    [state.selectedItems],
  );
  const tagLabels = React.useMemo(() => new Map(state.tags.map(tag => [tag.id, tag.name])), [state.tags]);
  const collectionLabels = React.useMemo(() => new Map(state.collections.map(collection => [collection.id, collection.name])), [state.collections]);
  const selectedFolderIds = React.useMemo(
    () => new Set(state.selectedItems.filter(item => item.type === 'folder').map(item => item.id)),
    [state.selectedItems],
  );
  const groupedItems = React.useMemo(
    () => buildGroupedAssetItems(filteredAssets, state.folders, state.collapsedGroupIds),
    [filteredAssets, state.collapsedGroupIds, state.folders],
  );

  return (
    <main className="flex-1 min-w-0 flex flex-col bg-[#141414] overflow-hidden" onClick={onClearSelection}>
      <div className="h-14 border-b border-neutral-800 flex items-center justify-between gap-3 px-4 shrink-0">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative w-64 max-w-[40vw]">
            <Search className="absolute left-2.5 top-2 text-neutral-500" size={16} />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') onSearchSubmit(search.trim()); }}
              placeholder="搜索文件，按 Enter"
              className="w-full rounded-md border border-neutral-800 bg-[#1e1e1e] py-1.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={event => { event.stopPropagation(); onToggleIncludeSubfolders(); }}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
              state.includeSubfolders ? 'border-blue-500/40 bg-blue-500/10 text-blue-400' : 'border-neutral-800 bg-[#1e1e1e] text-neutral-400',
            )}
          >
            <FolderTree size={15} />{state.includeSubfolders ? '包含子文件夹' : '仅当前文件夹'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={state.sortOption}
            onChange={event => onSortChange(event.target.value as SortOption)}
            className="rounded-md border border-neutral-800 bg-[#1e1e1e] px-2 py-1.5 text-xs text-neutral-300 outline-none"
          >
            <option value="name_asc">名称 A–Z</option>
            <option value="name_desc">名称 Z–A</option>
            <option value="date_modified_desc">最近修改</option>
            <option value="date_modified_asc">最早修改</option>
            <option value="size_desc">文件最大</option>
            <option value="size_asc">文件最小</option>
          </select>
          <button
            onClick={event => { event.stopPropagation(); setSplitView(value => !value); }}
            className={cn('rounded-md border p-1.5', splitView ? 'border-purple-500/40 bg-purple-500/10 text-purple-300' : 'border-neutral-800 text-neutral-400')}
            title="双分列对比"
          ><Columns2 size={16} /></button>
          <div className="flex rounded-md border border-neutral-800 bg-[#1e1e1e] p-0.5">
            <button onClick={() => onChangeView('grid')} className={cn('rounded p-1', state.viewMode === 'grid' && 'bg-neutral-700 text-white')}><Grid size={16} /></button>
            <button onClick={() => onChangeView('list')} className={cn('rounded p-1', state.viewMode === 'list' && 'bg-neutral-700 text-white')}><List size={16} /></button>
          </div>
        </div>
      </div>

      {splitView ? (
        <MonitoredSplitView
          folders={state.folders}
          selectedItems={state.selectedItems}
          onToggleSelection={onToggleSelection}
          onContextMenuAsset={onContextMenuAsset}
          onPreviewAsset={onPreviewAsset}
          tagLabels={tagLabels}
          collectionLabels={collectionLabels}
        />
      ) : (
        <section className="relative flex-1 min-h-0 p-4" onContextMenu={onContextMenuCanvas}>
          {queryError ? (
            <div className="h-full flex items-center justify-center">
              <div className="max-w-md rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
                <AlertTriangle className="mx-auto mb-3 text-red-400" />
                <div className="font-medium">读取文件失败</div>
                <div className="mt-1 text-sm text-neutral-400">{queryError}</div>
              </div>
            </div>
          ) : queryLoading && filteredAssets.length === 0 && filteredFolders.length === 0 ? (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-neutral-400"><Loader2 className="animate-spin" size={18} />正在读取文件…</div>
          ) : filteredAssets.length === 0 && filteredFolders.length === 0 && !folderLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-neutral-400">
              <PackageOpen size={42} className="mb-3 text-neutral-700" />
              <div className="font-medium text-neutral-300">当前范围没有文件</div>
              <div className="mt-1 text-sm">可选择其他文件夹、调整筛选，或添加监视文件夹。</div>
              {onAddMonitoredFolder && <button onClick={onAddMonitoredFolder} className="mt-4 flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm text-white"><FolderPlus size={16} />添加监视文件夹</button>}
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-3">
              {filteredFolders.length > 0 && (
                <div className="grid max-h-56 shrink-0 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 custom-scrollbar">
                  {filteredFolders.map(folder => {
                    const selected = state.selectedItems.some(item => item.type === 'folder' && item.id === folder.id);
                    return (
                      <div
                        key={folder.id}
                        onClick={event => { event.stopPropagation(); onToggleSelection(folder.id, 'folder', event.ctrlKey || event.metaKey); onSelectFolder?.(folder.id); }}
                        onContextMenu={event => onContextMenuFolder(event, folder.id)}
                        className={cn(
                          'flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-[#1e1e1e] px-3 py-2.5 transition-colors',
                          selected ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40' : 'border-neutral-800 hover:border-neutral-600',
                        )}
                      >
                        <FolderIcon size={22} className="shrink-0 text-blue-400" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-neutral-200" title={folder.name}>{folder.name}</div>
                          <div className="truncate text-[11px] text-neutral-500" title={folder.path}>{folder.path}</div>
                        </div>
                        <span className="shrink-0 text-[11px] text-neutral-500">{folder.assetCount ?? 0} 项</span>
                      </div>
                    );
                  })}
                  {folderHasNextPage && <button onClick={event => { event.stopPropagation(); onLoadNextFolderPage(); }} className="col-span-full rounded-md border border-dashed border-neutral-700 py-2 text-xs text-neutral-400 hover:border-blue-500 hover:text-blue-400">加载更多文件夹</button>}
                </div>
              )}
              {filteredAssets.length > 0 ? (
                <div className="min-h-0 flex-1">
                  <VirtualGroupedAssetView
                    items={groupedItems}
                    viewMode={state.viewMode}
                    selectedAssetIds={selectedAssetIds}
                    selectedFolderIds={selectedFolderIds}
                    loading={queryLoading}
                    hasNextPage={hasNextPage}
                    onLoadNextPage={onLoadNextPage}
                    onToggleSelection={onToggleSelection}
                    onContextMenuAsset={onContextMenuAsset}
                    onContextMenuFolder={onContextMenuFolder}
                    onPreviewAsset={onPreviewAsset}
                    onToggleGroupCollapse={onToggleGroupCollapse}
                    tagLabels={tagLabels}
                    collectionLabels={collectionLabels}
                  />
                </div>
              ) : folderLoading ? (
                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-neutral-400"><Loader2 className="animate-spin" size={18} />正在读取文件夹…</div>
              ) : null}
            </div>
          )}
          {queryLoading && filteredAssets.length > 0 && (
            <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-neutral-700 bg-[#1e1e1e]/95 px-3 py-1.5 text-xs text-neutral-300 shadow-xl">
              正在加载下一页…
            </div>
          )}
        </section>
      )}
    </main>
  );
}
