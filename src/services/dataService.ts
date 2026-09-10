/**
 * ============================================================================
 * 统一数据服务（dataService）
 *
 * 【架构变更】DataService 已重构为统一 API 中间件的薄封装。
 * 所有数据操作均转发到 `apiClient`（Provider 策略模式），
 * 由 apiClient 自动路由到桌面 Rust IPC 或 Web Express HTTP。
 *
 * 保留本文件是为了向后兼容旧代码调用。
 * 新代码请直接 import { apiClient } from './api'。
 * ============================================================================
 */

import { apiClient } from './api';
import type { Folder, Tag, Collection, SmartFolder, WorkspaceShell, AssetQuery, AssetPage, FolderQuery, FolderPage, AssetDetail, AssetMutation, MutationSummary } from '../types';

// ============================================================================
// 兼容导出：保留原有 isTauriDesktop / 环境判断 API
// ============================================================================
export { isTauriDesktop } from './api';

class DataService {
  /** 环境描述（调试日志用） */
  private get envLabel(): string {
    return apiClient.envLabel;
  }

  private log(method: string, message: string) {
    console.log(`[DataService]${this.envLabel} ${method}: ${message}`);
  }

  // ------------------------------------------------------------------------
  // 数据加载
  // ------------------------------------------------------------------------

  getWorkspaceShell(): Promise<WorkspaceShell> {
    return apiClient.getWorkspaceShell();
  }

  queryAssets(query: AssetQuery): Promise<AssetPage> {
    return apiClient.queryAssets(query);
  }

  queryFolders(query: FolderQuery): Promise<FolderPage> {
    return apiClient.queryFolders(query);
  }

  getAssetDetails(ids: string[]): Promise<AssetDetail[]> {
    return apiClient.getAssetDetails(ids);
  }

  mutateAssets(mutation: AssetMutation): Promise<MutationSummary> {
    return apiClient.mutateAssets(mutation);
  }

  /** 后台增量扫描本地目录（事件流推送进度与增量资产），命令立即返回 */
  async startScanDirectory(dirPath: string): Promise<string | null> {
    this.log('startScanDirectory', `后台增量扫描目录: ${dirPath}`);
    return await apiClient.startScanDirectory(dirPath);
  }

  /** 懒加载生成资产缩略图 */
  async getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null> {
    return await apiClient.getAssetThumbnail(assetId, path, existingThumbnailUrl);
  }

  /**
   * 直接从磁盘读取缩略图文件并返回 base64 data URL。
   * 用于绕过 asset:// 协议可能出现的 404 兼容性问题。
   * Web 模式下无本地文件系统访问能力，直接返回 null。
   */
  async loadThumbnailBase64(filePath: string): Promise<string | null> {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string>('read_thumbnail_base64', { filePath });
      } catch (err) {
        console.warn(`[DataService] read_thumbnail_base64 调用失败:`, err);
        return null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------
  // 资产操作
  // ------------------------------------------------------------------------

  async setAssetRating(id: string, rating: number): Promise<void> {
    apiClient.setAssetRating(id, rating).catch(console.error);
  }

  async setAssetFavorite(id: string, favorite: boolean): Promise<void> {
    apiClient.setAssetFavorite(id, favorite).catch(console.error);
  }

  async deleteAssets(ids: string[]): Promise<void> {
    apiClient.deleteAssets(ids).catch(console.error);
  }

  /** 同步设置资产标签关联（全量替换） */
  async syncAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await apiClient.syncAssetTags(assetId, tagIds);
  }

