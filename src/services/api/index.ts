/**
 * ============================================================================
 * 统一 API 中间件 - 入口（apiClient）
 *
 * 前端唯一的数据访问入口。
 * 通过 Provider 策略模式，在应用启动时检测环境并注入对应实现：
 *   - 桌面 Tauri → DesktopApiProvider（Rust IPC → SQLite）
 *   - Web（本地/远程）→ WebApiProvider（Express HTTP → PostgreSQL）
 *
 * 所有数据流通均通过此 API 中间件，前端永不直接感知后端实现。
 * 修改桌面 Rust 程序不影响 Web API；修改 Express 不影响桌面端调用方。
 * ============================================================================
 */

import type { ApiProvider, ScanResult } from './types';
import type {
  Folder, Tag, Collection, SmartFolder,
  AssetState, StorageStats,
} from '../../types';

// Re-export types for external use
export type { ApiProvider, ScanResult } from './types';
export { isTauriDesktop } from './providers/desktop';

// ============================================================================
// Provider 实例管理
// ============================================================================

// 静态导入两个 Provider 单例
// 注意：desktopProvider 内部使用 isTauriDesktop() 做运行时判断，
// 非桌面环境时所有 Rust IPC 调用会自动跳过，不会报错。
import { desktopProvider } from './providers/desktop';
import { webProvider } from './providers/web';

/**
 * 运行时环境检测
 * 通过检查 window 上是否存在 Tauri 注入的全局标记
 */
function detectDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

/** 获取当前环境的 API Provider */
function resolveProvider(): ApiProvider {
  return detectDesktop() ? desktopProvider : webProvider;
}

// ============================================================================
// Provider 缓存（环境检测只执行一次，后续方法调用直接使用缓存）
// ============================================================================

let _cachedProvider: ApiProvider | null = null;

function getProvider(): ApiProvider {
  if (!_cachedProvider) {
    _cachedProvider = resolveProvider();
  }
  return _cachedProvider;
}

/**
 * 重置 Provider 缓存（主要用于测试 / 热更新）
 */
export function resetApiClient(): void {
  _cachedProvider = null;
}

// ============================================================================
// 统一 API 客户端（apiClient）
//
// 所有方法均直接转发到当前环境的 Provider。
// 前端组件只需 import { apiClient }，无需关心运行环境。
// ============================================================================

/** 描述当前运行环境的信息 */
export const runtime = {
  /** 当前是否为桌面 Tauri 环境 */
  get isDesktop(): boolean {
    return getProvider().isDesktop;
  },
  /** 当前平台名称 */
  get platform(): 'desktop' | 'web' {
    return getProvider().platform;
  },
  /** 环境描述标签（用于日志/调试） */
  get envLabel(): string {
    return getProvider().envLabel;
  },
};

export const apiClient: ApiProvider = {
  get isDesktop() { return getProvider().isDesktop; },
  get platform() { return getProvider().platform; },
  get envLabel() { return getProvider().envLabel; },

  // ---- 数据加载 ----
  loadWorkspace(): Promise<Partial<AssetState>> {
    return getProvider().loadWorkspace();
  },
  scanDirectory(path: string): Promise<ScanResult | null> {
    return getProvider().scanDirectory(path);
  },
  getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null> {
    return getProvider().getAssetThumbnail(assetId, path, existingThumbnailUrl);
  },
  validateAssets(): Promise<void> {
    return getProvider().validateAssets();
  },

  // ---- 资产操作 ----
  setAssetRating(id: string, rating: number): Promise<void> {
    return getProvider().setAssetRating(id, rating);
  },
  setAssetFavorite(id: string, favorite: boolean): Promise<void> {
    return getProvider().setAssetFavorite(id, favorite);
  },
  deleteAssets(ids: string[]): Promise<void> {
    return getProvider().deleteAssets(ids);
  },
  syncAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    return getProvider().syncAssetTags(assetId, tagIds);
  },
  syncAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    return getProvider().syncAssetCollections(assetId, collectionIds);
  },
  syncManyAssetTags(assetIds: string[], tagIds: string[]): Promise<void> {
    return getProvider().syncManyAssetTags(assetIds, tagIds);
  },
  syncManyAssetCollections(assetIds: string[], collectionIds: string[]): Promise<void> {
    return getProvider().syncManyAssetCollections(assetIds, collectionIds);
  },
  removeAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    return getProvider().removeAssetTags(assetId, tagIds);
  },
  removeAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    return getProvider().removeAssetCollections(assetId, collectionIds);
  },

  // ---- 文件夹 CRUD ----
  createFolder(folder: Folder): Promise<void> {
    return getProvider().createFolder(folder);
  },
  updateFolder(folder: Folder): Promise<void> {
    return getProvider().updateFolder(folder);
  },
  deleteFolder(id: string): Promise<void> {
    return getProvider().deleteFolder(id);
  },

  // ---- 标签 CRUD ----
  createTag(tag: Tag): Promise<void> {
    return getProvider().createTag(tag);
  },
  updateTag(tag: Tag): Promise<void> {
    return getProvider().updateTag(tag);
  },
  deleteTag(id: string): Promise<void> {
    return getProvider().deleteTag(id);
  },

  // ---- 集合 CRUD ----
  createCollection(col: Collection): Promise<void> {
    return getProvider().createCollection(col);
  },
  updateCollection(col: Collection): Promise<void> {
    return getProvider().updateCollection(col);
  },
  deleteCollection(id: string): Promise<void> {
    return getProvider().deleteCollection(id);
  },

  // ---- 智能文件夹 ----
  saveSmartFolder(sf: SmartFolder): Promise<void> {
    return getProvider().saveSmartFolder(sf);
  },
  deleteSmartFolder(id: string): Promise<void> {
    return getProvider().deleteSmartFolder(id);
  },

  // ---- 系统操作 ----
  openInExplorer(path: string): Promise<void> {
    return getProvider().openInExplorer(path);
  },
  pickDirectory(): Promise<string | null> {
    return getProvider().pickDirectory();
  },
  getStorageStats(): Promise<StorageStats> {
    return getProvider().getStorageStats();
  },
  migrateDataStorage(newPath: string): Promise<string> {
    return getProvider().migrateDataStorage(newPath);
  },
  restartApplication(): Promise<void> {
    return getProvider().restartApplication();
  },
};
