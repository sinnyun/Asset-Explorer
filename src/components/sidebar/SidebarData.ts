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
    for (const sf of smartFolders) {
      if (sf.filter) {
        map.set(sf.id, state.assets.filter(sf.filter).length);
      }
    }
    for (const csf of state.customSmartFolders) {
      if (csf.rules) {
        const count = state.assets.filter(asset => {
          if (csf.rules!.length === 0) return true;
          const matches = csf.rules!.map(rule => {
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
          return csf.matchAll ? matches.every(Boolean) : matches.some(Boolean);
        }).length;
        map.set(csf.id, count);
      }
    }
    return map;
  }, [state.assets, smartFolders, state.customSmartFolders, state.tags, state.collections]);

  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of state.assets) {
      map.set(a.folderId, (map.get(a.folderId) || 0) + 1);
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
