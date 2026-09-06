import React from 'react';
import { List, LayoutGrid, FolderOpen, Layers, CheckSquare, FolderPlus, Tag as TagIcon, RefreshCw } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';
import type { AssetState } from '../../types';

interface CanvasMenuParams {
  state: AssetState;
  onToggleView: () => void;
  onToggleGroupByFolder: () => void;
  onToggleIncludeSubfolders: () => void;
  onClearSelection: () => void;
  onSelectAll: () => void;
  onScanLocalFolder: () => void;
  onCreateTag: () => void;
  onCreateCollection: () => void;
  onRefresh: () => void;
}

export function buildCanvasContextMenu({
  state,
  onToggleView,
  onToggleGroupByFolder,
  onToggleIncludeSubfolders,
  onClearSelection,
  onSelectAll,
  onScanLocalFolder,
  onCreateTag,
  onCreateCollection,
  onRefresh,
}: CanvasMenuParams): ContextMenuItem[] {
  return [
    {
      label: state.viewMode === 'grid' ? '切换为列表视图' : '切换为网格视图',
      icon: state.viewMode === 'grid' ? <List size={14} /> : <LayoutGrid size={14} />,
      onClick: onToggleView
    },
    {
      label: state.groupByFolder ? '取消按文件夹分组' : '开启按文件夹分组',
      icon: <FolderOpen size={14} />,
      onClick: onToggleGroupByFolder
    },
    {
      label: state.includeSubfolders ? '仅显示当前层级素材' : '包含所有子目录素材',
      icon: <Layers size={14} />,
      onClick: onToggleIncludeSubfolders
    },
    { divider: true, label: '' },
    {
      label: state.selectedItems.length > 0 ? '取消全选素材' : '全选所有素材',
      icon: <CheckSquare size={14} />,
      onClick: () => {
        if (state.selectedItems.length > 0) {
          onClearSelection();
        } else {
          onSelectAll();
        }
      }
    },
    { divider: true, label: '' },
    { label: '添加本地监视文件夹', icon: <FolderPlus size={14} />, onClick: onScanLocalFolder },
    { label: '新建标签', icon: <TagIcon size={14} />, onClick: onCreateTag },
    { label: '新建集合', icon: <Layers size={14} />, onClick: onCreateCollection },
    { label: '刷新数据', icon: <RefreshCw size={14} />, onClick: onRefresh }
  ];
}
