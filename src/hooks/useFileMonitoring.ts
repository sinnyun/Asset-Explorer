/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { AssetState } from '../types';
import { runtime } from '../services/api';

/**
 * 桌面模式：监听文件监控器实时事件（资产新增/删除/修改）
 *
 * 优化策略：
 * - Rust watcher 现在在事件中携带完整资产对象（asset 字段），
 *   前端不再需要每次事件触发时全量 loadWorkspace() 重新拉取数万条数据。
 * - 事件回调改为对本地 state 做"增量增/删/改"，极大降低大批量文件操作时的 UI 卡顿。
 * - 当事件未携带 asset 数据（如旧版本后端或 Web 模式）时降级为增量路径过滤。
 */
export function useFileMonitoring(
  setState: React.Dispatch<React.SetStateAction<AssetState>>
) {
  // 全量刷新节流：批量事件风暴时 5 秒最多允许一次全量 loadWorkspace
  const lastFullReloadRef = useRef(0);

  useEffect(() => {
    if (!runtime.isDesktop) return;

    let unlisteners: Array<() => void> = [];

    const shouldFullReload = () => {
      const now = Date.now();
      if (now - lastFullReloadRef.current > 5000) {
        lastFullReloadRef.current = now;
        return true;
      }
      return false;
    };

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 资产新增：携带完整资产对象 → 增量合并到 state.assets
        const unlistenAdd = await listen<{
          asset_id?: string; path: string; asset?: any
        }>('asset:added', (ev) => {
          const payload = ev.payload || {};
          const newAsset = payload.asset;

          if (newAsset && newAsset.id) {
            // 增量合并：直接添加/替换该资产（避免全量重载）
            setState(prev => {
              const existing = new Set(prev.assets.map(a => a.id));
              if (existing.has(newAsset.id)) {
                // 已存在 → 替换（更新）
                return {
                  ...prev,
                  assets: prev.assets.map(a => a.id === newAsset.id ? newAsset : a)
                };
              }
              return { ...prev, assets: [newAsset, ...prev.assets] };
            });
          } else {
            // 降级：事件未携带完整资产，做节流全量刷新
            if (shouldFullReload()) {
              import('../services/dataService').then(({ dataService }) => {
                dataService.loadWorkspace().then(payload => {
                  if (payload) {
                    setState(prev => ({ ...prev, assets: payload.assets ?? prev.assets }));
                  }
                });
              });
            }
          }
        });

        // 资产删除：按 asset_id 增量过滤
        const unlistenRemove = await listen<{
          asset_id?: string; path: string; asset?: any
        }>('asset:removed', (ev) => {
          const payload = ev.payload || {};
          const assetId = payload.asset_id;
          const path = payload.path;

          setState(prev => {
            // 优先按 asset_id 删除；若没有 asset_id 则按 path 精确匹配删除
            if (assetId) {
              return { ...prev, assets: prev.assets.filter(a => a.id !== assetId) };
            }
            if (path) {
              return { ...prev, assets: prev.assets.filter(a => a.path !== path) };
            }
            return prev;
          });
        });

        // 资产修改：携带完整资产对象 → 增量替换本地资产
        const unlistenModify = await listen<{
          asset_id?: string; path: string; asset?: any
        }>('asset:modified', (ev) => {
          const payload = ev.payload || {};
          const updatedAsset = payload.asset;

          if (updatedAsset && updatedAsset.id) {
            // 增量替换
            setState(prev => ({
              ...prev,
              assets: prev.assets.map(a =>
                a.id === updatedAsset.id ? { ...a, ...updatedAsset } : a
              )
            }));
          } else if (shouldFullReload()) {
            // 降级路径
            import('../services/dataService').then(({ dataService }) => {
              dataService.loadWorkspace().then(payload => {
                if (payload) {
                  setState(prev => ({ ...prev, assets: payload.assets ?? prev.assets }));
                }
              });
            });
          }
        });

        unlisteners = [unlistenAdd, unlistenRemove, unlistenModify];
      } catch (e) {
        console.warn('[App] 文件监控事件监听器初始化失败（非桌面环境可忽略）:', e);
      }
    };

    setupListeners();

    return () => {
      unlisteners.forEach(fn => fn());
    };
  }, [setState]);
}
