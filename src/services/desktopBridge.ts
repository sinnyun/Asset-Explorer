/**
 * ============================================================================
 * 【已废弃】desktopBridge.ts - 兼容转发层
 *
 * 此文件已被统一 API 中间件替代。
 * 新代码请通过 `./api` 入口访问 apiClient。
 * 本文件仅保留以向后兼容旧有调用方。
 * ============================================================================
 */

import { apiClient } from './api';
import { isTauriDesktop as detectTauriDesktop } from './api';

/** 兼容导出：检测是否为 Tauri 桌面环境 */
export function isTauriDesktop(): boolean {
  return detectTauriDesktop();
}

/** 兼容导出：弹出文件夹选择对话框 */
export async function pickDirectoryViaDialog(): Promise<string | null> {
  return await apiClient.pickDirectory();
}

/** 兼容导出：打开资源管理器 */
export async function openInWindowsExplorer(filePath: string): Promise<boolean> {
  try {
    await apiClient.openInExplorer(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- 以下全部为向后兼容的空壳函数（不再被 dataService 使用） ---

export async function loadWorkspaceFromRustDb() { return null; }
export async function scanLocalDirectoryViaRust() { return null; }
export async function setAssetRatingViaRust() { return false; }
export async function setAssetFavoriteViaRust() { return false; }
export async function deleteAssetsViaRust() { return false; }
export async function getThumbnailViaRust() { return null; }
export async function readThumbnailBase64() { return null; }
export async function createFolderViaRust() { return false; }
export async function updateFolderViaRust() { return false; }
export async function renameFolderViaRust() { return false; }
export async function deleteFolderViaRust() { return false; }
export async function createTagViaRust() { return false; }
export async function updateTagViaRust() { return false; }
export async function deleteTagViaRust() { return false; }
export async function createCollectionViaRust() { return false; }
export async function updateCollectionViaRust() { return false; }
export async function deleteCollectionViaRust() { return false; }
export async function saveSmartFolderViaRust() { return false; }
export async function deleteSmartFolderViaRust() { return false; }
export async function aggregateDataViaRust() { return null; }
export async function filterSmartFolderViaRust() { return null; }
export async function getSystemInfoViaRust() { return null; }
export async function getStorageStatsViaRust() { return null; }
export async function migrateDataStorageViaRust() { return null; }
export async function restartApplicationViaRust() {}
export async function validateAssetsViaRust() { return null; }
