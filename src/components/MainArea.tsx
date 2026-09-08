import React, { useState, useMemo, useRef, useLayoutEffect } from 'react';
import { Search, Filter, Grid, List, Image as ImageIcon, Video, Box, FileText, 
  Folder as FolderIcon, FolderTree, AlertTriangle, ChevronUp, ChevronDown, 
  Layers, Columns2, FolderPlus
} from 'lucide-react';
import { cn, formatBytes } from '../lib/utils';
import { Asset, AssetState, Folder, SortOption, Tag } from '../types';
import { MonitoredSplitView } from './MonitoredSplitView';
import { ThumbnailImage } from './ThumbnailImage';

/**
 * 智能自适应标签栏组件
 * - 根据实际容器可用物理方块宽度（像素）动态计算可容纳的标签胶囊
 * - 超出空间时自动折叠为 [+N] 胶囊，悬浮展示完整隐藏标签列表
 * - 严格单行（flex-nowrap + overflow-hidden），绝不破坏卡片或列表的统一高度
 */
function AdaptiveTagRow({ 
  tagIds, 
  tagMap, 
  maxRowWidth 
}: { 
  tagIds: string[]; 
  tagMap: Map<string, Tag>; 
  maxRowWidth?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(maxRowWidth || 0);

  useLayoutEffect(() => {
    if (maxRowWidth) {
      setContainerWidth(maxRowWidth);
      return;
    }
    if (!containerRef.current) return;
    
    const updateWidth = () => {
      if (containerRef.current) {
        const clientW = containerRef.current.clientWidth;
        if (clientW > 0) {
          setContainerWidth(clientW);
        }
      }
    };
    
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) {
            setContainerWidth(entry.contentRect.width);
          }
        }
      });
      ro.observe(containerRef.current);
      return () => ro.disconnect();
    }
  }, [maxRowWidth]);

  const { visibleTags, overflowCount, hiddenTagNames } = useMemo(() => {
    const validTags = tagIds
      .map(id => tagMap.get(id))
      .filter((t): t is Tag => Boolean(t));

    if (validTags.length === 0) {
      return { visibleTags: [], overflowCount: 0, hiddenTagNames: [] };
    }

    // 默认回退宽度（当容器尚未测量时提供合理的网格卡片宽度 ~170px）
    const targetWidth = containerWidth > 0 ? containerWidth : 170;
    const moreBadgeWidth = 32; // '+N' 胶囊的物理宽度预留
    const gap = 4; // gap-1 间距 4px

    let accumulatedWidth = 0;
    const visible: Tag[] = [];
    const hidden: string[] = [];

    for (let i = 0; i < validTags.length; i++) {
      const tag = validTags[i];
      // 精确估算每个标签胶囊的实际物理占用宽度：
      // 内边距 (12px) + 彩色指示点 (6px) + 间隙 (4px) + 字符宽度 (字符数 * ~6.8px) + 边框 (2px)
      const approxCharWidth = 6.8;
      const pillBaseOverhead = 24;
      const textWidth = Math.min(tag.name.length * approxCharWidth, 68);
      const tagPillWidth = Math.min(Math.max(pillBaseOverhead + textWidth, 38), 92);

      const hasRemaining = validTags.length - (i + 1) > 0;
      const reserveForMore = hasRemaining ? moreBadgeWidth + gap : 0;

      // 如果当前标签放得下，或者即使只有 1 个标签也至少展示首个截断标签
      if (accumulatedWidth + tagPillWidth + reserveForMore <= targetWidth || (visible.length === 0 && tagPillWidth <= targetWidth)) {
        visible.push(tag);
        accumulatedWidth += tagPillWidth + gap;
      } else {
        hidden.push(...validTags.slice(i).map(t => t.name));
        break;
      }
    }

    return {
      visibleTags: visible,
      overflowCount: validTags.length - visible.length,
      hiddenTagNames: hidden,
    };
  }, [tagIds, tagMap, containerWidth]);

  return (
    <div ref={containerRef} className="w-full flex items-center gap-1 overflow-hidden flex-nowrap">
      {visibleTags.map(tag => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-neutral-800/90 border border-neutral-700/60 text-neutral-300 text-[10px] truncate shrink-0 max-w-[90px] hover:border-neutral-500 hover:text-white transition-all shadow-xs"
          title={`标签: ${tag.name}`}
        >
          <span 
            className="w-1.5 h-1.5 rounded-full shrink-0 shadow-sm ring-1 ring-black/40" 
            style={{ backgroundColor: tag.color || '#3B82F6' }} 
          />
          <span className="truncate">{tag.name}</span>
        </span>
      ))}

      {overflowCount > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-neutral-800/90 border border-neutral-700/60 text-neutral-400 text-[9px] font-mono shrink-0 hover:text-neutral-200 transition-colors cursor-help"
          title={`折叠更多标签 (${overflowCount}):\n${hiddenTagNames.join('、')}`}
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
}

