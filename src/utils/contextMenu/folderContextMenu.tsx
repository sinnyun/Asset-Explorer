import React from 'react';
import { Info, Pin, ArrowUp, ArrowDown, FolderOpen, Edit2, Trash2 } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';
import type { Folder } from '../../types';

interface FolderMenuParams {
  folder: Folder;
  onViewProperties: () => void;
  onTogglePin: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpenInExplorer: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function buildFolderContextMenu({
  folder,
  onViewProperties,
  onTogglePin,
  onMoveUp,
  onMoveDown,
  onOpenInExplorer,
  onRename,
  onDelete,
}: FolderMenuParams): ContextMenuItem[] {
  return [
    { label: '查看/编辑目录属性', icon: <Info size={14}/>, onClick: onViewProperties },
    { label: folder.isPinned ? '取消置顶' : '置顶文件夹', icon: <Pin size={14}/>, onClick: onTogglePin },
    { label: '在同级目录中上移', icon: <ArrowUp size={14}/>, onClick: onMoveUp },
    { label: '在同级目录中下移', icon: <ArrowDown size={14}/>, onClick: onMoveDown },
    { label: '打开资源管理器定位', icon: <FolderOpen size={14}/>, onClick: onOpenInExplorer },
    { divider: true, label: '' },
    { label: '重命名目录', icon: <Edit2 size={14}/>, onClick: onRename },
    { divider: true, label: '' },
    { label: '移除文件夹', danger: true, icon: <Trash2 size={14}/>, onClick: onDelete },
  ];
}
