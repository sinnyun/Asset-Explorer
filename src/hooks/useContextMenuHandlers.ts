/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import type { AssetState, SmartFolder } from '../types';
import type { ContextMenuItem } from '../components/ContextMenu';
import { dataService } from '../services/dataService';
import { apiClient } from '../services/api';
import {
  buildAssetContextMenu,
  buildFolderContextMenu,
  buildTagContextMenu,
  buildCollectionContextMenu,
  buildCustomSmartFolderContextMenu,
  buildBuiltInSmartFolderContextMenu,
  buildCanvasContextMenu,
  buildSidebarContextMenu,
} from '../utils/contextMenu';

interface ContextMenuDeps {
  state: AssetState;
  filteredAssets: AssetState['assets'];
  smartFolders: SmartFolder[];
  setState: React.Dispatch<React.SetStateAction<AssetState>>;
  setContextMenu: React.Dispatch<React.SetStateAction<{x: number, y: number, items: ContextMenuItem[]} | null>>;
  setRenameModal: React.Dispatch<React.SetStateAction<{
    isOpen: boolean;
    title: string;
    initialValue: string;
    onConfirm: (newName: string) => void;
  }>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // Callbacks
  onSelectFolder: (id: string) => void;
  onSelectTag: (id: string) => void;
  onSelectCollection: (id: string) => void;
  onSelectSmartFolder: (id: string) => void;
  onChangeView: (mode: 'grid' | 'list') => void;
  onToggleGroupByFolder: () => void;
  onToggleIncludeSubfolders: () => void;
  onClearSelection: () => void;
  onScanLocalFolder: () => void;
  onCreateTag: () => void;
  onCreateCollection: () => void;
  onTogglePinFolder: (id: string) => void;
  onMoveFolder: (id: string, dir: 'up' | 'down') => void;
  onDeleteFolder: (id: string) => void;
  onUpdateFolder: (id: string, updates: Partial<import('../types').Folder>) => void;
  onTogglePinTag: (id: string) => void;
  onMoveTag: (id: string, dir: 'up' | 'down') => void;
  onDeleteTag: (id: string) => void;
  onUpdateTag: (id: string, updates: Partial<import('../types').Tag>) => void;
  onTogglePinCollection: (id: string) => void;
  onMoveCollection: (id: string, dir: 'up' | 'down') => void;
  onDeleteCollection: (id: string) => void;
  onUpdateCollection: (id: string, updates: Partial<import('../types').Collection>) => void;
  onTogglePinSmartFolder: (id: string) => void;
  onMoveSmartFolder: (id: string, dir: 'up' | 'down') => void;
  onDeleteSmartFolder: (id: string) => void;
  onUpdateSmartFolder: (id: string, updates: Partial<SmartFolder>) => void;
  onCreateSmartFolder: () => void;
}

/**
 * 右键菜单处理逻辑
 */
