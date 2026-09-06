/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { runtime } from '../services/api';
import { dataService } from '../services/dataService';
import type { AssetState } from '../types';

/**
 * 扫描本地文件夹并添加监视
 */
export async function handleConfirmAddAndScan(
  folderPath: string,
  folderName: string,
  _isMonitored: boolean,
  state: AssetState,
  setState: React.Dispatch<React.SetStateAction<AssetState>>
): Promise<void> {
  const cleanInput = folderPath.trim().replace(/[/\\]+$/, '').toLowerCase();
  
  // 自动判定层级关系
  let detectedParentId: string | undefined = undefined;
  const existingParent = state.folders.find(f => {
    const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
    return cleanInput.startsWith(p + '\\') || cleanInput.startsWith(p + '/');
  });

  if (existingParent) {
    detectedParentId = existingParent.id;
  }

  if (runtime.isDesktop) {
    const result = await dataService.scanDirectory(folderPath.trim());
    if (result) {
      const root = {
        ...result.root_folder,
        name: folderName || result.root_folder.name,
        isMonitored: true,
        parentId: detectedParentId || result.root_folder.parentId,
      };

      const updatedExisting = state.folders.map(f => {
        const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
        if (p.startsWith(cleanInput + '\\') || p.startsWith(cleanInput + '/')) {
          return { ...f, parentId: root.id };
        }
        return f;
      });

      setState(p => ({
        ...p,
        folders: [...updatedExisting, root, ...result.sub_folders],
        assets: [...p.assets, ...result.assets],
        activeFolderId: root.id,
        activeSidebarTab: 'folders',
        expandedFolderIds: Array.from(new Set([...p.expandedFolderIds, root.id, ...(detectedParentId ? [detectedParentId] : [])]))
      }));
      return;
    }
  }

  // Web 预览环境模拟真实嵌套添加与扫描流程
  const newRootId = `monitored_${Date.now()}`;
  const newRootFolder = {
    id: newRootId,
    name: folderName || 'MonitoredWorkspace',
    path: folderPath,
    parentId: detectedParentId,
    isMonitored: true,
    tags: ['workspace'],
    collections: []
  };

  // 模拟生成两个子文件夹
  const subFolder1 = {
    id: `${newRootId}_sub1`,
    name: 'HighRes_Textures',
    path: `${folderPath}\\HighRes_Textures`,
    parentId: newRootId,
    isMonitored: false,
    tags: ['texture'],
    collections: []
  };
  const subFolder2 = {
    id: `${newRootId}_sub2`,
    name: 'Render_Outputs',
    path: `${folderPath}\\Render_Outputs`,
    parentId: newRootId,
    isMonitored: false,
    tags: ['render'],
    collections: []
  };

  // 模拟写入扫描素材
  const mockNewAssets = [
    {
      id: `asset_${Date.now()}_1`,
      name: `${folderName}_hero_render.png`,
      path: `${folderPath}\\${folderName}_hero_render.png`,
      size: 4892010,
      type: 'image' as const,
      folderId: newRootId,
      tags: ['render', 'hero'],
      collections: [],
      rating: 5,
      isFavorite: true,
      thumbnailUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&auto=format&fit=crop&q=60',
      dateModified: new Date().toISOString(),
      metadata: { width: 3840, height: 2160, format: 'PNG', colorSpace: 'sRGB' }
    },
    {
      id: `asset_${Date.now()}_2`,
      name: `albedo_wood_4k.jpg`,
      path: `${folderPath}\\HighRes_Textures\\albedo_wood_4k.jpg`,
      size: 3120400,
      type: 'image' as const,
      folderId: subFolder1.id,
      tags: ['texture'],
      collections: [],
      rating: 4,
      isFavorite: false,
      thumbnailUrl: 'https://images.unsplash.com/photo-1546484396-fb3fc6f95f98?w=500&auto=format&fit=crop&q=60',
      dateModified: new Date().toISOString(),
      metadata: { width: 4096, height: 4096, format: 'JPEG' }
    }
  ];

  // 更新现有文件夹并建立层级继承
  const updatedExisting = state.folders.map(f => {
    const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
    if (p.startsWith(cleanInput + '\\') || p.startsWith(cleanInput + '/')) {
      return { ...f, parentId: newRootId };
    }
    return f;
  });

  dataService.createFolder(newRootFolder);
  dataService.createFolder(subFolder1);
  dataService.createFolder(subFolder2);

  setState(p => ({
    ...p,
    folders: [...updatedExisting, newRootFolder, subFolder1, subFolder2],
    assets: [...p.assets, ...mockNewAssets],
    activeFolderId: newRootId,
    activeSidebarTab: 'folders',
    expandedFolderIds: Array.from(new Set([...p.expandedFolderIds, newRootId, subFolder1.id, ...(detectedParentId ? [detectedParentId] : [])]))
  }));
}
