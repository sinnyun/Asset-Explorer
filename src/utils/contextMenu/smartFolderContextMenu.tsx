import React from 'react';
import { Info, Pin, ArrowUp, ArrowDown, Edit2, Trash2 } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';
import type { SmartFolder } from '../../types';

interface CustomSmartFolderMenuParams {
  customSf: SmartFolder;
  onViewProperties: () => void;
  onTogglePin: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function buildCustomSmartFolderContextMenu({
  customSf,
  onViewProperties,
  onTogglePin,
  onMoveUp,
  onMoveDown,
  onRename,
  onDelete,
}: CustomSmartFolderMenuParams): ContextMenuItem[] {
  return [
    { label: '查看/编辑属性与规则', icon: <Info size={14}/>, onClick: onViewProperties },
    { label: customSf.isPinned ? '取消置顶' : '置顶智能文件夹', icon: <Pin size={14}/>, onClick: onTogglePin },
    { label: '上移一位', icon: <ArrowUp size={14}/>, onClick: onMoveUp },
    { label: '下移一位', icon: <ArrowDown size={14}/>, onClick: onMoveDown },
    { divider: true, label: '' },
    { label: '重命名智能文件夹', icon: <Edit2 size={14}/>, onClick: onRename },
    { divider: true, label: '' },
    { label: '删除智能文件夹', danger: true, icon: <Trash2 size={14}/>, onClick: onDelete },
  ];
}

interface BuiltInSmartFolderMenuParams {
  builtInSf: SmartFolder;
  onViewProperties: () => void;
  onTogglePin: () => void;
}

export function buildBuiltInSmartFolderContextMenu({
  builtInSf,
  onViewProperties,
  onTogglePin,
}: BuiltInSmartFolderMenuParams): ContextMenuItem[] {
  return [
    { label: '查看/编辑属性与统计', icon: <Info size={14}/>, onClick: onViewProperties },
    { label: builtInSf.isPinned ? '取消置顶' : '置顶智能文件夹', icon: <Pin size={14}/>, onClick: onTogglePin },
  ];
}
