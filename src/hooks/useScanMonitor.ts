/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AssetState, Folder } from '../types';
import { runtime } from '../services/api';
import { dataService } from '../services/dataService';
import { normalizeFolders, normalizeAssets } from '../services/api/utils';

/**
 * 后台增量扫描监视器
 *
 * 将「添加监视文件夹」后的全量扫描从 UI 主流程中彻底剥离：
 * - 后台 Rust 扫描通过事件流（scan:started / scan:chunk / scan:finished / scan:failed）
 *   实时推送进度与增量资产；
 * - 本 hook 负责监听事件、把进度汇聚到 progress（供底部进度条渲染），
 *   并把已扫到的文件夹与资产增量合并进 App 状态，实现「边扫边显示」；
 * - 添加监视的模态框可立即关闭，UI 不再被全量扫描卡死。
 */
export interface ScanProgress {
  active: boolean;
  folderName: string;
  path: string;
  total: number;
  done: number;
  status: 'scanning' | 'finished' | 'failed';
  error?: string;
}

const idleProgress: ScanProgress = {
  active: false,
  folderName: '',
  path: '',
  total: 0,
  done: 0,
  status: 'scanning',
};

/**
 * 根据当前已有文件夹判断输入路径是否嵌套在某个已监视文件夹之下（复用旧的层级判定逻辑）
 */
function detectParentId(folders: Folder[], folderPath: string): string | undefined {
  const cleanInput = folderPath.trim().replace(/[/\\]+$/, '').toLowerCase();
  if (!cleanInput) return undefined;
  for (const f of folders) {
    const p = (f.path || '').trim().replace(/[/\\]+$/, '').toLowerCase();
    if (cleanInput.startsWith(p + '\\') || cleanInput.startsWith(p + '/')) {
      return f.id;
    }
  }
  return undefined;
}

