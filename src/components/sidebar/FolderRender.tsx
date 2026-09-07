import React from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AssetState } from '../../types';
import { NavItem } from './NavItem';

/** 文件夹树最大渲染深度（超过则截断避免递归栈溢出） */
const MAX_FOLDER_DEPTH = 50;

interface FolderTreeNode {
  id: string;
  parentId?: string;
}

/**
 * 渲染文件夹树（优化版）
 *
 * 优化：
 * 1. 一次遍历构建 childrenMap，递归时 O(1) 查找子节点，替代原版对每个文件夹重复 filter(O(n))
 * 2. 限制最大递归深度，防止深层嵌套导致栈溢出
 * 3. 每次渲染先按 isPinned 排序子文件夹
 */
export function renderFolderTree(
  state: AssetState,
  folderCounts: Map<string, number>,
  onSelectFolder: (id: string) => void,
  onToggleFolderExpand: (id: string) => void,
  onContextMenuFolder: (e: React.MouseEvent, id: string) => void,
  parentId?: string,
  depth = 0
) {
  // 深度保护：超过 MAX_FOLDER_DEPTH 层不再向下渲染，避免递归栈溢出
  if (depth >= MAX_FOLDER_DEPTH) {
    return null;
  }

  // 一次遍历构建 父文件夹ID → 子文件夹列表 的映射
  const childrenMap = new Map<string, Array<typeof state.folders[0]>>();
  for (const f of state.folders) {
    const pid = f.parentId ?? '';
    const list = childrenMap.get(pid) || [];
    list.push(f);
    childrenMap.set(pid, list);
  }

  // 内部递归函数：使用预建的 childrenMap 查找子节点（O(1)）
  const renderNode = (
    currentParentId: string,
    currentDepth: number
  ): React.ReactNode => {
    if (currentDepth >= MAX_FOLDER_DEPTH) return null;
    const children = (childrenMap.get(currentParentId) || [])
      .sort((a, b) => {
        if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
        return a.isPinned ? -1 : 1;
      });
    if (children.length === 0) return null;

    return children.map(folder => {
      const hasChildren = (childrenMap.get(folder.id) || []).length > 0;
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
            indent={currentDepth}
            hasChildren={hasChildren}
            isExpanded={isExpanded}
            isPinned={folder.isPinned}
            onToggleExpand={() => onToggleFolderExpand(folder.id)}
            onContextMenu={(e) => onContextMenuFolder(e, folder.id)}
          />
          {hasChildren && isExpanded && renderNode(folder.id, currentDepth + 1)}
        </div>
      );
    });
  };

  // 从根（undefined/null）开始渲染
  return renderNode(parentId ?? '', depth);
}

export function renderFlatFolders(
  state: AssetState,
  folderCounts: Map<string, number>,
  folderSearch: string,
  onSelectFolder: (id: string) => void,
  onContextMenuFolder: (e: React.MouseEvent, id: string) => void
) {
  const lowerSearch = folderSearch.toLowerCase();
  const matched = state.folders.filter(f => 
    f.name.toLowerCase().includes(lowerSearch) || f.path.toLowerCase().includes(lowerSearch)
  );
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
}
