/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { dataService } from '../services/dataService';
import type { ThemeMode, Tag, Collection } from '../types';

/**
 * 创建实体、批量操作、设置等杂项操作
 */
export function useMiscActions(
  createEntityModal: { isOpen: boolean; type: 'tag' | 'collection' },
  setState: React.Dispatch<React.SetStateAction<import('../types').AssetState>>,
  state: import('../types').AssetState
) {
  const handleConfirmCreateEntity = async (data: { name: string; color: string; description?: string; isPinned: boolean }) => {
    if (createEntityModal.type === 'tag') {
      const newTag: Tag = {
        id: `t_${Date.now()}`,
        name: data.name,
        color: data.color,
        description: data.description,
        isPinned: data.isPinned
      };
      await dataService.createTag(newTag);
      setState(prev => ({
        ...prev,
        tags: [newTag, ...prev.tags],
        activeTagId: newTag.id,
        activeFolderId: null,
        activeSmartFolderId: null,
        activeCollectionId: null,
        selectedItems: [],
        activeSidebarTab: 'tags'
      }));
    } else {
      const newCol: Collection = {
        id: `c_${Date.now()}`,
        name: data.name,
        color: data.color,
        description: data.description,
        isPinned: data.isPinned
      };
      await dataService.createCollection(newCol);
      setState(prev => ({
        ...prev,
        collections: [newCol, ...prev.collections],
        activeCollectionId: newCol.id,
        activeFolderId: null,
        activeSmartFolderId: null,
        activeTagId: null,
        selectedItems: [],
        activeSidebarTab: 'collections'
      }));
    }
  };

  const handleBulkAddTags = async (tagIds: string[]) => {
    // 从 state 直接获取选中的资产/文件夹 ID
    const selectedAssetIds = state.selectedItems.filter(i => i.type === 'asset').map(i => i.id);
    const selectedFolderIds = state.selectedItems.filter(i => i.type === 'folder').map(i => i.id);

    // 同步更新本地状态
    setState(p => ({
      ...p,
      assets: p.assets.map(a => {
        if (selectedAssetIds.includes(a.id)) {
          return { ...a, tags: Array.from(new Set([...a.tags, ...tagIds])) };
        }
        return a;
      }),
      folders: p.folders.map(f => {
        if (selectedFolderIds.includes(f.id)) {
          return { ...f, tags: Array.from(new Set([...(f.tags || []), ...tagIds])) };
        }
        return f;
      })
    }));

    // 持久化到后端数据库（若存在选中的资产）
    if (selectedAssetIds.length > 0 && tagIds.length > 0) {
      try {
        await dataService.syncManyAssetTags(selectedAssetIds, tagIds);
        console.log(`[MiscActions] 已为 ${selectedAssetIds.length} 个资产持久化标签关联`);
      } catch (err) {
        console.error('[MiscActions] 持久化标签关联失败:', err);
      }
    }
  };

  const handleBulkAddCollections = async (colIds: string[]) => {
    // 从 state 直接获取选中的资产/文件夹 ID
    const selectedAssetIds = state.selectedItems.filter(i => i.type === 'asset').map(i => i.id);
    const selectedFolderIds = state.selectedItems.filter(i => i.type === 'folder').map(i => i.id);

    // 同步更新本地状态
    setState(p => ({
      ...p,
      assets: p.assets.map(a => {
        if (selectedAssetIds.includes(a.id)) {
          return { ...a, collections: Array.from(new Set([...a.collections, ...colIds])) };
        }
        return a;
      }),
      folders: p.folders.map(f => {
        if (selectedFolderIds.includes(f.id)) {
          return { ...f, collections: Array.from(new Set([...(f.collections || []), ...colIds])) };
        }
        return f;
      })
    }));

    // 持久化到后端数据库（若存在选中的资产）
    if (selectedAssetIds.length > 0 && colIds.length > 0) {
      try {
        await dataService.syncManyAssetCollections(selectedAssetIds, colIds);
        console.log(`[MiscActions] 已为 ${selectedAssetIds.length} 个资产持久化集合关联`);
      } catch (err) {
        console.error('[MiscActions] 持久化集合关联失败:', err);
      }
    }
  };

  const handleBulkDelete = (state: import('../types').AssetState) => {
    if (window.confirm(`Delete ${state.selectedItems.length} selected items?`)) {
      const selectedAssetIds = state.selectedItems.filter(i => i.type === 'asset').map(i => i.id);
      const selectedFolderIds = state.selectedItems.filter(i => i.type === 'folder').map(i => i.id);
      
      if (selectedAssetIds.length > 0) {
        dataService.deleteAssets(selectedAssetIds);
      }
      for (const fId of selectedFolderIds) {
        dataService.deleteFolder(fId);
      }

      setState(p => ({
        ...p,
        assets: p.assets.filter(a => !selectedAssetIds.includes(a.id)),
        folders: p.folders.filter(f => !selectedFolderIds.includes(f.id)),
        selectedItems: []
      }));
    }
  };

  const handleUpdateTheme = (theme: ThemeMode) => {
    setState(p => ({ ...p, theme }));
  };

  const handleRelocatePaths = (oldBasePath: string, newBasePath: string) => {
    setState(p => ({
      ...p,
      folders: p.folders.map(f => ({
        ...f,
        path: f.path.startsWith(oldBasePath) ? f.path.replace(oldBasePath, newBasePath) : f.path
      })),
      assets: p.assets.map(a => ({
        ...a,
        path: a.path.startsWith(oldBasePath) ? a.path.replace(oldBasePath, newBasePath) : a.path
      }))
    }));
    alert(`Successfully mapped database base paths from ${oldBasePath} to ${newBasePath}. Internal File index preserved.`);
  };

  return {
    handleConfirmCreateEntity,
    handleBulkAddTags,
    handleBulkAddCollections,
    handleBulkDelete,
    handleUpdateTheme,
    handleRelocatePaths,
  };
}
