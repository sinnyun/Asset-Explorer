/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { Asset, AssetState, Folder } from '../types';
import { runtime } from '../services/api';

/** 资产监控事件载荷类型定义 */
interface FileMonitoringPayload {
  asset_id?: string;
  path?: string;
  asset?: Asset;
}

/** 文件夹监控事件载荷类型（对应后端 FolderChangeEvent，字段为 Rust Folder 序列化子集） */
interface FolderMonitoringPayload {
  folder?: {
    id: string;
    name: string;
    path: string;
    parentId?: string | null;
    isMonitored?: boolean;
    mtime?: string | null;
  };
  action?: string; // "added" | "updated" | "removed"
}

/** 标准化路径以便稳定对比（全部反斜杠，去末尾分隔符，小写） */
const cleanPath = (p: string) => p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** 将后端文件夹载荷映射为前端 Folder 状态（补齐 tags/collections 等前端默认字段） */
const toFrontendFolder = (f: NonNullable<FolderMonitoringPayload['folder']>): Folder => ({
  id: f.id,
  name: f.name,
  path: f.path,
  isMonitored: f.isMonitored ?? false,
  parentId: f.parentId ?? undefined,
  tags: [],
  collections: [],
});

/** 判断子路径是否位于某文件夹路径（兼容反斜杠/正斜杠与大小写） */
const isUnderFolder = (childPath: string, folderPath: string): boolean => {
  const c = cleanPath(childPath);
  const f = cleanPath(folderPath);
  if (c === f) return true;
  return c.startsWith(`${f}\\`) || c.startsWith(`${f}/`);
};

