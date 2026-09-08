/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useMemo, useDeferredValue } from 'react';
import type { Asset, AssetState, Folder, SmartFolder } from '../types';

/**
 * 根据当前激活的筛选条件，计算过滤后的资产列表与文件夹列表
 *
 * 优化：
 * - 引入 React 18 的 useDeferredValue 解耦高频键入与 CPU 密集型过滤，避免输入卡顿
 * - 子文件夹树展开改为一次构建全量映射缓存 + 递归，避免每次资产过滤重复 filter
 * - 预计算 tag/collection 名称到 ID 的映射，避免在每条资产匹配时线性扫描
 */
export function useAssetFiltering(
  state: AssetState,
  smartFolders: SmartFolder[]
): { filteredAssets: Asset[]; filteredFolders: Folder[] } {
  // 使用 React 18 并发特性，让搜索输入框保持 60fps 响应，复杂过滤异步延迟计算
  const deferredSearchQuery = useDeferredValue(state.searchQuery);

  const filteredAssets = useMemo(() => {
    let result = state.assets;

    if (state.activeFolderId) {
      if (state.includeSubfolders) {
        // ========= 优化：一次构建父子映射表，避免递归中对每条资产做 O(n) filter =========
        // 使用一次遍历构建父子映射
        const folderChildren = new Map<string, string[]>();
        for (const f of state.folders) {
          const parentId = f.parentId;
          if (!parentId) continue;
          const list = folderChildren.get(parentId) || [];
          list.push(f.id);
          folderChildren.set(parentId, list);
        }

        // 递归展开（迭代栈方式避免深递归栈溢出）
        const getAllDescendantIds = (rootId: string): Set<string> => {
          const ids = new Set<string>([rootId]);
          const stack = [rootId];
          while (stack.length > 0) {
            const cur = stack.pop()!;
            const children = folderChildren.get(cur) || [];
            for (const child of children) {
              if (!ids.has(child)) {
                ids.add(child);
                stack.push(child);
              }
            }
          }
          return ids;
        };

        const allowedIds = getAllDescendantIds(state.activeFolderId);
        result = result.filter(a => allowedIds.has(a.folderId));
      } else {
        result = result.filter(a => a.folderId === state.activeFolderId);
      }
    } else if (state.activeSmartFolderId) {
      const sf = smartFolders.find(s => s.id === state.activeSmartFolderId);
      const customSf = state.customSmartFolders.find(s => s.id === state.activeSmartFolderId);
      
      if (sf && sf.filter) {
        result = result.filter(sf.filter);
      } else if (customSf && customSf.rules) {
        // ===== 优化：预计算 tag/collection 子串匹配 ID 集合 =====
        // 原版对每个 asset 在 tag/collection 规则上重复 find()（O(tags×assets)）
        // 这里对每条规则预先计算一次匹配的 ID 集（O(tags×rules)），过滤时 O(1) 查询
        const rules = customSf.rules;
        const precomputed = rules.map(rule => {
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

        result = result.filter(asset => {
          if (rules.length === 0) return true;
          const matches = precomputed.map(p => {
            const { rule } = p;
            if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
            if (rule.type === 'tag') {
              // 检查资产的任一 tag 是否在匹配的 ID 集合中
              return asset.tags.some(tagId => p.tagIds.has(tagId));
            }
            if (rule.type === 'collection') {
              return asset.collections.some(colId => p.colIds.has(colId));
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

    if (deferredSearchQuery) {
      const queryLower = deferredSearchQuery.toLowerCase().trim();
      if (queryLower) {
        result = result.filter(a => (a.name || '').toLowerCase().includes(queryLower));
      }
    }

    // 防御性去重：增量扫描 + 文件监视事件并发时可能出现同一 asset 出现在 state 中多次，
    // 导致 React 列表渲染 key 冲突。此处统一去重，保证下游组件（MainArea / MonitoredSplitView）拿到干净数据。
    const seen = new Set<string>();
    return result.filter(a => {
      if (!a?.id || seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.assets, state.activeFolderId, state.activeSmartFolderId, state.activeTagId, state.activeCollectionId, deferredSearchQuery, state.folders, state.includeSubfolders, state.customSmartFolders, state.tags, state.collections, smartFolders]);

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
