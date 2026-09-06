import React, { useState } from 'react';
import { Search, Filter, Grid, List, Image as ImageIcon, Video, Box, FileText, 
  Folder as FolderIcon, FolderTree, AlertTriangle, ChevronUp, ChevronDown, 
  Layers, Columns2, FolderPlus, Loader2
} from 'lucide-react';
import { cn, formatBytes } from '../lib/utils';
import { Asset, AssetState, Folder, SortOption } from '../types';
import { MonitoredSplitView } from './MonitoredSplitView';
import { dataService } from '../services/dataService';

interface MainAreaProps {
  state: AssetState;
  filteredAssets: Asset[];
  filteredFolders: Folder[];
  onToggleSelection: (id: string, type: 'asset' | 'folder', multi: boolean) => void;
  onClearSelection: () => void;
  onChangeView: (mode: 'grid' | 'list') => void;
  onToggleGroupByFolder: () => void;
  onToggleIncludeSubfolders: () => void;
  onToggleGroupCollapse: (id: string) => void;
  onSortChange: (option: SortOption) => void;
  onSearchSubmit: (query: string) => void;
  onContextMenuAsset: (e: React.MouseEvent, id: string) => void;
  onContextMenuFolder: (e: React.MouseEvent, id: string) => void;
  onSelectFolder?: (id: string) => void;
  onAddMonitoredFolder?: () => void;
}

// Utility to cleanly format deep paths
function formatDisplayPath(path: string): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= 4) return path;
  
  const first = parts[0];
  const lastThree = parts.slice(-3).join('/');
  return `${first}/.../${lastThree}`;
}

