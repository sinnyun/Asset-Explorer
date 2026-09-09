import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AssetState } from '../types';
import { runtime } from '../services/api';
import { dataService } from '../services/dataService';

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

export function useScanMonitor(_setState: Dispatch<SetStateAction<AssetState>>) {
  const [progress, setProgress] = useState<ScanProgress>(idleProgress);

  useEffect(() => {
    if (!runtime.isDesktop) return;
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const unStarted = await listen<{ path?: string }>('scan:started', event => {
        const path = event.payload?.path ?? '';
        setProgress(previous => ({ ...previous, active: true, path, done: 0, total: 0, status: 'scanning' }));
      });
      const unProgress = await listen<{ done?: number }>('scan:progress', event => {
        setProgress(previous => ({ ...previous, done: event.payload?.done ?? previous.done }));
      });
      const unFinished = await listen<{ totalFilesScanned?: number }>('scan:finished', event => {
        const totalFilesScanned = event.payload?.totalFilesScanned ?? 0;
        setProgress(previous => ({
          ...previous,
          active: true,
          status: 'finished',
          done: totalFilesScanned,
          total: totalFilesScanned,
        }));
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
      status: 'scanning',
    });
  };

  return { progress, startScan };
}
