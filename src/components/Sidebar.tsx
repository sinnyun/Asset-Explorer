import React, { useState, useMemo } from 'react';
import { 
  LayoutGrid, Clock, Tag as TagIcon, Image as ImageIcon, Box, 
  Folder, FolderOpen, ChevronRight, ChevronDown, Hash, Layers, 
  Monitor, Filter, Search, Plus, Settings, FolderSearch, X, Trash2, Edit2,
  FolderPlus, Radio, Pin
} from 'lucide-react';
import { cn } from '../lib/utils';

import { AssetState, SmartFolder, SidebarTab } from '../types';

interface SidebarProps {
  state: AssetState;
  onChangeTab: (tab: SidebarTab) => void;
  onSelectSmartFolder: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onSelectTag: (id: string) => void;
  onSelectCollection: (id: string) => void;
  onToggleFolderExpand: (id: string) => void;
  onCreateSmartFolder: () => void;
  onCreateTag?: () => void;
  onCreateCollection?: () => void;
  onContextMenuFolder: (e: React.MouseEvent, id: string) => void;
  onContextMenuSmartFolder?: (e: React.MouseEvent, id: string) => void;
  onContextMenuTag: (e: React.MouseEvent, id: string) => void;
  onContextMenuCollection: (e: React.MouseEvent, id: string) => void;
  onContextMenuSidebar?: (e: React.MouseEvent) => void;
  onOpenSettings: () => void;
  onScanLocalFolder: () => void;
  smartFolders: SmartFolder[];
}

