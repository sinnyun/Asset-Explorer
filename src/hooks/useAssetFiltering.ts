/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useMemo } from 'react';
import type { Asset, AssetState, Folder, SmartFolder } from '../types';

/**
 * 根据当前激活的筛选条件，计算过滤后的资产列表与文件夹列表
 */
export function useAssetFiltering(
  state: AssetState,
  smartFolders: SmartFolder[]
): { filteredAssets: Asset[]; filteredFolders: Folder[] } {
  const filteredAssets = useMemo(() => {
    let result = state.assets;
    if (state.activeFolderId) {
      if (state.includeSubfolders) {
        const getChildFolderIds = (parentId: string): string[] => {
          const children = state.folders.filter(f => f.parentId === parentId).map(f => f.id);
          return [parentId, ...children.flatMap(getChildFolderIds)];
        };
        const allowedFolderIds = getChildFolderIds(state.activeFolderId);
        result = result.filter(a => allowedFolderIds.includes(a.folderId));
      } else {
        result = result.filter(a => a.folderId === state.activeFolderId);
      }
    } else if (state.activeSmartFolderId) {
      const sf = smartFolders.find(s => s.id === state.activeSmartFolderId);
      const customSf = state.customSmartFolders.find(s => s.id === state.activeSmartFolderId);
      
      if (sf && sf.filter) {
        result = result.filter(sf.filter);
      } else if (customSf && customSf.rules) {
        result = result.filter(asset => {
          if (customSf.rules!.length === 0) return true;
          const matches = customSf.rules!.map(rule => {
            if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
            if (rule.type === 'tag') {
              const tag = state.tags.find(t => t.name.toLowerCase().includes(rule.value.toLowerCase()));
              return tag ? asset.tags.includes(tag.id) : false;
            }
            if (rule.type === 'collection') {
              const col = state.collections.find(c => c.name.toLowerCase().includes(rule.value.toLowerCase()));
              return col ? asset.collections.includes(col.id) : false;
            }
            if (rule.type === 'type') return asset.type.toLowerCase() === rule.value.toLowerCase();
            return false;
          });
          return customSf.matchAll ? matches.every(Boolean) : matches.some(Boolean);
        });
      }
    } else if (state.activeTagId) {
      result = result.filter(a => a.tags.includes(state.activeTagId!));
    } else if (state.activeCollectionId) {
      result = result.filter(a => a.collections.includes(state.activeCollectionId!));
    }

    if (state.searchQuery) {
      result = result.filter(a => a.name.toLowerCase().includes(state.searchQuery.toLowerCase()));
    }
    return result;
  }, [state.assets, state.activeFolderId, state.activeSmartFolderId, state.activeTagId, state.activeCollectionId, state.searchQuery, state.folders, state.includeSubfolders, state.customSmartFolders]);

  const filteredFolders = useMemo(() => {
    if (state.activeTagId) {
      return state.folders.filter(f => f.tags.includes(state.activeTagId!));
    } else if (state.activeCollectionId) {
      return state.folders.filter(f => f.collections.includes(state.activeCollectionId!));
    }
    return [];
  }, [state.folders, state.activeTagId, state.activeCollectionId]);

  return { filteredAssets, filteredFolders };
}
