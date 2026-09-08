/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import type { SmartFolder, SortOption, Tag, Collection, Folder as FolderType } from '../types';
import { dataService } from '../services/dataService';

/**
 * 实体 CRUD 操作管理
 * 包含智能文件夹、标签、集合、文件夹的增删改排操作
 */
export function useEntityActions(
  setState: React.Dispatch<React.SetStateAction<import('../types').AssetState>>
) {
  // ============================================================================
  // 智能文件夹操作
  // ============================================================================

  const handleCreateSmartFolder = () => {
    const newId = `sf_custom_${Date.now()}`;
    const newSF: SmartFolder = {
      id: newId,
      name: 'New Smart Folder',
      icon: 'Filter',
      rules: [],
      matchAll: true,
      isSearchHistory: false
    };
    dataService.saveSmartFolder(newSF);
    setState(prev => ({
      ...prev,
      customSmartFolders: [newSF, ...prev.customSmartFolders],
      activeSmartFolderId: newId,
      activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [], activeSidebarTab: 'smart'
    }));
  };

  const handleUpdateSmartFolder = (id: string, updates: Partial<SmartFolder>) => {
    setState(prev => {
      const updated = prev.customSmartFolders.map(sf => sf.id === id ? { ...sf, ...updates } : sf);
      const target = updated.find(sf => sf.id === id);
      if (target) {
        dataService.saveSmartFolder(target);
      }
      return { ...prev, customSmartFolders: updated };
    });
  };

  const handleDeleteSmartFolder = (id: string) => {
    dataService.deleteSmartFolder(id);
    setState(prev => ({
      ...prev,
      customSmartFolders: prev.customSmartFolders.filter(sf => sf.id !== id),
      activeSmartFolderId: prev.activeSmartFolderId === id ? 'sf_all' : prev.activeSmartFolderId
    }));
  };

  const handleMoveSmartFolder = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.customSmartFolders];
      const idx = list.findIndex(sf => sf.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, customSmartFolders: list };
    });
  };

  const handleTogglePinSmartFolder = (id: string) => {
    setState(prev => {
      const updated = prev.customSmartFolders.map(sf => 
        sf.id === id ? { ...sf, isPinned: !sf.isPinned } : sf
      );
      const target = updated.find(sf => sf.id === id);
      if (target) dataService.saveSmartFolder(target);
      return { ...prev, customSmartFolders: updated };
    });
  };

  // ============================================================================
  // 标签操作
  // ============================================================================

  const handleUpdateTag = (id: string, updates: Partial<Tag>) => {
    setState(prev => {
      const updated = prev.tags.map(t => t.id === id ? { ...t, ...updates } : t);
      const target = updated.find(t => t.id === id);
      if (target) dataService.updateTag(target);
      return { ...prev, tags: updated };
    });
  };

  const handleDeleteTag = (id: string) => {
    dataService.deleteTag(id);
    setState(prev => ({
      ...prev,
      tags: prev.tags.filter(t => t.id !== id),
      assets: prev.assets.map(a => ({ ...a, tags: a.tags.filter(tid => tid !== id) })),
      folders: prev.folders.map(f => ({ ...f, tags: f.tags?.filter(tid => tid !== id) })),
      activeTagId: prev.activeTagId === id ? null : prev.activeTagId
    }));
  };

  const handleMoveTag = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.tags];
      const idx = list.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, tags: list };
    });
  };

  const handleTogglePinTag = (id: string) => {
    setState(prev => {
      const updated = prev.tags.map(t => 
        t.id === id ? { ...t, isPinned: !t.isPinned } : t
      );
      const target = updated.find(t => t.id === id);
      if (target) dataService.updateTag(target);
      return { ...prev, tags: updated };
    });
  };

  // ============================================================================
  // 集合操作
  // ============================================================================

  const handleUpdateCollection = (id: string, updates: Partial<Collection>) => {
    setState(prev => {
      const updated = prev.collections.map(c => c.id === id ? { ...c, ...updates } : c);
      const target = updated.find(c => c.id === id);
      if (target) dataService.updateCollection(target);
      return { ...prev, collections: updated };
    });
  };

  const handleDeleteCollection = (id: string) => {
    dataService.deleteCollection(id);
    setState(prev => ({
      ...prev,
      collections: prev.collections.filter(c => c.id !== id),
      assets: prev.assets.map(a => ({ ...a, collections: a.collections.filter(cid => cid !== id) })),
      activeCollectionId: prev.activeCollectionId === id ? null : prev.activeCollectionId
    }));
  };

  const handleMoveCollection = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.collections];
      const idx = list.findIndex(c => c.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, collections: list };
    });
  };

  const handleTogglePinCollection = (id: string) => {
    setState(prev => {
      const updated = prev.collections.map(c => 
        c.id === id ? { ...c, isPinned: !c.isPinned } : c
      );
      const target = updated.find(c => c.id === id);
      if (target) dataService.updateCollection(target);
      return { ...prev, collections: updated };
    });
  };

  // ============================================================================
  // 文件夹操作
  // ============================================================================

  const handleUpdateFolder = (id: string, updates: Partial<FolderType>) => {
    setState(prev => {
      // 调试：当"本地监视工作区"开关被切换时，在控制台打印前后状态，便于确认链路是否传向后端
      if ('isMonitored' in updates) {
        const before = prev.folders.find(f => f.id === id);
        console.log(
          `[Monitor] 文件夹监视开关被切换: id=${id}, path=${before?.path}, isMonitored: ${before?.isMonitored} -> ${updates.isMonitored}`
        );
      }
      const updated = prev.folders.map(f => f.id === id ? { ...f, ...updates } : f);
      const target = updated.find(f => f.id === id);
      if (target) {
        if ('isMonitored' in updates) {
          console.log(`[Monitor] 调用 dataService.updateFolder 推送后端: id=${id}, isMonitored=${target.isMonitored}, path=${target.path}`);
        }
        dataService.updateFolder(target);
      }
      return { ...prev, folders: updated };
    });
  };

  const handleDeleteFolder = (id: string) => {
    dataService.deleteFolder(id);
    setState(prev => ({
      ...prev,
      folders: prev.folders.filter(f => f.id !== id),
      selectedItems: prev.selectedItems.filter(i => !(i.type === 'folder' && i.id === id)),
      activeFolderId: prev.activeFolderId === id ? null : prev.activeFolderId
    }));
  };

  const handleMoveFolder = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const targetFolder = prev.folders.find(f => f.id === id);
      if (!targetFolder) return prev;
      const siblings = prev.folders.filter(f => f.parentId === targetFolder.parentId);
      const idx = siblings.findIndex(f => f.id === id);
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= siblings.length) return prev;
      
      const otherFolder = siblings[targetIdx];
      const list = [...prev.folders];
      const f1Index = list.findIndex(f => f.id === id);
      const f2Index = list.findIndex(f => f.id === otherFolder.id);
      list[f1Index] = otherFolder;
      list[f2Index] = targetFolder;
      return { ...prev, folders: list };
    });
  };

  const handleTogglePinFolder = (id: string) => {
    setState(prev => {
      const updated = prev.folders.map(f => 
        f.id === id ? { ...f, isPinned: !f.isPinned } : f
      );
      const target = updated.find(f => f.id === id);
      if (target) dataService.updateFolder(target);
      return { ...prev, folders: updated };
    });
  };

  // 搜索创建智能文件夹
  const handleSearchSubmit = (query: string) => {
    if (!query.trim()) return;
    const newSF: SmartFolder = {
      id: `sf_search_${Date.now()}`,
      name: `Search: ${query}`,
      icon: 'Search',
      rules: [{ id: Date.now().toString(), type: 'name', operator: 'contains', value: query }],
      matchAll: true,
      isSearchHistory: true
    };
    setState(prev => ({
      ...prev,
      customSmartFolders: [newSF, ...prev.customSmartFolders],
      activeSmartFolderId: newSF.id,
      activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [], activeSidebarTab: 'smart'
    }));
  };

  return {
    handleCreateSmartFolder,
    handleUpdateSmartFolder,
    handleDeleteSmartFolder,
    handleMoveSmartFolder,
    handleTogglePinSmartFolder,
    handleUpdateTag,
    handleDeleteTag,
    handleMoveTag,
    handleTogglePinTag,
    handleUpdateCollection,
    handleDeleteCollection,
    handleMoveCollection,
    handleTogglePinCollection,
    handleUpdateFolder,
    handleDeleteFolder,
    handleMoveFolder,
    handleTogglePinFolder,
    handleSearchSubmit,
  };
}