interface NavItemProps {
  key?: React.Key;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  indent?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  isPinned?: boolean;
  onToggleExpand?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function Sidebar({ 
  state, 
  onChangeTab, 
  onSelectSmartFolder, 
  onSelectFolder, 
  onSelectTag,
  onSelectCollection,
  onToggleFolderExpand,
  onCreateSmartFolder,
  onCreateTag,
  onCreateCollection,
  onContextMenuFolder,
  onContextMenuSmartFolder,
  onContextMenuTag,
  onContextMenuCollection,
  onContextMenuSidebar,
  onOpenSettings,
  onScanLocalFolder,
  smartFolders 
}: SidebarProps) {

  const [folderSearch, setFolderSearch] = useState('');
  const [smartSearch, setSmartSearch] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [colSearch, setColSearch] = useState('');

  // Precompute asset counts for tags, collections, and smart folders
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      for (const t of a.tags) {
        map.set(t, (map.get(t) || 0) + 1);
      }
    }
    return map;
  }, [state.assets]);

  const colCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      for (const c of a.collections) {
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    return map;
  }, [state.assets]);

  const smartCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const sf of smartFolders) {
      if (sf.filter) {
        map.set(sf.id, state.assets.filter(sf.filter).length);
      }
    }
    for (const csf of state.customSmartFolders) {
      if (csf.rules) {
        const count = state.assets.filter(asset => {
          if (csf.rules!.length === 0) return true;
          const matches = csf.rules!.map(rule => {
            if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
            if (rule.type === 'tag') {
              const tag = state.tags.find(t => t.name.toLowerCase().includes(rule.value.toLowerCase()));
              return tag ? asset.tags.includes(tag.id) : false;
            }
            if (rule.type === 'collection') {
              const col = state.collections.find(c => c.name.toLowerCase().includes(rule.value.toLowerCase()));
              return col ? asset.collections.includes(col.id) : false;
            }
            if (rule.type === 'type') return asset.type.toLowerCase() === rule.value.toLowerCase();
            return false;
          });
          return csf.matchAll ? matches.every(Boolean) : matches.some(Boolean);
        }).length;
        map.set(csf.id, count);
      }
    }
    return map;
  }, [state.assets, smartFolders, state.customSmartFolders, state.tags, state.collections]);

  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      map.set(a.folderId, (map.get(a.folderId) || 0) + 1);
    }
    return map;
  }, [state.assets]);

  const getSmartIcon = (name: string) => {
    switch (name) {
      case 'LayoutGrid': return <LayoutGrid size={16} className="text-blue-400" />;
      case 'Clock': return <Clock size={16} className="text-emerald-400" />;
      case 'Tag': return <TagIcon size={16} className="text-amber-400" />;
      case 'Image': return <ImageIcon size={16} className="text-purple-400" />;
      case 'Box': return <Box size={16} className="text-orange-400" />;
      case 'Search': return <Search size={16} className="text-cyan-400" />;
      default: return <Filter size={16} className="text-indigo-400" />;
    }
  };

  const NavItem = ({ 
    active, 
    onClick, 
    icon, 
    label, 
    count,
    indent = 0, 
    hasChildren = false, 
    isExpanded = false, 
    isPinned = false,
    onToggleExpand,
    onContextMenu
  }: NavItemProps) => (
    <div className="relative group" onContextMenu={onContextMenu}>
      {/* Indentation Guide Line */}
      {indent > 0 && (
        <div 
          className="absolute border-l border-neutral-700/50" 
          style={{ left: `${(indent - 1) * 12 + 20}px`, top: 0, bottom: 0 }}
        />
      )}
      
      <div
        className={cn(
          "w-full flex items-center px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer group/item",
          active ? "bg-blue-500/15 text-blue-400 font-medium" : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
        )}
        style={{ paddingLeft: `${indent * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button 
            onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
            className="w-4 h-4 flex items-center justify-center mr-1 text-neutral-500 hover:text-neutral-300 shrink-0 z-10"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <div className="w-4 mr-1 shrink-0" />
        )}
        
        <div 
          className="flex flex-1 items-center gap-2 overflow-hidden z-10 py-0.5"
          onClick={onClick}
        >
          <div className="shrink-0">{icon}</div>
          <span className="truncate flex-1 text-[13px]" title={label}>{label}</span>
          {isPinned && (
            <Pin size={11} className="text-amber-400 fill-amber-400/80 shrink-0" title="已置顶" />
          )}
          {count !== undefined && (
            <span className={cn(
              "text-[11px] px-1.5 py-0.2 rounded-full font-mono shrink-0 transition-colors",
              active ? "bg-blue-500/20 text-blue-300 font-medium" : "text-neutral-500 group-hover/item:text-neutral-400"
            )}>
              {count}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  const renderFolderTree = (parentId?: string, depth = 0) => {
    const children = state.folders
      .filter(f => f.parentId === parentId)
      .sort((a, b) => {
        if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
        return a.isPinned ? -1 : 1;
      });
    if (children.length === 0) return null;

    return children.map(folder => {
      const hasChildren = state.folders.some(f => f.parentId === folder.id);
      const isExpanded = state.expandedFolderIds.includes(folder.id);
      const directCount = folderCounts.get(folder.id);
      
      return (
        <div key={folder.id}>
          <NavItem 
            active={state.activeFolderId === folder.id}
            onClick={() => onSelectFolder(folder.id)}
            icon={isExpanded 
              ? <FolderOpen size={16} className={folder.isMonitored ? "text-blue-400" : "text-neutral-400"} />
              : <Folder size={16} className={folder.isMonitored ? "text-blue-400" : "text-neutral-400"} />
            }
            label={folder.name + (folder.isMonitored ? ' (监视)' : '')}
            count={directCount}
            indent={depth}
            hasChildren={hasChildren}
            isExpanded={isExpanded}
            isPinned={folder.isPinned}
            onToggleExpand={() => onToggleFolderExpand(folder.id)}
            onContextMenu={(e) => onContextMenuFolder(e, folder.id)}
          />
          {hasChildren && isExpanded && renderFolderTree(folder.id, depth + 1)}
        </div>
      );
    });
  };

  const renderFlatFolders = () => {
    const lowerSearch = folderSearch.toLowerCase();
    const matched = state.folders.filter(f => f.name.toLowerCase().includes(lowerSearch) || f.path.toLowerCase().includes(lowerSearch));
    const capped = matched.slice(0, 100);

    return (
      <div className="px-1">
        <div className="text-xs text-neutral-500 mb-2 px-1">Found {matched.length} folders</div>
        {capped.map(folder => (
          <div 
            key={folder.id}
            onClick={() => onSelectFolder(folder.id)}
            onContextMenu={(e) => onContextMenuFolder(e, folder.id)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer mb-0.5",
              state.activeFolderId === folder.id ? "bg-blue-500/10 text-blue-400" : "text-neutral-400 hover:bg-white/5"
            )}
          >
            <Folder size={14} className="shrink-0" />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-medium">{folder.name}</span>
              <span className="truncate text-[10px] opacity-70" title={folder.path}>{folder.path}</span>
            </div>
            {folderCounts.has(folder.id) && (
              <span className="text-[11px] font-mono text-neutral-500">{folderCounts.get(folder.id)}</span>
            )}
          </div>
        ))}
        {matched.length > 100 && (
          <div className="text-xs text-center py-2 text-neutral-500">Showing top 100 results...</div>
        )}
      </div>
    );
  };

  // Smart folders filtered list
  const filteredBuiltInSmartFolders = useMemo(() => {
    let list = smartFolders;
    if (smartSearch.trim()) {
      list = list.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
    }
    return [...list].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [smartFolders, smartSearch]);

  const filteredCustomSmartFolders = useMemo(() => {
    const nonHistory = state.customSmartFolders.filter(f => !f.isSearchHistory);
    let list = nonHistory;
    if (smartSearch.trim()) {
      list = list.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
    }
    return [...list].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.customSmartFolders, smartSearch]);

  const filteredSearchHistory = useMemo(() => {
    const history = state.customSmartFolders.filter(f => f.isSearchHistory);
    if (!smartSearch.trim()) return history;
    return history.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
  }, [state.customSmartFolders, smartSearch]);

  const sortedTags = useMemo(() => {
    const filtered = state.tags.filter(t => t.name.toLowerCase().includes(tagSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.tags, tagSearch]);

  const sortedCollections = useMemo(() => {
    const filtered = state.collections.filter(c => c.name.toLowerCase().includes(colSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.collections, colSearch]);

  const totalSmartFoldersCount = smartFolders.length + state.customSmartFolders.length;

  return (
    <div className="flex h-full w-72 flex-shrink-0 bg-[#1e1e1e] border-r border-neutral-800 select-none">
      
      {/* Column 1: Primary Navigation (Tabs: Workspace, Smart Folders, Tags, Collections) */}
      <div className="w-14 flex-shrink-0 bg-[#181818] border-r border-neutral-800 flex flex-col items-center py-4 gap-3">
        <button 
          onClick={() => onChangeTab('folders')}
          className={cn("p-2.5 rounded-lg transition-colors group relative", state.activeSidebarTab === 'folders' ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300")}
          title="Workspace Folders"
        >
          <Monitor size={20} />
          {state.activeSidebarTab === 'folders' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-500 rounded-r-full" />}
        </button>

        <button 
          onClick={() => onChangeTab('smart')}
          className={cn("p-2.5 rounded-lg transition-colors group relative", state.activeSidebarTab === 'smart' ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300")}
          title="Smart Folders"
        >
          <Filter size={20} />
          {state.activeSidebarTab === 'smart' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-500 rounded-r-full" />}
        </button>

        <button 
          onClick={() => onChangeTab('tags')}
          className={cn("p-2.5 rounded-lg transition-colors group relative", state.activeSidebarTab === 'tags' ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300")}
          title="Tags"
        >
          <Hash size={20} />
          {state.activeSidebarTab === 'tags' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-500 rounded-r-full" />}
        </button>

        <button 
          onClick={() => onChangeTab('collections')}
          className={cn("p-2.5 rounded-lg transition-colors group relative", state.activeSidebarTab === 'collections' ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300")}
          title="Collections"
        >
          <Layers size={20} />
          {state.activeSidebarTab === 'collections' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-500 rounded-r-full" />}
        </button>
      </div>

      {/* Column 2: Secondary Navigation (Content) */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[#1e1e1e]">
        {/* Header */}
        <div className="h-14 border-b border-neutral-800 flex items-center px-4 shrink-0 justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-200">
              {state.activeSidebarTab === 'folders' && 'Workspace'}
              {state.activeSidebarTab === 'smart' && 'Smart Folders'}
              {state.activeSidebarTab === 'tags' && 'Tags'}
              {state.activeSidebarTab === 'collections' && 'Collections'}
            </span>
            <span className="text-[11px] font-mono bg-neutral-800/80 text-neutral-400 px-1.5 py-0.5 rounded-full">
              {state.activeSidebarTab === 'folders' && state.folders.length}
              {state.activeSidebarTab === 'smart' && totalSmartFoldersCount}
              {state.activeSidebarTab === 'tags' && state.tags.length}
              {state.activeSidebarTab === 'collections' && state.collections.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {state.activeSidebarTab === 'folders' && (
              <button 
                onClick={onScanLocalFolder}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-300 hover:text-white bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 rounded-md transition-colors"
                title="添加并扫描本地监视文件夹"
              >
                <Plus size={13} />
                <span>添加监视</span>
              </button>
            )}
            {state.activeSidebarTab === 'smart' && (
              <button 
                onClick={onCreateSmartFolder}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/50 rounded-md transition-colors"
                title="New Smart Folder"
              >
                <Plus size={13} />
                <span>New</span>
              </button>
            )}
            {state.activeSidebarTab === 'tags' && onCreateTag && (
              <button 
                onClick={onCreateTag}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-300 hover:text-white bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 rounded-md transition-colors"
                title="添加标签"
              >
                <Plus size={13} />
                <span>新建标签</span>
              </button>
            )}
            {state.activeSidebarTab === 'collections' && onCreateCollection && (
              <button 
                onClick={onCreateCollection}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-300 hover:text-white bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-md transition-colors"
                title="添加集合"
              >
                <Plus size={13} />
                <span>新建集合</span>
              </button>
            )}
          </div>
        </div>

        {/* Search Bars - consistent across all sidebar tabs */}
        {state.activeSidebarTab === 'folders' && (
          <div className="p-3 border-b border-neutral-800/50 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 text-neutral-500" size={14} />
              <input 
                type="text"
                placeholder="Find folder..."
                value={folderSearch}
                onChange={(e) => setFolderSearch(e.target.value)}
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-7 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
              />
              {folderSearch && (
                <button 
                  onClick={() => setFolderSearch('')}
                  className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        {state.activeSidebarTab === 'smart' && (
          <div className="p-3 border-b border-neutral-800/50 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 text-neutral-500" size={14} />
              <input 
                type="text"
                placeholder="Find smart folder..."
                value={smartSearch}
                onChange={(e) => setSmartSearch(e.target.value)}
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-7 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
              />
              {smartSearch && (
                <button 
                  onClick={() => setSmartSearch('')}
                  className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        {state.activeSidebarTab === 'tags' && (
          <div className="p-3 border-b border-neutral-800/50 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 text-neutral-500" size={14} />
              <input 
                type="text"
                placeholder="Find tag..."
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-7 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
              />
              {tagSearch && (
                <button 
                  onClick={() => setTagSearch('')}
                  className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        {state.activeSidebarTab === 'collections' && (
          <div className="p-3 border-b border-neutral-800/50 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 text-neutral-500" size={14} />
              <input 
                type="text"
                placeholder="Find collection..."
                value={colSearch}
                onChange={(e) => setColSearch(e.target.value)}
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-7 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
              />
              {colSearch && (
                <button 
                  onClick={() => setColSearch('')}
                  className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Scrollable Content */}
        <div 
          className="flex-1 overflow-y-scroll p-2 custom-scrollbar"
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              onContextMenuSidebar?.(e);
            }
          }}
        >
          
          {/* Smart Folders Tab Content */}
          {state.activeSidebarTab === 'smart' && (
            <div className="space-y-3">
              {/* Built-in Smart Folders */}
              {filteredBuiltInSmartFolders.length > 0 && (
                <div>
                  <div className="flex items-center justify-between px-2 mb-1">
                    <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Built-in</span>
                    <span className="text-[10px] text-neutral-600 font-mono">{filteredBuiltInSmartFolders.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {filteredBuiltInSmartFolders.map(sf => (
                      <NavItem 
                        key={sf.id}
                        active={state.activeSmartFolderId === sf.id}
                        onClick={() => onSelectSmartFolder(sf.id)}
                        icon={getSmartIcon(sf.icon)}
                        label={sf.name}
                        count={smartCounts.get(sf.id)}
                        isPinned={sf.isPinned}
                        onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Custom Smart Folders */}
              {(filteredCustomSmartFolders.length > 0 || !smartSearch.trim()) && (
                <div>
                  <div className="flex items-center justify-between px-2 mb-1">
                    <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Custom</span>
                    <span className="text-[10px] text-neutral-600 font-mono">{filteredCustomSmartFolders.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {filteredCustomSmartFolders.map(sf => (
                      <NavItem 
                        key={sf.id}
                        active={state.activeSmartFolderId === sf.id}
                        onClick={() => onSelectSmartFolder(sf.id)}
                        icon={getSmartIcon(sf.icon)}
                        label={sf.name}
                        count={smartCounts.get(sf.id)}
                        isPinned={sf.isPinned}
                        onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)}
                      />
                    ))}

                    {filteredCustomSmartFolders.length === 0 && !smartSearch.trim() && (
                      <div className="px-2 py-2 text-xs text-neutral-500 italic">
                        No custom smart folders yet. Click New to create.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Recent Searches */}
              {filteredSearchHistory.length > 0 && (
                <div>
                  <div className="flex items-center justify-between px-2 mb-1">
                    <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Recent Searches</span>
                    <span className="text-[10px] text-neutral-600 font-mono">{filteredSearchHistory.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {filteredSearchHistory.map(sf => (
                      <NavItem 
                        key={sf.id}
                        active={state.activeSmartFolderId === sf.id}
                        onClick={() => onSelectSmartFolder(sf.id)}
                        icon={getSmartIcon(sf.icon)}
                        label={sf.name}
                        count={smartCounts.get(sf.id)}
                        isPinned={sf.isPinned}
                        onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Empty Search Result */}
              {filteredBuiltInSmartFolders.length === 0 && 
               filteredCustomSmartFolders.length === 0 && 
               filteredSearchHistory.length === 0 && (
                <div className="text-center py-8 text-neutral-500 space-y-2">
                  <Filter size={24} className="mx-auto opacity-30" />
                  <p className="text-xs">No smart folders match "{smartSearch}"</p>
                  <button
                    onClick={onCreateSmartFolder}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Create as new smart folder
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Workspace Folders Tab Content */}
          {state.activeSidebarTab === 'folders' && (
            <div className="space-y-0.5">
              {folderSearch.trim() === '' ? renderFolderTree(undefined, 0) : renderFlatFolders()}
            </div>
          )}

          {/* Tags Tab Content */}
          {state.activeSidebarTab === 'tags' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 py-1 mb-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">全部标签</span>
                <span className="text-[10px] text-neutral-500 font-mono">{sortedTags.length} / {state.tags.length}</span>
              </div>

              {onCreateTag && (
                <button
                  onClick={onCreateTag}
                  className="w-full mb-2 flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-colors"
                >
                  <Plus size={13} />
                  <span>添加新标签</span>
                </button>
              )}

              <div className="space-y-0.5">
                {sortedTags.map(tag => (
                  <NavItem 
                    key={tag.id}
                    active={state.activeTagId === tag.id}
                    onClick={() => onSelectTag(tag.id)}
                    icon={<Hash size={16} style={{ color: tag.color }} />}
                    label={tag.name}
                    count={tagCounts.get(tag.id)}
                    isPinned={tag.isPinned}
                    onContextMenu={(e) => onContextMenuTag(e, tag.id)}
                  />
                ))}
              </div>

              {sortedTags.length === 0 && (
                <div className="text-center py-8 text-neutral-500 text-xs">
                  {tagSearch ? '无匹配标签' : '暂无标签'}
                </div>
              )}
            </div>
          )}

          {/* Collections Tab Content */}
          {state.activeSidebarTab === 'collections' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 py-1 mb-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">全部集合</span>
                <span className="text-[10px] text-neutral-500 font-mono">{sortedCollections.length} / {state.collections.length}</span>
              </div>

              {onCreateCollection && (
                <button
                  onClick={onCreateCollection}
                  className="w-full mb-2 flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg transition-colors"
                >
                  <Plus size={13} />
                  <span>添加新集合</span>
                </button>
              )}

              <div className="space-y-0.5">
                {sortedCollections.map(collection => (
                  <NavItem 
                    key={collection.id}
                    active={state.activeCollectionId === collection.id}
                    onClick={() => onSelectCollection(collection.id)}
                    icon={<Layers size={16} className="text-amber-500" />}
                    label={collection.name}
                    count={colCounts.get(collection.id)}
                    isPinned={collection.isPinned}
                    onContextMenu={(e) => onContextMenuCollection(e, collection.id)}
                  />
                ))}
              </div>

              {sortedCollections.length === 0 && (
                <div className="text-center py-8 text-neutral-500 text-xs">
                  {colSearch ? '无匹配集合' : '暂无集合'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Actions */}
        <div className="p-3 border-t border-neutral-800/50 shrink-0 space-y-2">
          <button 
            onClick={onScanLocalFolder}
            className="w-full flex items-center justify-center gap-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 border border-blue-500/40 rounded-lg py-2 transition-colors shadow-lg shadow-blue-600/20"
          >
            <FolderPlus size={15} /> 添加本地监视文件夹
          </button>
          <button 
            onClick={onOpenSettings}
            className="w-full flex items-center justify-center gap-2 text-xs font-medium text-neutral-400 hover:text-white hover:bg-[#1e1e1e] rounded-md py-1.5 transition-colors"
          >
            <Settings size={14} /> 存储设置与系统迁移
          </button>
        </div>
      </div>
    </div>
  );
}
