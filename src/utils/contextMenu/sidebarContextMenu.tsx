import React from 'react';
import { Plus, FolderPlus, Tag as TagIcon, Layers, Info } from 'lucide-react';
import type { ContextMenuItem } from '../../components/ContextMenu';

interface SidebarMenuParams {
  onCreateSmartFolder: () => void;
  onScanLocalFolder: () => void;
  onCreateTag: () => void;
  onCreateCollection: () => void;
  onOpenSettings: () => void;
}

export function buildSidebarContextMenu({
  onCreateSmartFolder,
  onScanLocalFolder,
  onCreateTag,
  onCreateCollection,
  onOpenSettings,
}: SidebarMenuParams): ContextMenuItem[] {
  return [
    { label: '新建智能文件夹', icon: <Plus size={14} />, onClick: onCreateSmartFolder },
    { label: '添加本地监视文件夹', icon: <FolderPlus size={14} />, onClick: onScanLocalFolder },
    { label: '新建标签', icon: <TagIcon size={14} />, onClick: onCreateTag },
    { label: '新建集合', icon: <Layers size={14} />, onClick: onCreateCollection },
    { divider: true, label: '' },
    { label: '偏好设置', icon: <Info size={14} />, onClick: onOpenSettings }
  ];
}
