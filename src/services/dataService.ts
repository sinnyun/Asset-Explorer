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
import type { Folder, Tag, Collection, SmartFolder, AssetState } from '../types';
import type { ScanResult } from './api/types';

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

  /** 异步加载工作区数据 */
  async loadWorkspace(): Promise<Partial<AssetState>> {
    this.log('loadWorkspace', '通过统一 API 中间件加载');
    const result = await apiClient.loadWorkspace();
    return result;
  }

  /** 异步触发后端扫描并持久化目录 */
  async scanDirectory(dirPath: string): Promise<ScanResult | null> {
    this.log('scanDirectory', `扫描目录: ${dirPath}`);
    return await apiClient.scanDirectory(dirPath);
  }

  /** 懒加载生成资产缩略图 */
  async getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null> {
    return await apiClient.getAssetThumbnail(assetId, path, existingThumbnailUrl);
  }

  /** 校验资产有效性 */
  async validateAssets(): Promise<void> {
    await apiClient.validateAssets();
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

  // ------------------------------------------------------------------------
  // 文件夹 CRUD（兼容两种调用方式：完整对象 或 id+updates）
  // ------------------------------------------------------------------------

  /** 创建文件夹 */
  async createFolder(folder: Folder): Promise<void> {
    apiClient.createFolder(folder).catch(console.error);
  }

  /** 重命名文件夹 */
  async renameFolder(id: string, newName: string): Promise<void> {
    // 先获取已有数据补全完整对象
    const state = await apiClient.loadWorkspace();
    const target = (state.folders || []).find(f => f.id === id);
    if (target) {
      apiClient.updateFolder({ ...target, name: newName }).catch(console.error);
    }
  }

  /**
   * 更新文件夹详细属性
   * 兼容调用方式：
   *   - dataService.updateFolder(完整Folder对象)
   *   - dataService.updateFolder(id, updates)
   */
  async updateFolder(idOrItem: string | Folder, updates?: Partial<Folder>): Promise<void> {
    if (typeof idOrItem === 'object') {
      apiClient.updateFolder(idOrItem).catch(console.error);
    } else {
      // 需要从现有状态中获取完整 Folder
      const state = await apiClient.loadWorkspace();
      const target = (state.folders || []).find(f => f.id === idOrItem);
      if (target) {
        apiClient.updateFolder({ ...target, ...updates }).catch(console.error);
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
   *   - dataService.updateTag(完整Tag对象)
   *   - dataService.updateTag(id, updates)
   */
  async updateTag(idOrItem: string | Tag, updates?: Partial<Tag>): Promise<void> {
    if (typeof idOrItem === 'object') {
      apiClient.updateTag(idOrItem).catch(console.error);
    } else {
      const state = await apiClient.loadWorkspace();
      const target = (state.tags || []).find(t => t.id === idOrItem);
      if (target) {
        apiClient.updateTag({ ...target, ...updates }).catch(console.error);
      }
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
   *   - dataService.updateCollection(完整Collection对象)
   *   - dataService.updateCollection(id, updates)
   */
  async updateCollection(idOrItem: string | Collection, updates?: Partial<Collection>): Promise<void> {
    if (typeof idOrItem === 'object') {
      apiClient.updateCollection(idOrItem).catch(console.error);
    } else {
      const state = await apiClient.loadWorkspace();
      const target = (state.collections || []).find(c => c.id === idOrItem);
      if (target) {
        apiClient.updateCollection({ ...target, ...updates }).catch(console.error);
      }
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
