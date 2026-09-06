/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { useEffect } from 'react';
import type { AssetState } from '../types';
import { runtime } from '../services/api';
import { dataService } from '../services/dataService';

/**
 * 桌面模式：监听文件监控器实时事件（资产新增/删除/修改）
 */
export function useFileMonitoring(
  setState: React.Dispatch<React.SetStateAction<AssetState>>
) {
  useEffect(() => {
    if (!runtime.isDesktop) return;

    let unlisteners: Array<() => void> = [];

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 资产新增
        const unlistenAdd = await listen<{ asset_id?: string; path: string }>('asset:added', () => {
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
        });

        // 资产删除
        const unlistenRemove = await listen<{ path: string }>('asset:removed', () => {
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
        });

        // 资产修改
        const unlistenModify = await listen<{ asset_id?: string; path: string }>('asset:modified', () => {
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
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
