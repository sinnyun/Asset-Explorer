/**
 * ============================================================================
 * 模块：统一数据服务引擎 (dataService.ts)
 * 职责：
 * 1. 严格实现“前端纯显示，数据与数据库操作全在后端”的架构原则。
 * 2. 所有的增删改查操作通过非阻塞异步通道提交给 Rust 后端 SQLite 数据库。
 * 3. 保证前端界面绝不发生任何卡顿或线程堵塞。
 * ============================================================================
 */

import { Asset, Folder, Tag, Collection, SmartFolder, AssetState } from '../types';
import { mockAssets, mockFolders, mockTags, mockCollections } from '../data';
import * as bridge from './desktopBridge';

class DataService {
  /**
   * 异步加载工作区数据
   * 优先从 Rust 后端 SQLite 读取；若在 Web 预览环境中，则加载初始数据。
   */
  async loadWorkspace(): Promise<Partial<AssetState>> {
    if (bridge.isTauriDesktop()) {
      try {
        const payload = await bridge.loadWorkspaceFromRustDb();
        if (payload && (payload.folders.length > 0 || payload.assets.length > 0)) {
          return {
            folders: payload.folders,
            tags: payload.tags,
            collections: payload.collections,
            customSmartFolders: payload.smart_folders,
            assets: payload.assets,
          };
        }
      } catch (err) {
        console.warn('[DataService] 从 Rust SQLite 加载失败，采用默认数据:', err);
      }
    }

    // Web 环境或首次空库降级
    return {
      folders: mockFolders,
      tags: mockTags,
      collections: mockCollections,
      customSmartFolders: [],
      assets: mockAssets,
    };
  }

  /**
   * 异步触发后端扫描并持久化目录 (绝不阻塞 UI 渲染)
   */
  async scanDirectory(dirPath: string): Promise<bridge.RustScanResult | null> {
    return await bridge.scanLocalDirectoryViaRust(dirPath);
  }

  /**
   * 异步更新资产评分
   */
  async setAssetRating(id: string, rating: number): Promise<void> {
    if (bridge.isTauriDesktop()) {
      // 投递后台异步执行，不等待立即返回或并发处理
      bridge.setAssetRatingViaRust(id, rating).catch(console.error);
    }
  }

  /**
   * 异步更新资产收藏状态
   */
  async setAssetFavorite(id: string, favorite: boolean): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.setAssetFavoriteViaRust(id, favorite).catch(console.error);
    }
  }

  /**
   * 异步批量删除资产
   */
  async deleteAssets(ids: string[]): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.deleteAssetsViaRust(ids).catch(console.error);
    }
  }

  /**
   * 异步创建文件夹
   */
  async createFolder(folder: Folder): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.createFolderViaRust(folder).catch(console.error);
    }
  }

  /**
   * 异步重命名文件夹
   */
  async renameFolder(id: string, newName: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.renameFolderViaRust(id, newName).catch(console.error);
    }
  }

  /**
   * 异步更新文件夹详细属性 (包括置顶、排序、描述等)
   */
  async updateFolder(idOrItem: string | Folder, updates?: Partial<Folder>): Promise<void> {
    if (bridge.isTauriDesktop()) {
      const folder = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Folder : idOrItem;
      bridge.updateFolderViaRust(folder).catch(console.error);
    }
  }

  /**
   * 异步删除文件夹
   */
  async deleteFolder(id: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.deleteFolderViaRust(id).catch(console.error);
    }
  }

  /**
   * 异步创建标签
   */
  async createTag(tag: Tag): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.createTagViaRust(tag).catch(console.error);
    }
  }

  /**
   * 异步更新标签详细属性 (重命名、颜色、描述、置顶、排序)
   */
  async updateTag(idOrItem: string | Tag, updates?: Partial<Tag>): Promise<void> {
    if (bridge.isTauriDesktop()) {
      const tag = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Tag : idOrItem;
      bridge.updateTagViaRust(tag).catch(console.error);
    }
  }

  /**
   * 异步删除标签
   */
  async deleteTag(id: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.deleteTagViaRust(id).catch(console.error);
    }
  }

  /**
   * 异步创建集合
   */
  async createCollection(col: Collection): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.createCollectionViaRust(col).catch(console.error);
    }
  }

  /**
   * 异步更新集合详细属性 (重命名、颜色、描述、置顶、排序)
   */
  async updateCollection(idOrItem: string | Collection, updates?: Partial<Collection>): Promise<void> {
    if (bridge.isTauriDesktop()) {
      const col = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Collection : idOrItem;
      bridge.updateCollectionViaRust(col).catch(console.error);
    }
  }

  /**
   * 异步删除集合
   */
  async deleteCollection(id: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.deleteCollectionViaRust(id).catch(console.error);
    }
  }

  /**
   * 异步保存/更新智能文件夹
   */
  async saveSmartFolder(sf: SmartFolder): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.saveSmartFolderViaRust(sf).catch(console.error);
    }
  }

  /**
   * 异步更新智能文件夹详细属性
   */
  async updateSmartFolder(sf: SmartFolder): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.saveSmartFolderViaRust(sf).catch(console.error);
    }
  }

  /**
   * 异步删除智能文件夹
   */
  async deleteSmartFolder(id: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.deleteSmartFolderViaRust(id).catch(console.error);
    }
  }

  /**
   * 在 Windows 资源管理器中定位文件
   */
  async openInExplorer(path: string): Promise<void> {
    if (bridge.isTauriDesktop()) {
      bridge.openInWindowsExplorer(path).catch(console.error);
    }
  }

  /**
   * 获取本地存储空间占用统计 (数据库、缩略图缓存等)
   */
  async getStorageStats(): Promise<bridge.RustStorageStats> {
    if (bridge.isTauriDesktop()) {
      const stats = await bridge.getStorageStatsViaRust();
      if (stats) return stats;
    }
    return {
      data_dir: 'C:\\Users\\User\\AppData\\Local\\AssetHub',
      db_size_bytes: 2457600, // 2.4 MB
      thumbnails_size_bytes: 8388608, // 8 MB
      total_size_bytes: 10846208,
      asset_count: 120,
    };
  }

  /**
   * 完整数据迁移 (原子拷贝数据库与缩略图，更新配置)
   */
  async migrateDataStorage(newPath: string): Promise<string> {
    if (bridge.isTauriDesktop()) {
      const res = await bridge.migrateDataStorageViaRust(newPath);
      if (res) return res;
      throw new Error("Rust 后端迁移返回空响应");
    }
    // Web 预览环境模拟
    await new Promise(r => setTimeout(r, 1200));
    return `[模拟成功] 数据已迁移至 ${newPath}，应用将重启。`;
  }

  /**
   * 重启桌面客户端应用
   */
  async restartApplication(): Promise<void> {
    if (bridge.isTauriDesktop()) {
      await bridge.restartApplicationViaRust();
    } else {
      window.location.reload();
    }
  }
}

export const dataService = new DataService();