export function useScanMonitor(
  setState: Dispatch<SetStateAction<AssetState>>
) {
  const [progress, setProgress] = useState<ScanProgress>(idleProgress);
  // 开始扫描时由调用方基于当时状态探测到的父级文件夹 ID，供 scan:started 合并层级用
  const pendingParentIdRef = useRef<string | undefined>(undefined);

  // 性能优化：增量微批次缓冲区与防抖定时器，防止高频 scan:chunk 导致 React 发生渲染雪崩与主线程假死
  const pendingAssetsBufferRef = useRef<any[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runtime.isDesktop) return;

    let unlisteners: Array<() => void> = [];

    // 将缓冲区中的新资产一次性批量合并进 React State
    const flushBufferToState = () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (pendingAssetsBufferRef.current.length === 0) return;

      const buffer = pendingAssetsBufferRef.current;
      pendingAssetsBufferRef.current = [];
      const normalized = normalizeAssets(buffer);

      // 批次内部去重：同一批扫描 chunk 中可能出现重复资产（多事件源/重叠目录扫描）
      // 仅对 prev.assets 去重不够——同一批次内的重复也会进入 toAdd 造成 React key 冲突
      const seenInBatch = new Set<string>();
      const deduped = normalized.filter(a => {
        if (!a?.id || seenInBatch.has(a.id)) return false;
        seenInBatch.add(a.id);
        return true;
      });

      setState((prev) => {
        const existing = new Set(prev.assets.map((a) => a.id));
        const toAdd = deduped.filter((a) => !existing.has(a.id));
        if (toAdd.length === 0) return prev;
        return { ...prev, assets: [...prev.assets, ...toAdd] };
      });
    };

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // ---- scan:started：目录树就绪（根目录 + 全部子目录 + 文件总数） ----
        const unStarted = await listen<any>('scan:started', (ev) => {
          const payload = ev.payload || {};
          const root: any = payload.root_folder;
          const subs: any[] = payload.sub_folders || [];
          const total: number = payload.total ?? 0;
          const parentId = pendingParentIdRef.current;

          const rootName: string = root?.name ?? progress.folderName;
          setProgress((prev) => ({
            ...prev,
            active: true,
            folderName: rootName,
            path: root?.path ?? prev.path,
            total,
            done: 0,
            status: 'scanning',
          }));

          if (root || subs.length > 0) {
            // 规范化根目录，若存在父级监视目录则挂到其下，保证树形层级完整
            const normRoot: any = { ...root, parentId: parentId ?? root?.parentId ?? undefined };
            const incoming = normalizeFolders([normRoot, ...subs].filter(Boolean));

            setState((prev) => {
              const existing = new Set(prev.folders.map((f) => f.id));
              const toAdd = incoming.filter((f) => !existing.has(f.id));
              if (toAdd.length === 0) return prev;

              const toExpand = toAdd
                .filter((f) => f.parentId === undefined || f.parentId === root?.id || f.parentId === parentId)
                .map((f) => f.id);

              return {
                ...prev,
                folders: [...prev.folders, ...toAdd],
                expandedFolderIds: Array.from(
                  new Set([...prev.expandedFolderIds, ...toExpand].filter(Boolean))
                ),
              };
            });
          }
          pendingParentIdRef.current = undefined;
        });

        // ---- scan:chunk：资产推入缓冲池，120ms 平滑批量刷入 State ----
        const unChunk = await listen<any>('scan:chunk', (ev) => {
          const payload = ev.payload || {};
          const assets: any[] = payload.assets || [];
          const done: number = payload.done ?? 0;
          const total: number = payload.total ?? 0;
          
          // 进度数值轻量更新（单字段低开销）
          setProgress((prev) => ({ ...prev, done, total }));

          if (assets.length > 0) {
            pendingAssetsBufferRef.current.push(...assets);

            // 120ms 节流窗口：如果定时器未挂起，则调度一次批量刷入
            if (!flushTimerRef.current) {
              flushTimerRef.current = window.setTimeout(flushBufferToState, 120);
            }
          }
        });

        // ---- scan:finished：全部完成，先清空剩余缓冲区，短暂停留后隐藏进度条 ----
        const unFinished = await listen<any>('scan:finished', (ev) => {
          flushBufferToState();
          const payload = ev.payload || {};
          const root: any = payload.root_folder;
          setProgress((prev) => ({
            ...prev,
            status: 'finished',
            done: payload.total_files_scanned ?? prev.done,
            total: payload.total_files_scanned ?? prev.total,
            active: true,
            folderName: root?.name ?? prev.folderName,
          }));
          setTimeout(() => setProgress((prev) => ({ ...prev, active: false })), 1500);
        });

        // ---- scan:failed：出错后清空剩余缓冲并提示 ----
        const unFailed = await listen<any>('scan:failed', (ev) => {
          flushBufferToState();
          const payload = ev.payload || {};
          setProgress((prev) => ({
            ...prev,
            status: 'failed',
            error: payload.error,
            active: true,
          }));
          setTimeout(() => setProgress((prev) => ({ ...prev, active: false })), 3500);
        });

        unlisteners = [unStarted, unChunk, unFinished, unFailed];
      } catch (e) {
        console.warn('[ScanMonitor] 扫描事件监听器初始化失败（非桌面环境可忽略）:', e);
      }
    };

    setup();

    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      unlisteners.forEach((fn) => { if (fn) fn(); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState]);

  /**
   * 发起后台增量扫描。桌面环境下立即返回，模态框可随之关闭，UI 不被阻塞。
   */
  const startScan = async (
    folderPath: string,
    folderName: string,
    state: AssetState
  ): Promise<void> => {
    pendingParentIdRef.current = detectParentId(state.folders, folderPath);

    if (runtime.isDesktop) {
      await dataService.startScanDirectory(folderPath.trim());
      setProgress((prev) => ({
        ...prev,
        active: true,
        path: folderPath,
        folderName: folderName || (folderPath.split(/[/\\]/).filter(Boolean).pop() ?? ''),
        total: 0,
        done: 0,
        status: 'scanning',
      }));
      return;
    }

    // Web 预览环境：无后台扫描，立即结束（上层会走原有模拟流程）
    setProgress(idleProgress);
  };

  return { progress, startScan };
}
