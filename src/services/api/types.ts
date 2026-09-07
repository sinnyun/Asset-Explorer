/**
 * ============================================================================
 * 统一 API 中间件 - 契约接口定义
 *
 * 职责：定义所有 Provider（桌面 Rust IPC / Web HTTP REST）必须实现的统一接口。
 * 通过此接口层，前端只依赖 ApiProvider，不感知底层实现细节。
 *
 * 修改任一侧后端（Rust / Express）均不会影响前端调用方，
 * 只需保证实现满足 ApiProvider 接口即可。
 * ============================================================================
 */

import type {
  Asset, Folder, Tag, Collection, SmartFolder,
  AssetState, StorageStats,
} from '../../types';

/** 工作区扫描结果 */
export interface ScanResult {
  root_folder: Folder;
  sub_folders: Folder[];
  assets: Asset[];
  total_files_scanned: number;
  total_duration_ms: number;
}

/**
 * ============================================================================
 * 统一 API 接口契约 (ApiProvider)
 *
 * 所有后端 Provider 必须实现此接口的所有方法。
 * 前端通过 apiClient 调用时只依赖此接口。
 * ============================================================================
 */
export interface ApiProvider {
  // ------------------------------------------------------------------------
  // 环境与平台能力
  // ------------------------------------------------------------------------
  /** 是否桌面 Tauri 环境 */
  readonly isDesktop: boolean;

  /** 当前平台名称 */
  readonly platform: 'desktop' | 'web';

  /** 获取当前环境运行状态 */
  readonly envLabel: string;

  // ------------------------------------------------------------------------
  // 数据加载与扫描
  // ------------------------------------------------------------------------
  /** 加载完整工作区数据（资产、文件夹、标签、集合、智能文件夹） */
  loadWorkspace(): Promise<Partial<AssetState>>;

  /** 扫描本地目录并返回结果 */
  scanDirectory(path: string): Promise<ScanResult | null>;

  /** 后台增量扫描本地目录（通过事件流推送进度与增量资产），命令立即返回 */
  startScanDirectory(path: string): Promise<void>;

  /** 懒加载获取资产缩略图（base64 data URL） */
  getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null>;

  /** 初始化示例工作区数据（Web端登录云端提供一键导入） */
  seedWorkspace?(): Promise<boolean>;

  /** 校验资产有效性（删除数据库中文件已不存在的记录） */
  validateAssets(): Promise<void>;

  // ------------------------------------------------------------------------
  // 资产操作
  // ------------------------------------------------------------------------
  /** 更新资产评分 */
  setAssetRating(id: string, rating: number): Promise<void>;

  /** 更新资产收藏状态 */
  setAssetFavorite(id: string, favorite: boolean): Promise<void>;

  /** 批量删除资产 */
  deleteAssets(ids: string[]): Promise<void>;

  /** 同步设置资产标签关联（全量替换） */
  syncAssetTags(assetId: string, tagIds: string[]): Promise<void>;

  /** 同步设置资产集合关联（全量替换） */
  syncAssetCollections(assetId: string, collectionIds: string[]): Promise<void>;

  /** 批量同步多个资产的标签（添加） */
  syncManyAssetTags(assetIds: string[], tagIds: string[]): Promise<void>;

  /** 批量同步多个资产的集合（添加） */
  syncManyAssetCollections(assetIds: string[], collectionIds: string[]): Promise<void>;

  /** 从资产移除指定标签 */
  removeAssetTags(assetId: string, tagIds: string[]): Promise<void>;

  /** 从资产移除指定集合 */
  removeAssetCollections(assetId: string, collectionIds: string[]): Promise<void>;

  // ------------------------------------------------------------------------
  // 文件夹 CRUD（更新时传完整对象）
  // ------------------------------------------------------------------------
  /** 创建文件夹 */
  createFolder(folder: Folder): Promise<void>;

  /** 更新文件夹（传完整对象，包含全部字段） */
  updateFolder(folder: Folder): Promise<void>;

  /** 删除文件夹 */
  deleteFolder(id: string): Promise<void>;

  // ------------------------------------------------------------------------
  // 标签 CRUD（更新时传完整对象）
  // ------------------------------------------------------------------------
  /** 创建标签 */
  createTag(tag: Tag): Promise<void>;

  /** 更新标签（传完整对象，包含全部字段） */
  updateTag(tag: Tag): Promise<void>;

  /** 删除标签 */
  deleteTag(id: string): Promise<void>;

  // ------------------------------------------------------------------------
  // 集合 CRUD（更新时传完整对象）
  // ------------------------------------------------------------------------
  /** 创建集合 */
  createCollection(col: Collection): Promise<void>;

  /** 更新集合（传完整对象，包含全部字段） */
  updateCollection(col: Collection): Promise<void>;

  /** 删除集合 */
  deleteCollection(id: string): Promise<void>;

  // ------------------------------------------------------------------------
  // 智能文件夹 CRUD
  // ------------------------------------------------------------------------
  /** 创建或更新智能文件夹 */
  saveSmartFolder(sf: SmartFolder): Promise<void>;

  /** 删除智能文件夹 */
  deleteSmartFolder(id: string): Promise<void>;

  // ------------------------------------------------------------------------
  // 系统操作
  // ------------------------------------------------------------------------
  /** 打开资源管理器定位文件（仅桌面有效） */
  openInExplorer(path: string): Promise<void>;

  /** 弹出系统文件夹选取对话框（仅桌面有效） */
  pickDirectory(): Promise<string | null>;

  /** 获取存储统计 */
  getStorageStats(): Promise<StorageStats>;

  /** 完整数据迁移 */
  migrateDataStorage(newPath: string): Promise<string>;

  /** 重启应用 */
  restartApplication(): Promise<void>;
}
