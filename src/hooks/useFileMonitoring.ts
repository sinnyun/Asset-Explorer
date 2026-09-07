/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { Asset, AssetState } from '../types';
import { runtime } from '../services/api';

/** 文件监控事件载荷类型定义 */
interface FileMonitoringPayload {
  asset_id?: string;
  path?: string;
  asset?: Asset;
}

/**
 * 桌面模式：监听文件监控器实时事件（资产新增/删除/修改）
 *
 * 性能优化策略：
 * 1. 强类型载荷定义：消除 TypeScript TS2339 错误。
 * 2. 事件微批处理（Micro-batching）：
 *    大批量文件生成/删除（如拖入包含上百文件的目录）时，Rust watcher 会在数毫秒内发出大量事件。
 *    若每次事件均同步执行 setState 与数组拷贝，会严重阻塞 UI 渲染主线程。
 *    采用 50ms 缓冲队列，将多个事件合并为单次 setState 批量更新，确保 UI 保持 60fps 流畅。
 * 3. 增量合并：无需每次全量重新请求 loadWorkspace，直接在本地状态中增/删/改。
 */
export function useFileMonitoring(
  setState: React.Dispatch<React.SetStateAction<AssetState>>
) {
  // 全量刷新节流：批量事件风暴时 5 秒最多允许一次全量 loadWorkspace 降级
  const lastFullReloadRef = useRef(0);

  // 批量事件缓冲区
  const pendingAddsRef = useRef<Map<string, Asset>>(new Map());
  const pendingModifiesRef = useRef<Map<string, Asset>>(new Map());
  const pendingRemovesRef = useRef<{ ids: Set<string>; paths: Set<string> }>({
    ids: new Set(),
    paths: new Set(),
  });
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    /** 批量执行合并到 React 状态（单次更新，避免 UI 主线程抖动） */
    const flushBatch = () => {
      const adds: Asset[] = Array.from(pendingAddsRef.current.values());
      const modifies = pendingModifiesRef.current;
      const { ids: removeIds, paths: removePaths } = pendingRemovesRef.current;

      pendingAddsRef.current.clear();
      pendingModifiesRef.current.clear();
      pendingRemovesRef.current = { ids: new Set(), paths: new Set() };
      batchTimerRef.current = null;

      if (adds.length === 0 && modifies.size === 0 && removeIds.size === 0 && removePaths.size === 0) {
        return;
      }

      setState(prev => {
        let nextAssets = prev.assets;

        // 1. 先执行删除过滤（O(N) 单次扫描）
        if (removeIds.size > 0 || removePaths.size > 0) {
          nextAssets = nextAssets.filter(a => !removeIds.has(a.id) && !removePaths.has(a.path));
        }

        // 2. 执行修改（O(N) 单次扫描）
        if (modifies.size > 0) {
          nextAssets = nextAssets.map(a => {
            const updated = modifies.get(a.id);
            return updated ? { ...a, ...updated } : a;
          });
        }

        // 3. 执行新增（去重后首部插入）
        if (adds.length > 0) {
          const existingIds = new Set(nextAssets.map(a => a.id));
          const toPrepend = adds.filter(a => !existingIds.has(a.id));
          nextAssets = [...toPrepend, ...nextAssets];
        }

        return { ...prev, assets: nextAssets };
      });
    };

    /** 安排批处理执行（50ms 节流防抖窗口） */
    const scheduleFlush = () => {
      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(flushBatch, 50);
      }
    };

    const triggerFullReloadFallback = () => {
      if (shouldFullReload()) {
        import('../services/dataService').then(({ dataService }) => {
          dataService.loadWorkspace().then(payload => {
            if (payload && payload.assets) {
              setState(prev => ({ ...prev, assets: payload.assets ?? prev.assets }));
            }
          });
        });
      }
    };

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 资产新增：放入缓冲区批量合并
        const unlistenAdd = await listen<FileMonitoringPayload>('asset:added', (ev) => {
          const payload = ev.payload;
          const newAsset = payload?.asset;

          if (newAsset && newAsset.id) {
            pendingAddsRef.current.set(newAsset.id, newAsset);
            scheduleFlush();
          } else {
            triggerFullReloadFallback();
          }
        });

        // 资产删除：放入删除缓冲区批量过滤
        const unlistenRemove = await listen<FileMonitoringPayload>('asset:removed', (ev) => {
          const payload = ev.payload;
          if (!payload) return;
          if (payload.asset_id) {
            pendingRemovesRef.current.ids.add(payload.asset_id);
          }
          if (payload.path) {
            pendingRemovesRef.current.paths.add(payload.path);
          }
          scheduleFlush();
        });

        // 资产修改：放入修改缓冲区批量替换
        const unlistenModify = await listen<FileMonitoringPayload>('asset:modified', (ev) => {
          const payload = ev.payload;
          const updatedAsset = payload?.asset;

          if (updatedAsset && updatedAsset.id) {
            pendingModifiesRef.current.set(updatedAsset.id, updatedAsset);
            scheduleFlush();
          } else {
            triggerFullReloadFallback();
          }
        });

        unlisteners = [unlistenAdd, unlistenRemove, unlistenModify];
      } catch (e) {
        console.warn('[App] 文件监控事件监听器初始化失败（非桌面环境可忽略）:', e);
      }
    };

    setupListeners();

    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      unlisteners.forEach(fn => fn());
    };
  }, [setState]);
}
