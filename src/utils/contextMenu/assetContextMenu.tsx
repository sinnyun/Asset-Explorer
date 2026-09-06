import React from 'react';
import { Edit2, Trash2, ExternalLink, FolderOpen } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';
import type { Asset } from '../../types';

interface AssetMenuParams {
  asset: Asset;
  onRename: () => void;
  onOpenSource: () => void;
  onOpenInExplorer: () => void;
  onDelete: () => void;
}

export function buildAssetContextMenu({
  asset,
  onRename,
  onOpenSource,
  onOpenInExplorer,
  onDelete,
}: AssetMenuParams): ContextMenuItem[] {
  return [
    { label: '重命名', icon: <Edit2 size={14}/>, onClick: onRename },
    { label: '打开素材源文件', icon: <ExternalLink size={14}/>, onClick: onOpenSource },
    { label: '在资源管理器中定位', icon: <FolderOpen size={14}/>, onClick: onOpenInExplorer },
    { divider: true, label: '' },
    { label: '删除素材', danger: true, icon: <Trash2 size={14}/>, onClick: onDelete },
  ];
}
