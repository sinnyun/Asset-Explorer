import React, { useState, useMemo } from 'react';
import { 
  Folder as FolderIcon, FolderTree, ChevronRight, ChevronDown, 
  Search, Eye, HardDrive, Sparkles, Filter, ExternalLink,
  Layers, Box, Image as ImageIcon, Video, FileText, CheckCircle2
} from 'lucide-react';
import { Asset, Folder, SelectionItem } from '../types';
import { cn, formatBytes } from '../lib/utils';
import { openInWindowsExplorer } from '../services/desktopBridge';

interface MonitoredSplitViewProps {
  folders: Folder[];
  assets: Asset[];
  selectedItems: SelectionItem[];
  onToggleSelection: (id: string, type: 'asset' | 'folder', multi: boolean) => void;
  onContextMenuAsset: (e: React.MouseEvent, id: string) => void;
  onContextMenuFolder: (e: React.MouseEvent, id: string) => void;
  onSelectFolder: (id: string) => void;
}

export function MonitoredSplitView({
  folders,
  assets,
  selectedItems,
  onToggleSelection,
  onContextMenuAsset,
  onContextMenuFolder,
  onSelectFolder,
}: MonitoredSplitViewProps) {
  const [col1Search, setCol1Search] = useState('');
  const [col2Search, setCol2Search] = useState('');
  const [col1Expanded, setCol1Expanded] = useState<string[]>(['all']);
  const [col2Expanded, setCol2Expanded] = useState<string[]>(['all']);
  const [col1ActiveFolderId, setCol1ActiveFolderId] = useState<string | null>(null);
  const [col2ActiveFolderId, setCol2ActiveFolderId] = useState<string | null>(null);

  // 1. 提取所有被标记为监视的文件夹
  const monitoredRoots = useMemo(() => {
    return folders.filter(f => f.isMonitored);
  }, [folders]);

  // 2. 分析监视文件夹之间的层级嵌套关系 (Parent vs Child)
  const { parentMonitored, childMonitored } = useMemo(() => {
    if (monitoredRoots.length === 0) {
      // 降级兜底：以现有前两个根文件夹展示
      const roots = folders.filter(f => !f.parentId);
      return { parentMonitored: roots[0] || null, childMonitored: roots[1] || null };
    }
    if (monitoredRoots.length === 1) {
      // 只有一个监视目录时，寻找其内部的第一个主要子文件夹作为对照列
      const p = monitoredRoots[0];
      const sub = folders.find(f => f.parentId === p.id || f.path.startsWith(p.path + '/'));
      return { parentMonitored: p, childMonitored: sub || null };
    }

    // 两个或多个监视目录：判定是否有路径包含（嵌套）关系
    const f1 = monitoredRoots[0];
    const f2 = monitoredRoots[1];

    const p1 = f1.path.toLowerCase().replace(/[/\\]+$/, '');
    const p2 = f2.path.toLowerCase().replace(/[/\\]+$/, '');

    if (p2.startsWith(p1 + '/') || p2.startsWith(p1 + '\\')) {
      // f1 是父，f2 是嵌套子项目
      return { parentMonitored: f1, childMonitored: f2 };
    } else if (p1.startsWith(p2 + '/') || p1.startsWith(p2 + '\\')) {
      // f2 是父，f1 是嵌套子项目
      return { parentMonitored: f2, childMonitored: f1 };
    }

    // 两个互相独立的监视目录
    return { parentMonitored: f1, childMonitored: f2 };
  }, [monitoredRoots, folders]);

  // 判断是否具备嵌套关系
  const isNested = useMemo(() => {
    if (!parentMonitored || !childMonitored) return false;
    const p = parentMonitored.path.toLowerCase().replace(/[/\\]+$/, '');
    const c = childMonitored.path.toLowerCase().replace(/[/\\]+$/, '');
    return c.startsWith(p + '/') || c.startsWith(p + '\\') || childMonitored.parentId === parentMonitored.id;
  }, [parentMonitored, childMonitored]);

  // 获取属于指定文件夹（及其递归子文件夹）的全部资产
  const getSubtreeFolderIds = (rootFolderId: string): string[] => {
    const result: string[] = [rootFolderId];
    const queue: string[] = [rootFolderId];
    while (queue.length > 0) {
      const curId = queue.shift()!;
      const children = folders.filter(f => f.parentId === curId);
      for (const ch of children) {
        result.push(ch.id);
        queue.push(ch.id);
      }
    }
    return result;
  };

  const col1FolderIds = useMemo(() => {
    return parentMonitored ? getSubtreeFolderIds(parentMonitored.id) : [];
  }, [parentMonitored, folders]);

  const col2FolderIds = useMemo(() => {
    return childMonitored ? getSubtreeFolderIds(childMonitored.id) : [];
  }, [childMonitored, folders]);

  // 分列 1 资产 (根据搜索与选中子文件夹过滤)
  const col1Assets = useMemo(() => {
    const targetFolderIds = col1ActiveFolderId ? [col1ActiveFolderId] : col1FolderIds;
    return assets.filter(a => {
      const matchFolder = targetFolderIds.includes(a.folderId);
      const matchSearch = col1Search ? a.name.toLowerCase().includes(col1Search.toLowerCase()) : true;
      return matchFolder && matchSearch;
    });
  }, [assets, col1FolderIds, col1ActiveFolderId, col1Search]);

  // 分列 2 资产 (根据搜索与选中子文件夹过滤)
  const col2Assets = useMemo(() => {
    const targetFolderIds = col2ActiveFolderId ? [col2ActiveFolderId] : col2FolderIds;
    return assets.filter(a => {
      const matchFolder = targetFolderIds.includes(a.folderId);
      const matchSearch = col2Search ? a.name.toLowerCase().includes(col2Search.toLowerCase()) : true;
      return matchFolder && matchSearch;
    });
  }, [assets, col2FolderIds, col2ActiveFolderId, col2Search]);

  const toggleCol1Expand = (id: string) => {
    setCol1Expanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleCol2Expand = (id: string) => {
    setCol2Expanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const renderTree = (
    rootId: string, 
    level: number, 
    expandedList: string[], 
    toggleExpand: (id: string) => void,
    activeId: string | null,
    setActiveId: (id: string | null) => void
  ) => {
    const folder = folders.find(f => f.id === rootId);
    if (!folder) return null;

    const children = folders.filter(f => f.parentId === rootId);
    const hasChildren = children.length > 0;
    const isExpanded = expandedList.includes('all') || expandedList.includes(rootId);
    const isSelected = activeId === rootId;

    return (
      <div key={folder.id} className="space-y-0.5">
        <div 
          onClick={() => setActiveId(isSelected ? null : folder.id)}
          className={cn(
            "flex items-center gap-1.5 py-1 px-2 rounded-md text-xs cursor-pointer transition-colors group",
            isSelected ? "bg-blue-500/20 text-blue-300 font-medium" : "text-neutral-300 hover:bg-neutral-800"
          )}
          style={{ paddingLeft: `${level * 14 + 8}px` }}
        >
          {hasChildren ? (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleExpand(rootId); }}
              className="p-0.5 hover:bg-white/10 rounded text-neutral-400"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3" />
          )}
          <FolderIcon size={14} className={isSelected ? "text-blue-400" : "text-amber-500/80"} />
          <span className="truncate flex-1">{folder.name}</span>
          {folder.isMonitored && (
            <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">监视</span>
          )}
        </div>
        {hasChildren && isExpanded && (
          <div className="space-y-0.5">
            {children.map(ch => renderTree(ch.id, level + 1, expandedList, toggleExpand, activeId, setActiveId))}
          </div>
        )}
      </div>
    );
  };

  const getAssetIcon = (type: string) => {
    switch (type) {
      case 'image': return <ImageIcon size={18} className="text-blue-400" />;
      case 'video': return <Video size={18} className="text-purple-400" />;
      case 'model': return <Box size={18} className="text-amber-400" />;
      default: return <FileText size={18} className="text-neutral-400" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#141414] select-none">
      
      {/* Top Banner Explaining Monitored Dual-Column Relationship */}
      <div className="px-6 py-3 border-b border-neutral-800 bg-[#181818] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Layers size={16} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-neutral-200">本地监视文件夹双分列独立对比视图</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                {isNested ? '已自动识别父子嵌套层级' : '独立双工作区并行监视'}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 mt-0.5">
              左列呈现父级工作区完整树形结构与全部素材；右列单独展示嵌套子项目，两者各自独立浏览与操作。
            </p>
          </div>
        </div>

        <div className="text-xs text-neutral-400 flex items-center gap-2">
          <span>总计监视资产:</span>
          <span className="font-mono font-semibold text-white">
            {col1Assets.length + col2Assets.length} 项
          </span>
        </div>
      </div>

      {/* Dual Column Container */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-px bg-neutral-800 overflow-hidden">
        
        {/* ================================================================= */}
        {/* COLUMN 1: 父级工作区监视文件夹 (Parent Workspace Column) */}
        {/* ================================================================= */}
        <div className="bg-[#181818] flex flex-col overflow-hidden h-full">
          
          {/* Col 1 Header */}
          <div className="p-4 border-b border-neutral-800 bg-[#1e1e1e] shrink-0 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive size={16} className="text-blue-400" />
                <span className="font-semibold text-sm text-white truncate max-w-[220px]">
                  {parentMonitored ? parentMonitored.name : '父级工作区'}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
                  分列 1 · 父工作区
                </span>
              </div>
              <span className="text-xs font-mono text-neutral-400">
                {col1Assets.length} 个资产
              </span>
            </div>

            <div className="text-[11px] font-mono text-neutral-400 truncate" title={parentMonitored?.path}>
              路径: {parentMonitored?.path || '未指定路径'}
            </div>

            {/* Col 1 Search */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2 text-neutral-500" />
              <input
                type="text"
                value={col1Search}
                onChange={(e) => setCol1Search(e.target.value)}
                placeholder="在父工作区内搜索素材..."
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-3 text-xs text-neutral-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Col 1 Body: Folder Tree & Assets */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            
            {/* Complete Folder Tree */}
            <div className="bg-[#141414] border border-neutral-800 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400 font-semibold px-1">
                <span className="flex items-center gap-1.5">
                  <FolderTree size={13} className="text-blue-400" />
                  <span>完整父子目录继承树</span>
                </span>
                {col1ActiveFolderId && (
                  <button 
                    onClick={() => setCol1ActiveFolderId(null)}
                    className="text-[11px] text-blue-400 hover:underline"
                  >
                    查看全部子目录素材
                  </button>
                )}
              </div>
              <div className="pt-1">
                {parentMonitored && renderTree(
                  parentMonitored.id, 
                  0, 
                  col1Expanded, 
                  toggleCol1Expand, 
                  col1ActiveFolderId, 
                  setCol1ActiveFolderId
                )}
              </div>
            </div>

            {/* Assets Grid for Col 1 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400 px-1">
                <span>素材列表 ({col1Assets.length}):</span>
              </div>

              {col1Assets.length === 0 ? (
                <div className="text-center py-10 text-neutral-500 text-xs bg-[#141414] rounded-lg border border-neutral-800/60">
                  当前目录下暂无资产
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {col1Assets.map(asset => {
                    const isSelected = selectedItems.some(i => i.id === asset.id);
                    return (
                      <div
                        key={asset.id}
                        onClick={(e) => onToggleSelection(asset.id, 'asset', e.ctrlKey || e.metaKey)}
                        onContextMenu={(e) => onContextMenuAsset(e, asset.id)}
                        className={cn(
                          "group rounded-lg border p-2 bg-[#141414] cursor-pointer transition-all hover:border-neutral-700 relative flex flex-col",
                          isSelected ? "border-blue-500 ring-1 ring-blue-500/50 bg-blue-500/5" : "border-neutral-800"
                        )}
                      >
                        <div className="w-full aspect-video bg-[#1e1e1e] rounded flex items-center justify-center overflow-hidden mb-1.5 relative">
                          {asset.thumbnailUrl ? (
                            <img 
                              src={asset.thumbnailUrl} 
                              alt={asset.name} 
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform" 
                            />
                          ) : (
                            getAssetIcon(asset.type)
                          )}
                          <span className="absolute bottom-1 right-1 text-[9px] font-mono px-1 py-0.2 rounded bg-black/70 text-neutral-300">
                            {formatBytes(asset.size)}
                          </span>
                        </div>
                        <span className="text-xs font-medium text-neutral-200 truncate" title={asset.name}>
                          {asset.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ================================================================= */}
        {/* COLUMN 2: 嵌套独立子项目监视文件夹 (Child Project Column) */}
        {/* ================================================================= */}
        <div className="bg-[#181818] flex flex-col overflow-hidden h-full">
          
          {/* Col 2 Header */}
          <div className="p-4 border-b border-neutral-800 bg-[#1e1e1e] shrink-0 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-purple-400" />
                <span className="font-semibold text-sm text-white truncate max-w-[220px]">
                  {childMonitored ? childMonitored.name : '独立子项目'}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-medium">
                  {isNested ? '分列 2 · 嵌套子项目' : '分列 2 · 独立工作区'}
                </span>
              </div>
              <span className="text-xs font-mono text-neutral-400">
                {col2Assets.length} 个资产
              </span>
            </div>

            <div className="text-[11px] font-mono text-neutral-400 truncate" title={childMonitored?.path}>
              路径: {childMonitored?.path || '未指定路径'}
            </div>

            {/* Col 2 Search */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2 text-neutral-500" />
              <input
                type="text"
                value={col2Search}
                onChange={(e) => setCol2Search(e.target.value)}
                placeholder="在独立子项目中搜索素材..."
                className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-3 text-xs text-neutral-200 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>

          {/* Col 2 Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            
            {/* Child Project Subtree */}
            <div className="bg-[#141414] border border-neutral-800 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400 font-semibold px-1">
                <span className="flex items-center gap-1.5">
                  <FolderTree size={13} className="text-purple-400" />
                  <span>子项目专属目录树</span>
                </span>
                {col2ActiveFolderId && (
                  <button 
                    onClick={() => setCol2ActiveFolderId(null)}
                    className="text-[11px] text-purple-400 hover:underline"
                  >
                    查看全部子项目素材
                  </button>
                )}
              </div>
              <div className="pt-1">
                {childMonitored ? (
                  renderTree(
                    childMonitored.id, 
                    0, 
                    col2Expanded, 
                    toggleCol2Expand, 
                    col2ActiveFolderId, 
                    setCol2ActiveFolderId
                  )
                ) : (
                  <div className="text-neutral-500 text-xs py-4 text-center">
                    未检测到第二个监视项目，请在左侧点击「添加监视文件夹」
                  </div>
                )}
              </div>
            </div>

            {/* Assets Grid for Col 2 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400 px-1">
                <span>专属素材列表 ({col2Assets.length}):</span>
              </div>

              {col2Assets.length === 0 ? (
                <div className="text-center py-10 text-neutral-500 text-xs bg-[#141414] rounded-lg border border-neutral-800/60">
                  {childMonitored ? '该项目下暂无资产' : '请先添加子项目监视目录'}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {col2Assets.map(asset => {
                    const isSelected = selectedItems.some(i => i.id === asset.id);
                    return (
                      <div
                        key={asset.id}
                        onClick={(e) => onToggleSelection(asset.id, 'asset', e.ctrlKey || e.metaKey)}
                        onContextMenu={(e) => onContextMenuAsset(e, asset.id)}
                        className={cn(
                          "group rounded-lg border p-2 bg-[#141414] cursor-pointer transition-all hover:border-neutral-700 relative flex flex-col",
                          isSelected ? "border-purple-500 ring-1 ring-purple-500/50 bg-purple-500/5" : "border-neutral-800"
                        )}
                      >
                        <div className="w-full aspect-video bg-[#1e1e1e] rounded flex items-center justify-center overflow-hidden mb-1.5 relative">
                          {asset.thumbnailUrl ? (
                            <img 
                              src={asset.thumbnailUrl} 
                              alt={asset.name} 
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform" 
                            />
                          ) : (
                            getAssetIcon(asset.type)
                          )}
                          <span className="absolute bottom-1 right-1 text-[9px] font-mono px-1 py-0.2 rounded bg-black/70 text-neutral-300">
                            {formatBytes(asset.size)}
                          </span>
                        </div>
                        <span className="text-xs font-medium text-neutral-200 truncate" title={asset.name}>
                          {asset.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}