  /** 同步设置资产集合关联（全量替换） */
  async syncAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await apiClient.syncAssetCollections(assetId, collectionIds);
  }

  /** 批量同步多个资产的标签 */
  async syncManyAssetTags(assetIds: string[], tagIds: string[]): Promise<void> {
    await apiClient.syncManyAssetTags(assetIds, tagIds);
  }

  /** 批量同步多个资产的集合 */
  async syncManyAssetCollections(assetIds: string[], collectionIds: string[]): Promise<void> {
    await apiClient.syncManyAssetCollections(assetIds, collectionIds);
  }

  /** 从资产移除指定标签 */
  async removeAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await apiClient.removeAssetTags(assetId, tagIds);
  }

  /** 从资产移除指定集合 */
  async removeAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await apiClient.removeAssetCollections(assetId, collectionIds);
  }

  // ------------------------------------------------------------------------
  // 文件夹 CRUD（兼容两种调用方式：完整对象 或 id+updates）
  // ------------------------------------------------------------------------

  /** 创建文件夹 */
  async createFolder(folder: Folder): Promise<void> {
    apiClient.createFolder(folder).catch(console.error);
  }

  /** 重命名文件夹：直接调用后端 rename_folder 命令，避免全量 loadWorkspace */
  async renameFolder(id: string, newName: string): Promise<void> {
    // 直接通过 IPC 调用 Rust 的 rename_folder（避免 loadWorkspace 拉取全量数据）
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('rename_folder', { id, newName });
        return;
      } catch (e) {
        console.warn('[DataService] rename_folder IPC 调用失败，降级处理:', e);
      }
    }
    // 降级：Web 模式或 IPC 失败时
    const shell = await apiClient.getWorkspaceShell();
    const target = shell.roots.find(f => f.id === id);
    if (target) {
      apiClient.updateFolder({ ...target, name: newName }).catch(console.error);
    }
  }

  /**
   * 更新文件夹详细属性
   * 兼容调用方式：
   *   - dataService.updateFolder(完整Folder对象) — 直接调用 IPC
   *   - dataService.updateFolder(id, updates) — 需调用方从 state 获取完整对象后传入
   *     不再内部 loadWorkspace 全量拉取（避免大库卡顿）
   */
  async updateFolder(idOrItem: string | Folder, updates?: Partial<Folder>): Promise<void> {
    if (typeof idOrItem === 'object') {
      console.log(`[Monitor][DataService] 提交 update_folder 后端: id=${idOrItem.id}, path=${idOrItem.path}, isMonitored=${idOrItem.isMonitored}`);
      apiClient.updateFolder(idOrItem).catch(console.error);
    } else {
      console.warn('[DataService] 请勿使用 updateFolder(id, updates) 形式调用，'
        + '应传完整 Folder 对象。为兼容旧代码，使用 rename_folder IPC 直接更新。');
      if (updates && updates.name && Object.keys(updates).length === 1) {
        // 仅改名场景 → 直接调用后端 rename_folder
        await this.renameFolder(idOrItem, updates.name);
      }
    }
  }

  /** 删除文件夹 */
  async deleteFolder(id: string): Promise<void> {
    apiClient.deleteFolder(id).catch(console.error);
  }

  // ------------------------------------------------------------------------
  // 标签 CRUD（兼容两种调用方式）
  // ------------------------------------------------------------------------

  /** 创建标签 */
  async createTag(tag: Tag): Promise<void> {
    apiClient.createTag(tag).catch(console.error);
  }

  /**
   * 更新标签
   * 兼容调用方式：
   *   - dataService.updateTag(完整Tag对象) — 直接调用 IPC
   *   - dataService.updateTag(id, updates) — 需调用方从 state 获取完整对象后传入
   */
  async updateTag(idOrItem: string | Tag, updates?: Partial<Tag>): Promise<void> {
    if (typeof idOrItem === 'object') {
      apiClient.updateTag(idOrItem).catch(console.error);
    } else {
      console.warn('[DataService] 请勿使用 updateTag(id, updates) 形式调用，'
        + '应传完整 Tag 对象，避免内部全量 loadWorkspace。');
    }
  }

  /** 删除标签 */
  async deleteTag(id: string): Promise<void> {
    apiClient.deleteTag(id).catch(console.error);
  }

  // ------------------------------------------------------------------------
  // 集合 CRUD（兼容两种调用方式）
  // ------------------------------------------------------------------------

  /** 创建集合 */
  async createCollection(col: Collection): Promise<void> {
    apiClient.createCollection(col).catch(console.error);
  }

  /**
   * 更新集合
   * 兼容调用方式：
   *   - dataService.updateCollection(完整Collection对象) — 直接调用 IPC
   *   - dataService.updateCollection(id, updates) — 需调用方从 state 获取完整对象后传入
   */
  async updateCollection(idOrItem: string | Collection, updates?: Partial<Collection>): Promise<void> {
    if (typeof idOrItem === 'object') {
      apiClient.updateCollection(idOrItem).catch(console.error);
    } else {
      console.warn('[DataService] 请勿使用 updateCollection(id, updates) 形式调用，'
        + '应传完整 Collection 对象，避免内部全量 loadWorkspace。');
    }
  }

  /** 删除集合 */
  async deleteCollection(id: string): Promise<void> {
    apiClient.deleteCollection(id).catch(console.error);
  }

  // ------------------------------------------------------------------------
  // 智能文件夹
  // ------------------------------------------------------------------------

  /** 保存/更新智能文件夹 */
  async saveSmartFolder(sf: SmartFolder): Promise<void> {
    apiClient.saveSmartFolder(sf).catch(console.error);
  }

  /** 更新智能文件夹（等同 save） */
  async updateSmartFolder(sf: SmartFolder): Promise<void> {
    await this.saveSmartFolder(sf);
  }

  /** 删除智能文件夹 */
  async deleteSmartFolder(id: string): Promise<void> {
    apiClient.deleteSmartFolder(id).catch(console.error);
  }

  // ------------------------------------------------------------------------
  // 系统操作
  // ------------------------------------------------------------------------

  /** 在资源管理器中定位文件 */
  async openInExplorer(path: string): Promise<void> {
    apiClient.openInExplorer(path).catch(console.error);
  }

  /** 获取存储统计 */
  async getStorageStats(): Promise<import('../types').StorageStats> {
    return await apiClient.getStorageStats();
  }

  /** 完整数据迁移 */
  async migrateDataStorage(newPath: string): Promise<string> {
    return await apiClient.migrateDataStorage(newPath);
  }

  /** 重启应用 */
  async restartApplication(): Promise<void> {
    await apiClient.restartApplication();
  }
}

export const dataService = new DataService();