export function MainArea({ 
  state, 
  filteredAssets,
  filteredFolders,
  onToggleSelection, 
  onClearSelection,
  onChangeView,
  onToggleGroupByFolder,
  onToggleIncludeSubfolders,
  onToggleGroupCollapse,
  onSortChange,
  onSearchSubmit,
  onContextMenuAsset,
  onContextMenuFolder,
  onSelectFolder,
  onAddMonitoredFolder
}: MainAreaProps) {
  
  const [localSearch, setLocalSearch] = useState('');
  const [isSplitMonitoredView, setIsSplitMonitoredView] = useState(false);
  
  // 懒加载缩略图缓存：assetId → 可展示 URL
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // 跟踪正在加载中的资产，避免重复请求
  const [loadingThumbnails, setLoadingThumbnails] = useState<Set<string>>(new Set());
  // 跟踪缩略图生成失败的资产（如文件路径不存在），避免反复重试
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(new Set());

  /**
   * 懒加载资产缩略图：仅当 asset.thumbnailUrl 为空且未开始加载且未失败过时触发
   */
  const ensureThumbnail = async (asset: Asset) => {
    if (asset.thumbnailUrl || thumbnails[asset.id] || loadingThumbnails.has(asset.id) || failedThumbnails.has(asset.id)) return;
    setLoadingThumbnails(prev => new Set(prev).add(asset.id));
    try {
      const url = await dataService.getAssetThumbnail(asset.id, asset.path);
      if (url) {
        setThumbnails(prev => ({ ...prev, [asset.id]: url }));
      } else {
        // 返回 null 说明文件不存在或生成失败，记录到失败集合避免重复尝试
        setFailedThumbnails(prev => new Set(prev).add(asset.id));
      }
    } catch (err) {
      console.warn(`[MainArea] 缩略图生成失败: ${asset.path}`, err);
      setFailedThumbnails(prev => new Set(prev).add(asset.id));
    } finally {
      setLoadingThumbnails(prev => {
        const next = new Set(prev);
        next.delete(asset.id);
        return next;
      });
    }
  };

  const handleAssetClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onToggleSelection(id, 'asset', e.ctrlKey || e.metaKey);
  };

  const handleFolderClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onToggleSelection(id, 'folder', e.ctrlKey || e.metaKey);
  };

  const getAssetIcon = (type: string) => {
    switch (type) {
      case 'image': return <ImageIcon size={24} className="text-blue-400" />;
      case 'video': return <Video size={24} className="text-purple-400" />;
      case 'model': return <Box size={24} className="text-amber-400" />;
      case 'document': return <FileText size={24} className="text-green-400" />;
      default: return <FileText size={24} />;
    }
  };

  const groupsMap = new Map<string, { folder: Folder, assets: Asset[] }>();
  
  // Collect folders from assets
  filteredAssets.forEach(a => {
    if (!groupsMap.has(a.folderId)) {
      const f = state.folders.find(x => x.id === a.folderId);
      if (f) groupsMap.set(f.id, { folder: f, assets: [] });
    }
    groupsMap.get(a.folderId)?.assets.push(a);
  });
  
  // Add independently matched folders
  filteredFolders.forEach(f => {
    if (!groupsMap.has(f.id)) {
      groupsMap.set(f.id, { folder: f, assets: [] });
    }
  });

  let allGroups = Array.from(groupsMap.values());
  
  // When filtering by tags or collections, do not show empty folders
  if (state.activeTagId || state.activeCollectionId) {
    allGroups = allGroups.filter(g => g.assets.length > 0);
  }

  allGroups.sort((a, b) => a.folder.path.localeCompare(b.folder.path));

  // Sort assets inside each group
  allGroups.forEach(group => {
    group.assets.sort((a, b) => {
      switch (state.sortOption) {
        case 'name_asc': return a.name.localeCompare(b.name);
        case 'name_desc': return b.name.localeCompare(a.name);
        case 'date_modified_desc': return new Date(b.dateModified).getTime() - new Date(a.dateModified).getTime();
        case 'date_modified_asc': return new Date(a.dateModified).getTime() - new Date(b.dateModified).getTime();
        case 'size_desc': return b.size - a.size;
        case 'size_asc': return a.size - b.size;
        default: return 0;
      }
    });
  });

  // Safeguard: Limit rendering to prevent DOM crash on massive data
  const MAX_GROUPS_TO_RENDER = 100;
  const isTruncated = allGroups.length > MAX_GROUPS_TO_RENDER;
  const groups = allGroups.slice(0, MAX_GROUPS_TO_RENDER);

  return (
    <div className="flex-1 flex flex-col bg-[#141414] overflow-hidden" onClick={onClearSelection}>
      {/* Top Toolbar */}
      <div className="h-14 border-b border-neutral-800 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1.5 text-neutral-500" size={16} />
            <input 
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onSearchSubmit(localSearch);
                  setLocalSearch('');
                }
              }}
              placeholder="Search assets (Press Enter)..."
              className="w-full bg-[#1e1e1e] border border-neutral-800 rounded-md py-1 pl-9 pr-3 text-sm text-neutral-200 focus:outline-none focus:border-neutral-600 focus:bg-[#252525] transition-colors"
            />
          </div>
          
          {/* Subfolders Toggle (Vital for large structures) */}
          <button 
            onClick={onToggleIncludeSubfolders}
            className={cn(
              "flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-md border transition-colors", 
              state.includeSubfolders ? "bg-blue-500/10 border-blue-500/30 text-blue-400" : "bg-[#1e1e1e] border-neutral-800 text-neutral-400 hover:bg-[#252525] hover:text-neutral-200"
            )}
            title="Include all nested subfolders in current view"
          >
            <FolderTree size={16} />
            {state.includeSubfolders ? "Include Subfolders" : "Current Folder Only"}
          </button>
        </div>

        <div className="flex items-center gap-4">
          
          <select 
            value={state.sortOption}
            onChange={(e) => onSortChange(e.target.value as SortOption)}
            className="bg-[#1e1e1e] text-xs font-medium text-neutral-400 border border-neutral-800 hover:border-neutral-700 rounded-md px-2 py-1 focus:outline-none"
          >
            <option value="name_asc">Name (A-Z)</option>
            <option value="name_desc">Name (Z-A)</option>
            <option value="date_desc">Newest First</option>
            <option value="date_asc">Oldest First</option>
            <option value="size_desc">Largest First</option>
            <option value="size_asc">Smallest First</option>
          </select>

          <button
            onClick={() => setIsSplitMonitoredView(!isSplitMonitoredView)}
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors",
              isSplitMonitoredView 
                ? "bg-purple-500/20 border-purple-500/40 text-purple-300 font-semibold" 
                : "bg-[#1e1e1e] border-neutral-800 text-neutral-400 hover:text-neutral-200"
            )}
            title="切换为本地监视文件夹双分列独立对比视图"
          >
            <Columns2 size={14} />
            <span>双分列对比</span>
          </button>

          <div className="flex items-center gap-1 bg-[#1e1e1e] p-0.5 rounded-md border border-neutral-800">
            <button 
              onClick={() => onChangeView('grid')}
              className={cn("p-1 rounded-sm transition-colors", state.viewMode === 'grid' ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200")}
            >
              <Grid size={16} />
            </button>
            <button 
              onClick={() => onChangeView('list')}
              className={cn("p-1 rounded-sm transition-colors", state.viewMode === 'list' ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200")}
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Body: Either Dual-Column Monitored Split View OR Standard Canvas */}
      {isSplitMonitoredView ? (
        <MonitoredSplitView
          folders={state.folders}
          assets={state.assets}
          selectedItems={state.selectedItems}
          onToggleSelection={onToggleSelection}
          onContextMenuAsset={onContextMenuAsset}
          onContextMenuFolder={onContextMenuFolder}
          onSelectFolder={(id) => onSelectFolder?.(id)}
        />
      ) : (
        /* Asset Canvas */
        <div className="flex-1 overflow-y-scroll p-6 custom-scrollbar relative">
        {isTruncated && (
          <div className="mb-6 flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg text-amber-400 text-sm">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Too many folders to display.</p>
              <p className="opacity-80">Showing the first {MAX_GROUPS_TO_RENDER} folder groups. Please turn off "Include Subfolders" or refine your search to avoid layout freezing.</p>
            </div>
          </div>
        )}

        {groups.map((group, i) => {
          const isFolderSelected = state.selectedItems.some(i => i.type === 'folder' && i.id === group.folder.id);
          const isCollapsed = state.collapsedGroupIds.includes(group.folder.id);
          
          return (
            <div key={group.folder.id} className="mb-8 last:mb-0">
              
              {/* Group Header */}
              <div 
                onClick={(e) => handleFolderClick(e, group.folder.id)}
                onContextMenu={(e) => onContextMenuFolder(e, group.folder.id)}
                className={cn(
                  "mb-4 p-2.5 rounded-md cursor-pointer transition-colors border flex items-center justify-between group",
                  isFolderSelected 
                    ? "bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/50" 
                    : "bg-[#181818] border-neutral-800 hover:border-neutral-700 hover:bg-[#1e1e1e]"
                )}
              >
                <div className="flex items-center gap-3 overflow-hidden pr-4">
                  <FolderIcon size={18} className={isFolderSelected ? "text-blue-400 shrink-0" : "text-neutral-400 shrink-0"} />
                  <span className="font-semibold text-neutral-100 truncate">{group.folder.name}</span>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 shrink-0">
                    {group.assets.length}
                  </span>
                  
                  {/* Optimized Vertical Divider */}
                  <div className="h-4 w-px bg-neutral-700/50 shrink-0 ml-1" />
                  
                  <span className="font-mono text-xs text-neutral-500 truncate" title={group.folder.path}>
                    {formatDisplayPath(group.folder.path)}
                  </span>
                </div>
                
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleGroupCollapse(group.folder.id);
                  }}
                  className={cn(
                    "p-1 rounded text-neutral-500 hover:text-neutral-300 hover:bg-white/10 transition-all shrink-0",
                    isCollapsed ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  title={isCollapsed ? "Expand folder" : "Collapse folder"}
                >
                  {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                </button>
              </div>
              
              {/* Group Assets */}
              {!isCollapsed && group.assets.length > 0 && (
                <div className={cn(
                  state.viewMode === 'grid' 
                    ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4 px-1"
                    : "flex flex-col gap-1 px-1"
                )}>
                  {/* Limit assets per group for safety if they are massive */}
                  {group.assets.slice(0, 500).map(asset => {
                    const isAssetSelected = state.selectedItems.some(i => i.type === 'asset' && i.id === asset.id);
                    
                    if (state.viewMode === 'list') {
                      return (
                        <div 
                          key={asset.id}
                          onClick={(e) => handleAssetClick(e, asset.id)}
                          onContextMenu={(e) => onContextMenuAsset(e, asset.id)}
                          className={cn(
                            "flex items-center gap-4 px-3 py-2 rounded-md cursor-pointer transition-colors border border-transparent",
                            isAssetSelected ? "bg-blue-500/10 border-blue-500/30" : "hover:bg-white/5"
                          )}
                        >
                          <div className="w-8 h-8 flex items-center justify-center shrink-0 rounded overflow-hidden bg-[#111]">
                            {(() => {
                              const thumbUrl = asset.thumbnailUrl || thumbnails[asset.id];
                              if (thumbUrl) {
                                return <img src={thumbUrl} alt="" className="w-full h-full object-cover" />;
                              }
                              ensureThumbnail(asset);
                              return getAssetIcon(asset.type);
                            })()}
                          </div>
                          <div className="flex-1 truncate text-sm text-neutral-200">{asset.name}</div>
                          <div className="w-24 text-right text-xs text-neutral-500 shrink-0">{formatBytes(asset.size)}</div>
                          <div className="w-32 text-right text-xs text-neutral-500 truncate shrink-0">{asset.dateModified.split('T')[0]}</div>
                        </div>
                      );
                    }

                    // Grid View
                    return (
                      <div 
                        key={asset.id}
                        onClick={(e) => handleAssetClick(e, asset.id)}
                        onContextMenu={(e) => onContextMenuAsset(e, asset.id)}
                        className={cn(
                          "group relative rounded-lg overflow-hidden border cursor-pointer transition-all duration-200 bg-[#1e1e1e] flex flex-col",
                          isAssetSelected 
                            ? "border-blue-500 ring-1 ring-blue-500 shadow-[0_0_0_1px_rgba(59,130,246,0.5)]" 
                            : "border-neutral-800 hover:border-neutral-600 hover:bg-[#252525]"
                        )}
                      >
                        <div className="aspect-square bg-[#111] relative flex items-center justify-center overflow-hidden">
                          {/* Top Right File Format */}
                          <div className="absolute top-2 right-2 z-10 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-[10px] font-bold text-white/90 uppercase tracking-wider">
                            {asset.type}
                          </div>

                          {/* 缩略图懒加载：优先使用 asset.thumbnailUrl（数据库缓存），
                              未命中时调用 ensureThumbnail 触发 Rust 后端生成 */}
                          {(() => {
                            const thumbUrl = asset.thumbnailUrl || thumbnails[asset.id];
                            if (thumbUrl) {
                              return (
                                <img 
                                  src={thumbUrl} 
                                  alt={asset.name} 
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                  loading="lazy"
                                />
                              );
                            }
                            // 异步触发懒加载（非阻塞），由 ensureThumbnail 内部防重
                            ensureThumbnail(asset);
                            return (
                              <div className="transform transition-transform duration-300 group-hover:scale-110">
                                {loadingThumbnails.has(asset.id)
                                  ? <Loader2 size={24} className="animate-spin text-neutral-500" />
                                  : getAssetIcon(asset.type)
                                }
                              </div>
                            );
                          })()}
                          
                          {/* Bottom Left Tags */}
                          {asset.tags.length > 0 && (
                            <div className="absolute bottom-2 left-2 z-10 flex gap-1">
                              {asset.tags.map(tid => {
                                const tag = state.tags.find(t => t.id === tid);
                                if (!tag) return null;
                                return <div key={tid} className="w-2.5 h-2.5 rounded-full ring-1 ring-black/50" style={{ backgroundColor: tag.color }} title={tag.name} />
                              })}
                            </div>
                          )}

                          {/* Bottom Right Collections */}
                          {asset.collections.length > 0 && (
                            <div className="absolute bottom-2 right-2 z-10 flex gap-1">
                              {asset.collections.map(cid => {
                                const col = state.collections.find(c => c.id === cid);
                                if (!col) return null;
                                return (
                                  <div key={cid} className="bg-black/60 backdrop-blur-md p-1 rounded shadow-sm flex items-center justify-center" title={col.name}>
                                    <Layers size={10} className="text-amber-500" />
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          <div className={cn(
                            "absolute inset-0 transition-opacity pointer-events-none",
                            isAssetSelected ? "bg-blue-500/10" : "bg-transparent group-hover:bg-white/5"
                          )} />
                        </div>
                        
                        <div className="p-3 flex-1 flex flex-col justify-between">
                          <div className="text-sm font-medium text-neutral-200 truncate" title={asset.name}>
                            {asset.name}
                          </div>
                          <div className="flex items-center justify-between mt-1 text-xs text-neutral-500">
                            <span className="truncate pr-2">{formatBytes(asset.size)}</span>
                            <span className="shrink-0">{asset.dateModified.split('T')[0]}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {group.assets.length > 500 && (
                    <div className="col-span-full py-4 text-center text-xs text-neutral-500 border border-dashed border-neutral-800 rounded-lg">
                      + {group.assets.length - 500} more items hidden for performance.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {groups.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-neutral-500">
            <Box size={48} className="mb-4 opacity-30" />
            <p className="text-lg font-medium text-neutral-400">No content found</p>
            <p className="text-sm max-w-sm text-center mt-2">
              Try adjusting your filters, selecting a different folder, or enabling "Include Subfolders".
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
