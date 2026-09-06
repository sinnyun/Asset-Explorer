import React from 'react';
import { Info, Pin, ArrowUp, ArrowDown, Edit2, Trash2 } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';
import type { Tag } from '../../types';

interface TagMenuParams {
  tag: Tag;
  onViewProperties: () => void;
  onTogglePin: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function buildTagContextMenu({
  tag,
  onViewProperties,
  onTogglePin,
  onMoveUp,
  onMoveDown,
  onRename,
  onDelete,
}: TagMenuParams): ContextMenuItem[] {
  return [
    { label: '查看/编辑标签属性', icon: <Info size={14}/>, onClick: onViewProperties },
    { label: tag.isPinned ? '取消置顶' : '置顶标签', icon: <Pin size={14}/>, onClick: onTogglePin },
    { label: '上移一位', icon: <ArrowUp size={14}/>, onClick: onMoveUp },
    { label: '下移一位', icon: <ArrowDown size={14}/>, onClick: onMoveDown },
    { divider: true, label: '' },
    { label: '重命名标签', icon: <Edit2 size={14}/>, onClick: onRename },
    { divider: true, label: '' },
    { label: '删除标签', danger: true, icon: <Trash2 size={14}/>, onClick: onDelete },
  ];
}
