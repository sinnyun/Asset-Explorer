import type { Asset, Folder } from '../types';

export const UNASSIGNED_GROUP_ID = '__unassigned__';

export type GroupedAssetItem =
  | { kind: 'header'; groupId: string; folder: Folder; assetCount: number }
  | { kind: 'asset'; groupId: string; asset: Asset };

export function buildGroupedAssetItems(
  assets: Asset[],
  folders: Folder[],
  collapsedGroupIds: string[],
): GroupedAssetItem[] {
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const groups = new Map<string, { folder: Folder; assets: Asset[] }>();
  const unassigned: Folder = {
    id: UNASSIGNED_GROUP_ID,
    name: '未分类文件夹',
    path: '',
    isMonitored: false,
    tags: [],
    collections: [],
  };

  const folderFromAsset = (asset: Asset): Folder => {
    const pathParts = asset.path.split(/[\\/]/).filter(Boolean);
    const path = pathParts.length > 1 ? pathParts.slice(0, -1).join(asset.path.includes('\\') ? '\\' : '/') : '';
    return {
      id: asset.folderId,
      name: pathParts.length > 1 ? pathParts[pathParts.length - 2] : '未命名文件夹',
      path,
      isMonitored: false,
      tags: [],
      collections: [],
    };
  };

  for (const asset of assets) {
    const groupId = asset.folderId || UNASSIGNED_GROUP_ID;
    const folder = foldersById.get(groupId) ?? (groupId === UNASSIGNED_GROUP_ID ? unassigned : folderFromAsset(asset));
    const group = groups.get(groupId) ?? { folder, assets: [] };
    group.assets.push(asset);
    groups.set(groupId, group);
  }

  return Array.from(groups.entries())
    .sort(([, left], [, right]) => {
      if (left.folder.id === UNASSIGNED_GROUP_ID) return 1;
      if (right.folder.id === UNASSIGNED_GROUP_ID) return -1;
      return left.folder.path.localeCompare(right.folder.path);
    })
    .flatMap(([groupId, group]) => {
      const items: GroupedAssetItem[] = [{ kind: 'header', groupId, folder: group.folder, assetCount: group.assets.length }];
      if (!collapsedGroupIds.includes(groupId)) {
        items.push(...group.assets.map(asset => ({ kind: 'asset' as const, groupId, asset })));
      }
      return items;
    });
}
