import { useMemo } from 'react';
import type { AssetState, SmartFolder } from '../../types';

export function useSidebarData(
  state: AssetState,
  smartFolders: SmartFolder[],
  folderSearch: string,
  smartSearch: string,
  tagSearch: string,
  colSearch: string
) {
  // Precompute asset counts for tags, collections, and smart folders
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      for (const t of a.tags) {
        map.set(t, (map.get(t) || 0) + 1);
      }
    }
    return map;
  }, [state.assets]);

  const colCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      for (const c of a.collections) {
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    return map;
  }, [state.assets]);

  const smartCounts = useMemo(() => {
    const map = new Map<string, number>();
    
    const assets = state.assets;

    for (const sf of smartFolders) {
      if (sf.filter) {
        let count = 0;
        for (const asset of assets) {
          if (sf.filter(asset)) count++;
        }
        map.set(sf.id, count);
      }
    }
    for (const csf of state.customSmartFolders) {
      if (csf.rules && csf.rules.length > 0) {
        // 预计算每条规则的 tag/collection ID 匹配集（子串匹配语义与原版一致）
        const precomputed = csf.rules.map(rule => {
          if (rule.type === 'tag') {
            const valLower = rule.value.toLowerCase();
            const ids = new Set<string>();
            for (const t of state.tags) {
              if (t.name.toLowerCase().includes(valLower)) ids.add(t.id);
            }
            return { rule, tagIds: ids, colIds: new Set<string>() };
          }
          if (rule.type === 'collection') {
            const valLower = rule.value.toLowerCase();
            const ids = new Set<string>();
            for (const c of state.collections) {
              if (c.name.toLowerCase().includes(valLower)) ids.add(c.id);
            }
            return { rule, tagIds: new Set<string>(), colIds: ids };
          }
          return { rule, tagIds: new Set<string>(), colIds: new Set<string>() };
        });

        let count = 0;
        for (const asset of assets) {
          const matches = precomputed.map(p => {
            const { rule } = p;
            if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
            if (rule.type === 'tag') return asset.tags.some(tid => p.tagIds.has(tid));
            if (rule.type === 'collection') return asset.collections.some(cid => p.colIds.has(cid));
            if (rule.type === 'type') return asset.type.toLowerCase() === rule.value.toLowerCase();
            return false;
          });
          if (csf.matchAll ? matches.every(Boolean) : matches.some(Boolean)) {
            count++;
          }
        }
        map.set(csf.id, count);
      } else if (csf.rules && csf.rules.length === 0) {
        // 无规则 = 匹配全部
        map.set(csf.id, assets.length);
      }
    }
    return map;
  }, [state.assets, smartFolders, state.customSmartFolders, state.tags, state.collections]);

  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const folder of state.folders) {
      if (folder.assetCount !== undefined) map.set(folder.id, folder.assetCount);
    }
    for (const a of state.assets) {
      if (!map.has(a.folderId)) map.set(a.folderId, 1);
    }
    return map;
  }, [state.assets]);

  // Smart folders filtered list
  const filteredBuiltInSmartFolders = useMemo(() => {
    let list = smartFolders;
    if (smartSearch.trim()) {
      list = list.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
    }
    return [...list].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [smartFolders, smartSearch]);

  const filteredCustomSmartFolders = useMemo(() => {
    const nonHistory = state.customSmartFolders.filter(f => !f.isSearchHistory);
    let list = nonHistory;
    if (smartSearch.trim()) {
      list = list.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
    }
    return [...list].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.customSmartFolders, smartSearch]);

  const filteredSearchHistory = useMemo(() => {
    const history = state.customSmartFolders.filter(f => f.isSearchHistory);
    if (!smartSearch.trim()) return history;
    return history.filter(sf => sf.name.toLowerCase().includes(smartSearch.toLowerCase()));
  }, [state.customSmartFolders, smartSearch]);

  const sortedTags = useMemo(() => {
    const filtered = state.tags.filter(t => t.name.toLowerCase().includes(tagSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.tags, tagSearch]);

  const sortedCollections = useMemo(() => {
    const filtered = state.collections.filter(c => c.name.toLowerCase().includes(colSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      if (Boolean(a.isPinned) === Boolean(b.isPinned)) return 0;
      return a.isPinned ? -1 : 1;
    });
  }, [state.collections, colSearch]);

  const totalSmartFoldersCount = smartFolders.length + state.customSmartFolders.length;

  return {
    tagCounts, colCounts, smartCounts, folderCounts,
    filteredBuiltInSmartFolders, filteredCustomSmartFolders,
    filteredSearchHistory, sortedTags, sortedCollections,
    totalSmartFoldersCount,
  };
}
