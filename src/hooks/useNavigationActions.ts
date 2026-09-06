/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import type { SidebarTab, SortOption } from '../types';

/**
 * 基础导航、选中与视图操作
 */
export function useNavigationActions(
  setState: React.Dispatch<React.SetStateAction<import('../types').AssetState>>
) {
  const handleChangeTab = (tab: SidebarTab) => {
    setState(prev => ({ ...prev, activeSidebarTab: tab }));
  };

  const handleSelectSmartFolder = (id: string) => {
    setState(prev => ({ ...prev, activeSmartFolderId: id, activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectFolder = (id: string) => {
    setState(prev => ({ ...prev, activeFolderId: id, activeSmartFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectTag = (id: string) => {
    setState(prev => ({ ...prev, activeTagId: id, activeFolderId: null, activeSmartFolderId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectCollection = (id: string) => {
    setState(prev => ({ ...prev, activeCollectionId: id, activeFolderId: null, activeSmartFolderId: null, activeTagId: null, selectedItems: [] }));
  };

  const handleToggleFolderExpand = (id: string) => {
    setState(prev => ({
      ...prev,
      expandedFolderIds: prev.expandedFolderIds.includes(id)
        ? prev.expandedFolderIds.filter(fid => fid !== id)
        : [...prev.expandedFolderIds, id]
    }));
  };

  const handleToggleSelection = (id: string, type: 'asset' | 'folder', multi: boolean) => {
    setState(prev => {
      const isSelected = prev.selectedItems.some(item => item.id === id && item.type === type);
      if (multi) {
        return {
          ...prev,
          selectedItems: isSelected 
            ? prev.selectedItems.filter(item => !(item.id === id && item.type === type))
            : [...prev.selectedItems, { id, type }]
        };
      } else {
        return {
          ...prev,
          selectedItems: [{ id, type }]
        };
      }
    });
  };

  const handleClearSelection = () => {
    setState(prev => ({ ...prev, selectedItems: [] }));
  };

  const handleChangeView = (mode: 'grid' | 'list') => {
    setState(prev => ({ ...prev, viewMode: mode }));
  };

  const handleToggleGroupByFolder = () => {
    setState(prev => ({ ...prev, groupByFolder: !prev.groupByFolder }));
  };

  const handleToggleIncludeSubfolders = () => {
    setState(prev => ({ ...prev, includeSubfolders: !prev.includeSubfolders }));
  };

  const handleToggleGroupCollapse = (id: string) => {
    setState(prev => ({
      ...prev,
      collapsedGroupIds: prev.collapsedGroupIds.includes(id)
        ? prev.collapsedGroupIds.filter(gid => gid !== id)
        : [...prev.collapsedGroupIds, id]
    }));
  };

  const handleSortChange = (option: SortOption) => {
    setState(prev => ({ ...prev, sortOption: option }));
  };

  return {
    handleChangeTab,
    handleSelectSmartFolder,
    handleSelectFolder,
    handleSelectTag,
    handleSelectCollection,
    handleToggleFolderExpand,
    handleToggleSelection,
    handleClearSelection,
    handleChangeView,
    handleToggleGroupByFolder,
    handleToggleIncludeSubfolders,
    handleToggleGroupCollapse,
    handleSortChange,
  };
}