/** 每文件夹组最多渲染的资产数量（超出的折叠显示提示，避免 DOM 爆炸） */
const MAX_GROUPS_TO_RENDER = 100;

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
  onContextMenuCanvas?: (e: React.MouseEvent) => void;
  onSelectFolder?: (id: string) => void;
  onAddMonitoredFolder?: () => void;
  onPreviewAsset?: (asset: Asset) => void;
}

// ============================================================
// 排序比较器：预先定义为模块级函数，避免在渲染中频繁创建闭包
// ============================================================
function comparatorFor(option: SortOption): (a: Asset, b: Asset) => number {
  switch (option) {
    case 'name_asc': return (a, b) => a.name.localeCompare(b.name);
    case 'name_desc': return (a, b) => b.name.localeCompare(a.name);
    case 'date_modified_desc': return (a, b) => new Date(b.dateModified).getTime() - new Date(a.dateModified).getTime();
    case 'date_modified_asc': return (a, b) => new Date(a.dateModified).getTime() - new Date(b.dateModified).getTime();
    case 'size_desc': return (a, b) => b.size - a.size;
    case 'size_asc': return (a, b) => a.size - b.size;
    default: return (a, b) => a.name.localeCompare(b.name);
  }
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
  onContextMenuCanvas,
  onSelectFolder,
  onAddMonitoredFolder,
  onPreviewAsset
}: MainAreaProps) {
  
  const [localSearch, setLocalSearch] = useState('');
  const [isSplitMonitoredView, setIsSplitMonitoredView] = useState(false);

  // 映射字典，常数级快速查找标签和集合对象
  const tagMap = useMemo(() => new Map(state.tags.map(t => [t.id, t])), [state.tags]);
  const colMap = useMemo(() => new Map(state.collections.map(c => [c.id, c])), [state.collections]);

  const handleAssetClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onToggleSelection(id, 'asset', e.ctrlKey || e.metaKey);
  };

  const handleFolderClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onToggleSelection(id, 'folder', e.ctrlKey || e.metaKey);
  };

  const handleAssetDoubleClick = (asset: Asset) => {
    if (onPreviewAsset) onPreviewAsset(asset);
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

  // ============================================================
  // 优化：分组与排序计算全部放入 useMemo（避免每次重渲染都做 O(n log n) 操作）
  // 仅当 filteredAssets/filteredFolders/state.folders/state.sortOption
  // state.activeTagId/state.activeCollectionId 变化时才重算。
  // ============================================================
  const foldersById = useMemo(() => {
    const map = new Map<string, Folder>();
    for (const f of state.folders) map.set(f.id, f);
    return map;
  }, [state.folders]);

  const { groups, isTruncated } = useMemo(() => {
    const groupsMap = new Map<string, { folder: Folder, assets: Asset[] }>();
    
    // Collect folders from assets
    // 防御性去重：同一批次/状态中 asset.id 可能出现重复（增量扫描与文件监视事件并发时）
    // 先按 asset.id 去重，保证同一资产在同一分组内只渲染一次，避免 React key 冲突
    const seenAssetIds = new Set<string>();
    filteredAssets.forEach(a => {
      if (!a?.id || seenAssetIds.has(a.id)) return; // 跳过重复
      seenAssetIds.add(a.id);

      if (!groupsMap.has(a.folderId)) {
        const f = foldersById.get(a.folderId);
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

    // Sort assets inside each group using a pre-computed comparator
    allGroups.forEach(group => {
      group.assets.sort(comparatorFor(state.sortOption));
    });

    // Safeguard: Limit rendering to prevent DOM crash on massive data
    const isTruncated = allGroups.length > MAX_GROUPS_TO_RENDER;
    return {
      groups: allGroups.slice(0, MAX_GROUPS_TO_RENDER),
      isTruncated,
    };
  }, [filteredAssets, filteredFolders, foldersById, state.sortOption, state.activeTagId, state.activeCollectionId]);



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
          onPreviewAsset={onPreviewAsset}
        />
      ) : (
        /* Asset Canvas */
        <div className="flex-1 overflow-y-scroll p-6 custom-scrollbar relative" onContextMenu={(e) => onContextMenuCanvas?.(e)}>
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
                          onDoubleClick={() => handleAssetDoubleClick(asset)}
                          className={cn(
                            "flex items-center gap-4 px-3 py-2 rounded-md cursor-pointer transition-colors border border-transparent [content-visibility:auto] [contain-intrinsic-size:40px]",
                            isAssetSelected ? "bg-blue-500/10 border-blue-500/30" : "hover:bg-white/5"
                          )}
                        >
                          <div className="w-8 h-8 flex items-center justify-center shrink-0 rounded overflow-hidden bg-[#111]">
                            <ThumbnailImage
                              asset={asset}
                              className="w-full h-full object-cover"
                              fallbackIcon={getAssetIcon(asset.type)}
                            />
                          </div>
                          <div className="flex-1 min-w-0 flex items-center gap-3">
                            <span className="truncate text-sm text-neutral-200 font-medium max-w-[220px] shrink-0" title={asset.name}>
                              {asset.name}
                            </span>
                            
                            {/* 紧凑自适应胶囊栏：严格限制在单行内，宽度过长时自动折叠，不影响列表行高度 */}
                            <div className="hidden md:flex items-center gap-2 overflow-hidden flex-nowrap max-w-[360px] shrink-0">
                              {/* 集合徽章 */}
                              {asset.collections.length > 0 && (
                                <div className="flex items-center gap-1 shrink-0">
                                  {(() => {
                                    const firstCol = colMap.get(asset.collections[0]);
                                    if (!firstCol) return null;
                                    return (
                                      <span
                                        key={asset.collections[0]}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] font-medium max-w-[120px] truncate shadow-xs"
                                        title={`所属集合: ${asset.collections.map(id => colMap.get(id)?.name).filter(Boolean).join(', ')}`}
                                      >
                                        <Layers size={9} className="text-amber-400 shrink-0" />
                                        <span className="truncate">{firstCol.name}</span>
                                      </span>
                                    );
                                  })()}
                                  {asset.collections.length > 1 && (
                                    <span
                                      className="px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[9px] font-mono shrink-0"
                                      title={asset.collections.map(id => colMap.get(id)?.name).filter(Boolean).join(', ')}
                                    >
                                      +{asset.collections.length - 1}
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* 标签自适应单行 */}
                              {asset.tags.length > 0 && (
                                <div className="flex-1 min-w-0 max-w-[220px]">
                                  <AdaptiveTagRow tagIds={asset.tags} tagMap={tagMap} maxRowWidth={210} />
                                </div>
                              )}
                            </div>
                          </div>
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
                        onDoubleClick={() => handleAssetDoubleClick(asset)}
                        className={cn(
                          "group relative rounded-lg overflow-hidden border cursor-pointer transition-all duration-200 bg-[#1e1e1e] flex flex-col [content-visibility:auto] [contain-intrinsic-size:220px]",
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

                          {/* 缩略图懒加载：通过 ThumbnailImage 组件高效渲染，支持内存缓存与优雅降级 */}
                          <ThumbnailImage
                            asset={asset}
                            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            fallbackIcon={
                              <div className="transform transition-transform duration-300 group-hover:scale-110">
                                {getAssetIcon(asset.type)}
                              </div>
                            }
                          />
                          
                          {/* 缩略图左下角专属：归属集合徽章 (严格单行 + 自动折叠超额集合，绝不撑出画面) */}
                          {asset.collections.length > 0 && (
                            <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 pointer-events-none max-w-[85%] flex-nowrap">
                              {(() => {
                                const firstCol = colMap.get(asset.collections[0]);
                                if (!firstCol) return null;
                                return (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-md border border-amber-500/40 text-amber-300 text-[10px] font-medium shadow-md truncate shrink min-w-0"
                                    title={`所属集合: ${asset.collections.map(id => colMap.get(id)?.name).filter(Boolean).join(', ')}`}
                                  >
                                    <Layers size={10} className="text-amber-400 shrink-0" />
                                    <span className="truncate max-w-[95px]">{firstCol.name}</span>
                                  </span>
                                );
                              })()}
                              {asset.collections.length > 1 && (
                                <span
                                  className="px-1.5 py-0.5 rounded-md bg-black/80 backdrop-blur-md border border-amber-500/40 text-amber-300 text-[9px] font-mono shadow-md shrink-0"
                                  title={asset.collections.map(id => colMap.get(id)?.name).filter(Boolean).join(', ')}
                                >
                                  +{asset.collections.length - 1}
                                </span>
                              )}
                            </div>
                          )}

                          {/* 缩略图底部渐变阴影，保护徽章可读性 */}
                          {asset.collections.length > 0 && (
                            <div className="absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />
                          )}

                          <div className={cn(
                            "absolute inset-0 transition-opacity pointer-events-none",
                            isAssetSelected ? "bg-blue-500/10" : "bg-transparent group-hover:bg-white/5"
                          )} />
                        </div>
                        
                        {/* 卡片信息区：固定结构与统一高度（82px），彻底消除卡片大小跳动与高低不平 */}
                        <div className="p-2.5 flex flex-col justify-between h-[82px] shrink-0">
                          <div className="text-sm font-medium text-neutral-200 truncate group-hover:text-white transition-colors leading-snug" title={asset.name}>
                            {asset.name}
                          </div>

                          {/* 标签栏（根据实际可用物理宽度自适应折叠计算，严格单行无折行） */}
                          <div className="h-5 flex items-center overflow-hidden my-0.5">
                            {asset.tags.length > 0 ? (
                              <AdaptiveTagRow tagIds={asset.tags} tagMap={tagMap} />
                            ) : (
                              <div className="text-[10px] text-neutral-600/40 select-none flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-neutral-800" />
                                <span className="italic">无标签</span>
                              </div>
                            )}
                          </div>

                          {/* 底部元数据栏 */}
                          <div className="flex items-center justify-between text-[11px] text-neutral-500 pt-1 border-t border-neutral-800/60 mt-auto">
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
