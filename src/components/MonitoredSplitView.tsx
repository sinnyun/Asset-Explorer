import React from 'react';
import { HardDrive, Search } from 'lucide-react';
import type { Asset, AssetSummary, Folder, FolderSummary, SelectionItem } from '../types';
import { useAssetQuery } from '../hooks/useAssetQuery';
import { dataService } from '../services/dataService';
import { VirtualAssetGrid } from './VirtualAssetGrid';
import { initialSplitState, splitViewReducer, type SplitColumnId, type SplitColumnState } from './splitViewState';

interface MonitoredSplitViewProps {
  folders: Folder[];
  selectedItems: SelectionItem[];
  onToggleSelection: (id: string, type: 'asset' | 'folder', multi: boolean) => void;
  onContextMenuAsset: (event: React.MouseEvent, id: string) => void;
  onPreviewAsset?: (asset: Asset) => void;
}

function toAsset(item: AssetSummary): Asset {
  const dateModified = new Date(Math.max(0, item.mtimeNs / 1_000_000)).toISOString();
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    type: item.type as Asset['type'],
    size: item.size,
    folderId: item.folderId ?? '',
    dateModified,
    dateAdded: dateModified,
    tags: [],
    collections: [],
    width: item.width,
    height: item.height,
  };
}

function useFolderChildren(parentId?: string) {
  const [items, setItems] = React.useState<FolderSummary[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!parentId) { setItems([]); return; }
    let disposed = false;
    setError(null);
    dataService.queryFolders({ parentId, limit: 300 })
      .then(page => { if (!disposed) setItems(page.items); })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [parentId]);
  return { items, error };
}

interface ColumnProps {
  id: SplitColumnId;
  title: string;
  root?: Folder;
  state: SplitColumnState;
  dispatch: React.Dispatch<Parameters<typeof splitViewReducer>[1]>;
  selectedIds: Set<string>;
  onToggleSelection: MonitoredSplitViewProps['onToggleSelection'];
  onContextMenuAsset: MonitoredSplitViewProps['onContextMenuAsset'];
  onPreviewAsset?: MonitoredSplitViewProps['onPreviewAsset'];
}

function SplitColumn({ id, title, root, state, dispatch, selectedIds, onToggleSelection, onContextMenuAsset, onPreviewAsset }: ColumnProps) {
  const [draftSearch, setDraftSearch] = React.useState('');
  const children = useFolderChildren(root?.id);
  const query = useAssetQuery({
    folderId: state.folderId ?? root?.id,
    includeDescendants: true,
    search: state.search || undefined,
    sort: 'name_asc',
    limit: 300,
  });
  const assets = React.useMemo(() => query.items.map(toAsset), [query.items]);

  return (
    <section className="min-w-0 flex flex-col bg-[#181818]">
      <header className="space-y-2 border-b border-neutral-800 bg-[#1e1e1e] p-3">
        <div className="flex items-center gap-2">
          <HardDrive size={15} className={id === 'left' ? 'text-blue-400' : 'text-purple-400'} />
          <strong className="min-w-0 flex-1 truncate text-sm">{title}: {root?.name ?? '未选择'}</strong>
          <span className="text-xs text-neutral-500">已载入 {assets.length}</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <select
            value={state.folderId ?? root?.id ?? ''}
            onChange={event => dispatch({ type: 'folder', column: id, value: event.target.value || root?.id })}
            className="min-w-0 rounded border border-neutral-800 bg-[#141414] px-2 py-1.5 text-xs outline-none"
          >
            {root && <option value={root.id}>{root.name}（全部子目录）</option>}
            {children.items.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
          <div className="relative">
            <Search size={13} className="absolute left-2 top-2 text-neutral-500" />
            <input
              value={draftSearch}
              onChange={event => setDraftSearch(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') dispatch({ type: 'search', column: id, value: draftSearch.trim() }); }}
              placeholder="本列搜索，按 Enter"
              className="w-full rounded border border-neutral-800 bg-[#141414] py-1.5 pl-7 pr-2 text-xs outline-none"
            />
          </div>
        </div>
        {(children.error || query.error) && <div className="text-xs text-red-400">{children.error ?? query.error}</div>}
      </header>
      <div className="min-h-0 flex-1 p-2">
        {!root ? (
          <div className="h-full grid place-items-center text-sm text-neutral-500">没有可用的监视根目录</div>
        ) : assets.length === 0 && !query.loading ? (
          <div className="h-full grid place-items-center text-sm text-neutral-500">当前列没有文件</div>
        ) : (
          <VirtualAssetGrid
            assets={assets}
            selectedIds={selectedIds}
            loading={query.loading}
            hasNextPage={query.hasNextPage}
            onLoadNextPage={query.loadNextPage}
            onToggleSelection={(assetId, multi) => onToggleSelection(assetId, 'asset', multi)}
            onContextMenu={onContextMenuAsset}
            onPreview={onPreviewAsset}
          />
        )}
      </div>
    </section>
  );
}

export function MonitoredSplitView({ folders, selectedItems, onToggleSelection, onContextMenuAsset, onPreviewAsset }: MonitoredSplitViewProps) {
  const roots = React.useMemo(() => {
    const monitored = folders.filter(folder => folder.isMonitored);
    return monitored.length > 0 ? monitored : folders.filter(folder => !folder.parentId);
  }, [folders]);
  const [state, dispatch] = React.useReducer(splitViewReducer, initialSplitState(roots[0]?.id, roots[1]?.id ?? roots[0]?.id));
  const selectedIds = React.useMemo(() => new Set(selectedItems.filter(item => item.type === 'asset').map(item => item.id)), [selectedItems]);

  React.useEffect(() => {
    if (!state.left.folderId && roots[0]) dispatch({ type: 'folder', column: 'left', value: roots[0].id });
    if (!state.right.folderId && roots[0]) dispatch({ type: 'folder', column: 'right', value: roots[1]?.id ?? roots[0].id });
  }, [roots, state.left.folderId, state.right.folderId]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-hidden bg-neutral-800 lg:grid-cols-2">
      <SplitColumn id="left" title="工作区 A" root={roots[0]} state={state.left} dispatch={dispatch} selectedIds={selectedIds} onToggleSelection={onToggleSelection} onContextMenuAsset={onContextMenuAsset} onPreviewAsset={onPreviewAsset} />
      <SplitColumn id="right" title="工作区 B" root={roots[1] ?? roots[0]} state={state.right} dispatch={dispatch} selectedIds={selectedIds} onToggleSelection={onToggleSelection} onContextMenuAsset={onContextMenuAsset} onPreviewAsset={onPreviewAsset} />
    </div>
  );
}