export function useContextMenuHandlers(deps: ContextMenuDeps) {
  const {
    state, filteredAssets, smartFolders, setState, setContextMenu, setRenameModal, setSettingsOpen,
    onSelectFolder, onSelectTag, onSelectCollection, onSelectSmartFolder,
    onChangeView, onToggleGroupByFolder, onToggleIncludeSubfolders,
    onClearSelection, onScanLocalFolder, onCreateTag, onCreateCollection,
    onTogglePinFolder, onMoveFolder, onDeleteFolder, onUpdateFolder,
    onTogglePinTag, onMoveTag, onDeleteTag, onUpdateTag,
    onTogglePinCollection, onMoveCollection, onDeleteCollection, onUpdateCollection,
    onTogglePinSmartFolder, onMoveSmartFolder, onDeleteSmartFolder, onUpdateSmartFolder,
    onCreateSmartFolder,
  } = deps;

  const handleContextMenuAsset = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const asset = state.assets.find(a => a.id === id);
    if (!asset) return;
    
    if (!state.selectedItems.some(i => i.type === 'asset' && i.id === id)) {
      setState(prev => ({ ...prev, selectedItems: [{ type: 'asset', id }] }));
    }

    const items = buildAssetContextMenu({
      asset,
      onRename: () => {
        setRenameModal({
          isOpen: true,
          title: '重命名素材',
          initialValue: asset.name,
          onConfirm: (finalName) => setState(p => ({ ...p, assets: p.assets.map(a => a.id === id ? { ...a, name: finalName } : a) }))
        });
      },
      onOpenSource: () => window.open(asset.thumbnailUrl || asset.path, '_blank'),
      onOpenInExplorer: () => apiClient.openInExplorer(asset.path).catch(console.error),
      onDelete: () => {
        dataService.deleteAssets([id]);
        setState(p => ({
          ...p, 
          assets: p.assets.filter(a => a.id !== id),
          selectedItems: p.selectedItems.filter(i => !(i.type === 'asset' && i.id === id))
        }));
      }
    });

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuFolder = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const folder = state.folders.find(f => f.id === id);
    if (!folder) return;

    if (!state.selectedItems.some(i => i.type === 'folder' && i.id === id)) {
      setState(prev => ({ ...prev, selectedItems: [{ type: 'folder', id }] }));
    }

    const items = buildFolderContextMenu({
      folder,
      onViewProperties: () => onSelectFolder(id),
      onTogglePin: () => onTogglePinFolder(id),
      onMoveUp: () => onMoveFolder(id, 'up'),
      onMoveDown: () => onMoveFolder(id, 'down'),
      onOpenInExplorer: () => apiClient.openInExplorer(folder.path),
      onRename: () => {
        setRenameModal({
          isOpen: true,
          title: '重命名文件夹',
          initialValue: folder.name,
          onConfirm: (finalName) => onUpdateFolder(id, { name: finalName })
        });
      },
      onDelete: () => onDeleteFolder(id)
    });

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuTag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const tag = state.tags.find(t => t.id === id);
    if (!tag) return;
    const items = buildTagContextMenu({
      tag,
      onViewProperties: () => onSelectTag(id),
      onTogglePin: () => onTogglePinTag(id),
      onMoveUp: () => onMoveTag(id, 'up'),
      onMoveDown: () => onMoveTag(id, 'down'),
      onRename: () => {
        setRenameModal({
          isOpen: true,
          title: '重命名标签',
          initialValue: tag.name,
          onConfirm: (finalName) => onUpdateTag(id, { name: finalName })
        });
      },
      onDelete: () => onDeleteTag(id)
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuCollection = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const col = state.collections.find(c => c.id === id);
    if (!col) return;
    const items = buildCollectionContextMenu({
      collection: col,
      onViewProperties: () => onSelectCollection(id),
      onTogglePin: () => onTogglePinCollection(id),
      onMoveUp: () => onMoveCollection(id, 'up'),
      onMoveDown: () => onMoveCollection(id, 'down'),
      onRename: () => {
        setRenameModal({
          isOpen: true,
          title: '重命名集合',
          initialValue: col.name,
          onConfirm: (finalName) => onUpdateCollection(id, { name: finalName })
        });
      },
      onDelete: () => onDeleteCollection(id)
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuSmartFolder = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const customSf = state.customSmartFolders.find(sf => sf.id === id);
    const builtInSf = smartFolders.find(sf => sf.id === id);
    let items: ContextMenuItem[];
    
    if (customSf) {
      items = buildCustomSmartFolderContextMenu({
        customSf,
        onViewProperties: () => onSelectSmartFolder(id),
        onTogglePin: () => onTogglePinSmartFolder(id),
        onMoveUp: () => onMoveSmartFolder(id, 'up'),
        onMoveDown: () => onMoveSmartFolder(id, 'down'),
        onRename: () => {
          setRenameModal({
            isOpen: true,
            title: '重命名智能文件夹',
            initialValue: customSf.name,
            onConfirm: (finalName) => onUpdateSmartFolder(id, { name: finalName })
          });
        },
        onDelete: () => onDeleteSmartFolder(id)
      });
    } else if (builtInSf) {
      items = buildBuiltInSmartFolderContextMenu({
        builtInSf,
        onViewProperties: () => onSelectSmartFolder(id),
        onTogglePin: () => onTogglePinSmartFolder(id)
      });
    } else {
      return;
    }

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuCanvas = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = buildCanvasContextMenu({
      state,
      onToggleView: () => onChangeView(state.viewMode === 'grid' ? 'list' : 'grid'),
      onToggleGroupByFolder,
      onToggleIncludeSubfolders,
      onClearSelection,
      onSelectAll: () => setState(p => ({
        ...p,
        selectedItems: filteredAssets.map(a => ({ id: a.id, type: 'asset' as const }))
      })),
      onScanLocalFolder,
      onCreateTag,
      onCreateCollection,
      onRefresh: () => {
        dataService.loadWorkspace().then(d => {
          if (d) {
            setState(prev => ({
              ...prev,
              folders: d.folders || [],
              assets: d.assets || [],
              tags: d.tags || [],
              collections: d.collections || [],
              customSmartFolders: d.customSmartFolders || []
            }));
          }
        });
      }
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleContextMenuSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = buildSidebarContextMenu({
      onCreateSmartFolder,
      onScanLocalFolder,
      onCreateTag,
      onCreateCollection,
      onOpenSettings: () => setSettingsOpen(true)
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  return {
    handleContextMenuAsset,
    handleContextMenuFolder,
    handleContextMenuTag,
    handleContextMenuCollection,
    handleContextMenuSmartFolder,
    handleContextMenuCanvas,
    handleContextMenuSidebar,
  };
}
