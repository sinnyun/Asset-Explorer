/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useState, useEffect } from 'react';
import type { AssetState } from '../types';
import { dataService } from '../services/dataService';

/**
 * 初始状态懒初始化：始终使用空数据，不依赖环境检测
 *
 * 原因：`runtime.isDesktop`（检查 __TAURI_INTERNALS__）在 React 初始化时可能尚未注入，
 * 导致第一帧渲染错误地使用了 mock 数据（C:/Workspace 路径）。
 * 而 C:/Workspace 这些路径只应存在于 Web 开发环境的模拟数据中，不应出现在桌面模式。
 *
 * 数据加载由 loadWorkspace 在 useEffect 中异步完成：
 * - 桌面模式 → Rust SQLite（实际监视文件夹路径，如 D:\桌面文件夹\测试\...）
 * - Web 模式 → Web API / 降级到 mock 数据
 */
export function getInitialState(): AssetState {
  return {
    assets: [],
    folders: [],
    tags: [],
    collections: [],
    selectedItems: [],
    activeFolderId: null,
    activeSmartFolderId: 'sf_all',
    activeTagId: null,
    activeCollectionId: null,
    activeSidebarTab: 'smart',
    expandedFolderIds: [],
    collapsedGroupIds: [],
    searchQuery: '',
    viewMode: 'grid',
    groupByFolder: true,
    includeSubfolders: true,
    customSmartFolders: [],
    sortOption: 'name_asc',
    theme: 'dark'
  };
}

/**
 * App 主状态管理：初始数据加载与主题同步
 */
export function useAppState() {
  const [state, setState] = useState<AssetState>(getInitialState);

  // 1. 初始化从后端 SQLite 异步加载全量数据 (非阻塞)
  useEffect(() => {
    dataService.loadWorkspace().then(loaded => {
      if (loaded) {
        setState(prev => ({ ...prev, ...loaded }));
      }
      dataService.validateAssets().then(() => {
        dataService.loadWorkspace().then(reloaded => {
          if (reloaded) {
            console.log(`[App] 资产校验后重新加载: ${reloaded.assets.length} 个资产`);
            setState(prev => ({ ...prev, ...reloaded }));
          }
        });
      });
    });
  }, []);

  // Apply Theme
  useEffect(() => {
    if (state.theme === 'dark' || (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [state.theme]);

  return { state, setState };
}
