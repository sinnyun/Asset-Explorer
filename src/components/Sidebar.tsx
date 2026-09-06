import React, { useState } from 'react';
import { Monitor, Filter, Plus, Settings, Hash, Layers, FolderPlus } from 'lucide-react';
import { cn } from '../lib/utils';
import { AssetState, SidebarTab, SmartFolder } from '../types';
import { NavItem, useSidebarData, renderFolderTree, renderFlatFolders, SearchBar, getSmartIcon } from './sidebar';

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

  const {
    tagCounts, colCounts, smartCounts, folderCounts,
    filteredBuiltInSmartFolders, filteredCustomSmartFolders,
    filteredSearchHistory, sortedTags, sortedCollections,
    totalSmartFoldersCount,
  } = useSidebarData(state, smartFolders, folderSearch, smartSearch, tagSearch, colSearch);

  // Primary navigation icons column
  const primaryNavItems: {tab: SidebarTab; icon: React.ReactNode; title: string}[] = [
    { tab: 'folders', icon: <Monitor size={20} />, title: 'Workspace Folders' },
    { tab: 'smart', icon: <Filter size={20} />, title: 'Smart Folders' },
    { tab: 'tags', icon: <Hash size={20} />, title: 'Tags' },
    { tab: 'collections', icon: <Layers size={20} />, title: 'Collections' },
  ];

  const activeLabel = {
    folders: 'Workspace',
    smart: 'Smart Folders',
    tags: 'Tags',
    collections: 'Collections'
  } as Record<SidebarTab, string>;

  const activeCount = {
    folders: state.folders.length,
    smart: totalSmartFoldersCount,
    tags: state.tags.length,
    collections: state.collections.length
  } as Record<SidebarTab, number>;

  const searchBarForTab = (tab: SidebarTab): React.ReactNode => {
    switch (tab) {
      case 'folders':
        return <SearchBar placeholder="Find folder..." value={folderSearch} onChange={setFolderSearch} />;
      case 'smart':
        return <SearchBar placeholder="Find smart folder..." value={smartSearch} onChange={setSmartSearch} />;
      case 'tags':
        return <SearchBar placeholder="Find tag..." value={tagSearch} onChange={setTagSearch} />;
      case 'collections':
        return <SearchBar placeholder="Find collection..." value={colSearch} onChange={setColSearch} />;
      default:
        return null;
    }
  };

  const tabActionButton = () => {
    const tab = state.activeSidebarTab;
    if (tab === 'folders') {
      return (
        <button 
          onClick={onScanLocalFolder}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-300 hover:text-white bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 rounded-md transition-colors"
          title="添加并扫描本地监视文件夹"
        >
          <Plus size={13} />
          <span>添加监视</span>
        </button>
      );
    }
    if (tab === 'smart') {
      return (
        <button 
          onClick={onCreateSmartFolder}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/50 rounded-md transition-colors"
          title="New Smart Folder"
        >
          <Plus size={13} />
          <span>New</span>
        </button>
      );
    }
    if (tab === 'tags' && onCreateTag) {
      return (
        <button 
          onClick={onCreateTag}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-300 hover:text-white bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 rounded-md transition-colors"
          title="添加标签"
        >
          <Plus size={13} />
          <span>新建标签</span>
        </button>
      );
    }
    if (tab === 'collections' && onCreateCollection) {
      return (
        <button 
          onClick={onCreateCollection}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-300 hover:text-white bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-md transition-colors"
          title="添加集合"
        >
          <Plus size={13} />
          <span>新建集合</span>
        </button>
      );
    }
    return null;
  };

  const renderTabContent = () => {
    const tab = state.activeSidebarTab;

    // Smart Folders content
    if (tab === 'smart') {
      return (
        <div className="space-y-3">
          {filteredBuiltInSmartFolders.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Built-in</span>
                <span className="text-[10px] text-neutral-600 font-mono">{filteredBuiltInSmartFolders.length}</span>
              </div>
              <div className="space-y-0.5">
                {filteredBuiltInSmartFolders.map(sf => (
                  <NavItem key={sf.id} active={state.activeSmartFolderId === sf.id}
                    onClick={() => onSelectSmartFolder(sf.id)} icon={getSmartIcon(sf.icon)}
                    label={sf.name} count={smartCounts.get(sf.id)} isPinned={sf.isPinned}
                    onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)} />
                ))}
              </div>
            </div>
          )}

          {(filteredCustomSmartFolders.length > 0 || !smartSearch.trim()) && (
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Custom</span>
                <span className="text-[10px] text-neutral-600 font-mono">{filteredCustomSmartFolders.length}</span>
              </div>
              <div className="space-y-0.5">
                {filteredCustomSmartFolders.map(sf => (
                  <NavItem key={sf.id} active={state.activeSmartFolderId === sf.id}
                    onClick={() => onSelectSmartFolder(sf.id)} icon={getSmartIcon(sf.icon)}
                    label={sf.name} count={smartCounts.get(sf.id)} isPinned={sf.isPinned}
                    onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)} />
                ))}
                {filteredCustomSmartFolders.length === 0 && !smartSearch.trim() && (
                  <div className="px-2 py-2 text-xs text-neutral-500 italic">No custom smart folders yet.</div>
                )}
              </div>
            </div>
          )}

          {filteredSearchHistory.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Recent Searches</span>
                <span className="text-[10px] text-neutral-600 font-mono">{filteredSearchHistory.length}</span>
              </div>
              <div className="space-y-0.5">
                {filteredSearchHistory.map(sf => (
                  <NavItem key={sf.id} active={state.activeSmartFolderId === sf.id}
                    onClick={() => onSelectSmartFolder(sf.id)} icon={getSmartIcon(sf.icon)}
                    label={sf.name} count={smartCounts.get(sf.id)} isPinned={sf.isPinned}
                    onContextMenu={(e) => onContextMenuSmartFolder?.(e, sf.id)} />
                ))}
              </div>
            </div>
          )}

          {filteredBuiltInSmartFolders.length === 0 && 
           filteredCustomSmartFolders.length === 0 && 
           filteredSearchHistory.length === 0 && (
            <div className="text-center py-8 text-neutral-500 space-y-2">
              <Filter size={24} className="mx-auto opacity-30" />
              <p className="text-xs">No smart folders match "{smartSearch}"</p>
              <button onClick={onCreateSmartFolder} className="text-xs text-blue-400 hover:text-blue-300">
                Create as new smart folder
              </button>
            </div>
          )}
        </div>
      );
    }

    // Workspace Folders content
    if (tab === 'folders') {
      return (
        <div className="space-y-0.5">
          {folderSearch.trim() === '' 
            ? renderFolderTree(state, folderCounts, onSelectFolder, onToggleFolderExpand, onContextMenuFolder)
            : renderFlatFolders(state, folderCounts, folderSearch, onSelectFolder, onContextMenuFolder)}
        </div>
      );
    }

    // Tags content
    if (tab === 'tags') {
      return (
        <div className="space-y-1">
          <div className="flex items-center justify-between px-2 py-1 mb-1">
            <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">全部标签</span>
            <span className="text-[10px] text-neutral-500 font-mono">{sortedTags.length} / {state.tags.length}</span>
          </div>
          {onCreateTag && (
            <button onClick={onCreateTag}
              className="w-full mb-2 flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-colors">
              <Plus size={13} />
              <span>添加新标签</span>
            </button>
          )}
          <div className="space-y-0.5">
            {sortedTags.map(tag => (
              <NavItem key={tag.id} active={state.activeTagId === tag.id}
                onClick={() => onSelectTag(tag.id)} icon={<Hash size={16} style={{ color: tag.color }} />}
                label={tag.name} count={tagCounts.get(tag.id)} isPinned={tag.isPinned}
                onContextMenu={(e) => onContextMenuTag(e, tag.id)} />
            ))}
          </div>
          {sortedTags.length === 0 && (
            <div className="text-center py-8 text-neutral-500 text-xs">{tagSearch ? '无匹配标签' : '暂无标签'}</div>
          )}
        </div>
      );
    }

    // Collections content
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between px-2 py-1 mb-1">
          <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">全部集合</span>
          <span className="text-[10px] text-neutral-500 font-mono">{sortedCollections.length} / {state.collections.length}</span>
        </div>
        {onCreateCollection && (
          <button onClick={onCreateCollection}
            className="w-full mb-2 flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg transition-colors">
            <Plus size={13} />
            <span>添加新集合</span>
          </button>
        )}
        <div className="space-y-0.5">
          {sortedCollections.map(collection => (
            <NavItem key={collection.id} active={state.activeCollectionId === collection.id}
              onClick={() => onSelectCollection(collection.id)} icon={<Layers size={16} className="text-amber-500" />}
              label={collection.name} count={colCounts.get(collection.id)} isPinned={collection.isPinned}
              onContextMenu={(e) => onContextMenuCollection(e, collection.id)} />
          ))}
        </div>
        {sortedCollections.length === 0 && (
          <div className="text-center py-8 text-neutral-500 text-xs">{colSearch ? '无匹配集合' : '暂无集合'}</div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full w-72 flex-shrink-0 bg-[#1e1e1e] border-r border-neutral-800 select-none">
      
      {/* Column 1: Primary Navigation */}
      <div className="w-14 flex-shrink-0 bg-[#181818] border-r border-neutral-800 flex flex-col items-center py-4 gap-3">
        {primaryNavItems.map(({ tab, icon, title }) => (
          <button key={tab} onClick={() => onChangeTab(tab)}
            className={cn("p-2.5 rounded-lg transition-colors group relative", state.activeSidebarTab === tab ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300")}
            title={title}>
            {icon}
            {state.activeSidebarTab === tab && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-500 rounded-r-full" />}
          </button>
        ))}
      </div>

      {/* Column 2: Content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[#1e1e1e]">
        {/* Header */}
        <div className="h-14 border-b border-neutral-800 flex items-center px-4 shrink-0 justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-200">{activeLabel[state.activeSidebarTab]}</span>
            <span className="text-[11px] font-mono bg-neutral-800/80 text-neutral-400 px-1.5 py-0.5 rounded-full">
              {activeCount[state.activeSidebarTab]}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {tabActionButton()}
          </div>
        </div>

        {/* Search Bars */}
        {searchBarForTab(state.activeSidebarTab)}

        {/* Scrollable Content */}
        <div 
          className="flex-1 overflow-y-scroll p-2 custom-scrollbar"
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              onContextMenuSidebar?.(e);
            }
          }}
        >
          {renderTabContent()}
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
