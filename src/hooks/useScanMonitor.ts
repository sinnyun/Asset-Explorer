import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AssetState } from '../types';
import { runtime } from '../services/api';
import { dataService } from '../services/dataService';
import { mergeFolderSummaries } from '../services/folderTree';

export interface ScanProgress {
  active: boolean;
  folderName: string;
  path: string;
  total: number;
  done: number;
  phase: 'discovering' | 'indexing' | 'persisting' | 'finished';
  ratePerSecond: number;
  etaSeconds?: number;
  status: 'scanning' | 'finished' | 'failed';
  error?: string;
}

const idleProgress: ScanProgress = {
  active: false,
  folderName: '',
  path: '',
  total: 0,
  done: 0,
  phase: 'discovering',
  ratePerSecond: 0,
  status: 'scanning',
};

export function useScanMonitor(setState: Dispatch<SetStateAction<AssetState>>) {
  const [progress, setProgress] = useState<ScanProgress>(idleProgress);
  const folderRefreshGeneration = useRef(0);

  const refreshFolderCache = async () => {
    const generation = ++folderRefreshGeneration.current;
    try {
      const [shell, rootPage] = await Promise.all([
        dataService.getWorkspaceShell(),
        dataService.queryFolders({ limit: 300 }),
      ]);
      if (generation !== folderRefreshGeneration.current) return;
      setState(previous => ({
        ...previous,
        folders: mergeFolderSummaries(shell.roots.map(folder => ({ ...folder, tags: [], collections: [] })), rootPage.items),
        tags: shell.tags,
        collections: shell.collections,
        customSmartFolders: shell.smartFolders,
      }));
    } catch (error) {
      console.warn('[ScanMonitor] 刷新文件夹缓存失败:', error);
    }
  };

  useEffect(() => {
    if (!runtime.isDesktop) return;
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const unStarted = await listen<{ path?: string; folderName?: string; phase?: ScanProgress['phase']; total?: number }>('scan:started', event => {
        const path = event.payload?.path ?? '';
        setProgress(previous => ({
          ...previous,
          active: true,
          path,
          folderName: event.payload?.folderName ?? previous.folderName,
          done: 0,
          total: Number.isFinite(event.payload?.total) ? Math.max(0, event.payload?.total ?? 0) : 0,
          phase: event.payload?.phase ?? 'discovering',
          ratePerSecond: 0,
          etaSeconds: undefined,
          status: 'scanning',
        }));
        void refreshFolderCache();
      });
      const unProgress = await listen<{ done?: number; total?: number; phase?: ScanProgress['phase']; ratePerSecond?: number; etaSeconds?: number | null }>('scan:progress', event => {
        const total = Number.isFinite(event.payload?.total) ? Math.max(0, event.payload?.total ?? 0) : 0;
        const ratePerSecond = Number.isFinite(event.payload?.ratePerSecond) ? Math.max(0, event.payload?.ratePerSecond ?? 0) : 0;
        const etaSeconds = Number.isFinite(event.payload?.etaSeconds) ? Math.max(0, event.payload?.etaSeconds ?? 0) : undefined;
        setProgress(previous => ({
          ...previous,
          done: event.payload?.done ?? previous.done,
          total: total || previous.total,
          phase: event.payload?.phase ?? 'indexing',
          ratePerSecond,
          etaSeconds,
        }));
      });
      const unFinished = await listen<{ totalFilesScanned?: number }>('scan:finished', event => {
        const totalFilesScanned = event.payload?.totalFilesScanned ?? 0;
        setProgress(previous => ({
          ...previous,
          active: true,
          status: 'finished',
          done: totalFilesScanned,
          total: totalFilesScanned,
          phase: 'finished',
          ratePerSecond: previous.ratePerSecond,
        }));
        void refreshFolderCache();
        setTimeout(() => setProgress(previous => ({ ...previous, active: false })), 1500);
      });
      const unFailed = await listen<{ error?: string }>('scan:failed', event => {
        setProgress(previous => ({
          ...previous,
          active: true,
          status: 'failed',
          error: event.payload?.error,
        }));
        setTimeout(() => setProgress(previous => ({ ...previous, active: false })), 3500);
      });
      if (disposed) {
        [unStarted, unProgress, unFinished, unFailed].forEach(stop => stop());
      } else {
        unlisteners = [unStarted, unProgress, unFinished, unFailed];
      }
    }).catch(error => console.warn('[ScanMonitor] 无法注册扫描事件:', error));
    return () => {
      disposed = true;
      unlisteners.forEach(stop => stop());
    };
  }, []);

  const startScan = async (
    folderPath: string,
    folderName: string,
    _state: AssetState,
  ): Promise<void> => {
    if (!runtime.isDesktop) {
      setProgress(idleProgress);
      return;
    }
    await dataService.startScanDirectory(folderPath.trim());
    setProgress({
      active: true,
      path: folderPath,
      folderName: folderName || (folderPath.split(/[/\\]/).filter(Boolean).pop() ?? ''),
      total: 0,
      done: 0,
      phase: 'discovering',
      ratePerSecond: 0,
      status: 'scanning',
    });
  };

  return { progress, startScan };
}