/**
 * 桌面模式：监听文件监控器实时事件（资产新增/删除/修改、文件夹增删改）
 *
 * 核心保障：
 * 1. 强类型载荷与路径归一化对比，彻底避免 Windows 路径大小写和斜杠导致的过滤失配。
 * 2. 事件微批处理（Micro-batching）：50ms 缓冲队列合并高频事件，保护 UI 60fps 流畅。
 * 3. 文件夹联动资产：文件夹被删除时，文件夹节点与整棵子孙树资产联动移除。
 * 4. 窗口聚焦自动触发增量对账：切屏修改文件切回时，毫秒级主动对账并更新视图。
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

      const normRemovePaths = new Set(Array.from(removePaths).map(cleanPath));

      setState(prev => {
        let nextAssets = prev.assets;

        // 1. 先执行删除过滤（支持 ID 与归一化绝对路径匹配）
        if (removeIds.size > 0 || normRemovePaths.size > 0) {
          nextAssets = nextAssets.filter(
            a => !removeIds.has(a.id) && !removePaths.has(a.path) && !normRemovePaths.has(cleanPath(a.path))
          );
        }

        // 2. 执行修改（原位精准更新）
        if (modifies.size > 0) {
          nextAssets = nextAssets.map(a => {
            const updated = modifies.get(a.id);
            return updated ? { ...a, ...updated } : a;
          });
        }

        // 3. 执行新增（已存在原位更新，不存在则首部插入）
        if (adds.length > 0) {
          const existingMap = new Map<string, number>(nextAssets.map((a, idx) => [a.id, idx]));
          const brandNew: Asset[] = [];

          for (const newA of adds) {
            const existingIdx = existingMap.get(newA.id);
            if (existingIdx !== undefined && typeof existingIdx === 'number') {
              nextAssets[existingIdx] = { ...nextAssets[existingIdx], ...newA };
            } else {
              brandNew.push(newA);
            }
          }

          if (brandNew.length > 0) {
            // brandNew 内部也去重
            const seenInBrandNew = new Set<string>();
            const uniqueBrandNew = brandNew.filter(a => {
              if (seenInBrandNew.has(a.id)) return false;
              seenInBrandNew.add(a.id);
              return true;
            });
            nextAssets = [...uniqueBrandNew, ...nextAssets];
          }
        }

        // 4. 兜底去重：确保整个 assets 数组中 id 全局唯一
        const seenAll = new Set<string>();
        const uniqueAll: typeof nextAssets = [];
        for (const a of nextAssets) {
          if (!seenAll.has(a.id)) {
            seenAll.add(a.id);
            uniqueAll.push(a);
          }
        }
        if (uniqueAll.length !== nextAssets.length) {
          nextAssets = uniqueAll;
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
          console.log('[Monitor][前端] 收到 asset:added 事件:', newAsset?.path ?? payload?.path ?? '(空)');

          if (newAsset && newAsset.id) {
            pendingAddsRef.current.set(newAsset.id, newAsset);
            scheduleFlush();
          } else {
            console.warn('[Monitor][前端] asset:added 缺少完整资产载荷，触发全量刷新兜底');
            triggerFullReloadFallback();
          }
        });

        // 资产删除：放入删除缓冲区批量过滤
        const unlistenRemove = await listen<FileMonitoringPayload>('asset:removed', (ev) => {
          const payload = ev.payload;
          if (!payload) return;
          console.log('[Monitor][前端] 收到 asset:removed 事件:', payload.path ?? payload.asset_id ?? '(空)');
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
          console.log('[Monitor][前端] 收到 asset:modified 事件:', updatedAsset?.path ?? payload?.path ?? '(空)');

          if (updatedAsset && updatedAsset.id) {
            pendingModifiesRef.current.set(updatedAsset.id, updatedAsset);
            scheduleFlush();
          } else {
            console.warn('[Monitor][前端] asset:modified 缺少完整资产载荷，触发全量刷新兜底');
            triggerFullReloadFallback();
          }
        });

        // 文件夹新增：目录树实时上屏（按 id 与规整路径双重去重）
        const unlistenFolderAdd = await listen<FolderMonitoringPayload>('folder:added', (ev) => {
          const folder = ev.payload?.folder;
          console.log('[Monitor][前端] 收到 folder:added:', folder?.path ?? '(空)');
          if (!folder?.id) return;
          const newF = toFrontendFolder(folder);
          const newNorm = cleanPath(newF.path);
          setState(prev => {
            if (prev.folders.some(f => f.id === newF.id || cleanPath(f.path) === newNorm)) return prev;
            return { ...prev, folders: [...prev.folders, newF] };
          });
        });

        // 文件夹更新：按 id / 路径原位替换
        const unlistenFolderUpdate = await listen<FolderMonitoringPayload>('folder:updated', (ev) => {
          const folder = ev.payload?.folder;
          console.log('[Monitor][前端] 收到 folder:updated:', folder?.path ?? '(空)');
          if (!folder?.id) return;
          const updatedF = toFrontendFolder(folder);
          const updatedNorm = cleanPath(updatedF.path);
          setState(prev => ({
            ...prev,
            folders: prev.folders.map(f => (f.id === updatedF.id || cleanPath(f.path) === updatedNorm ? { ...f, ...updatedF } : f)),
          }));
        });

        // 文件夹删除：移除该文件夹及其整棵子孙树，同时移除其中的全部资产
        const unlistenFolderRemove = await listen<FolderMonitoringPayload>('folder:removed', (ev) => {
          const folder = ev.payload?.folder;
          console.log('[Monitor][前端] 收到 folder:removed:', folder?.path ?? '(空)');
          if (!folder?.id) return;
          const path = folder.path;
          setState(prev => ({
            ...prev,
            folders: prev.folders.filter(f => f.id !== folder.id && !isUnderFolder(f.path, path)),
            assets: prev.assets.filter(a => a.folderId !== folder.id && !isUnderFolder(a.path, path)),
          }));
        });

        unlisteners = [
          unlistenAdd,
          unlistenRemove,
          unlistenModify,
          unlistenFolderAdd,
          unlistenFolderUpdate,
          unlistenFolderRemove,
        ];
      } catch (e) {
        console.warn('[App] 文件监控事件监听器初始化失败（非桌面环境可忽略）:', e);
      }
    };

    setupListeners();

    // 当用户切屏回到应用时，自动触发一次增量对账，确保切屏期间的文件改动立即同步
    const handleFocus = () => {
      import('../services/dataService').then(({ dataService }) => {
        dataService.reconcileMonitoredFolders();
      });
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('focus', handleFocus);
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      unlisteners.forEach(fn => fn());
    };
  }, [setState]);
}
