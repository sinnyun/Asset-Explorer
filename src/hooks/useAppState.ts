/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useState, useEffect, useRef } from 'react';
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
 *
 * 优化：
 * 1. 消除二次全量 loadWorkspace：之前 validateAssets 后再 reload 一次 workspace，
 *    对于大资产库会做 2 次完整数据拉取（数百 MB JSON）。
 *    - 方案：改为只加载一次；资产校验交给后端启动 setup 后台线程完成。
 *    - 前端不再调用 validateAssets，因为 Rust setup 已在启动时后台执行。
 * 2. 首次 loadWorkspace 超时保护：若 IPC 尚未就绪重试最多 3 次。
 */
export function useAppState() {
  const [state, setState] = useState<AssetState>(getInitialState);
  const loadAttemptRef = useRef(0);

  // Load only the compact workspace shell. Asset rows are owned by useAssetQuery.
  useEffect(() => {
    const loadOnce = async () => {
      loadAttemptRef.current += 1;
      try {
        const shell = await dataService.getWorkspaceShell();
        setState(prev => ({
          ...prev,
          folders: shell.roots.map(folder => ({ ...folder, tags: [], collections: [] })),
          tags: shell.tags,
          collections: shell.collections,
          customSmartFolders: shell.smartFolders,
          assets: [],
        }));
      } catch (err) {
        console.error('[App] 初始化加载工作区数据失败:', err);
        if (loadAttemptRef.current < 3) {
          setTimeout(loadOnce, 800);
        }
      }
    };
    loadOnce();
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
