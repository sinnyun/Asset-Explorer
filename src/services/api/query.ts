import type { AssetQuery } from '../../types';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

export function normalizeAssetQuery(input: AssetQuery): Required<Pick<AssetQuery, 'limit' | 'sort' | 'includeDescendants'>> & AssetQuery {
  const search = input.search?.trim() || undefined;
  return {
    ...input,
    search,
    tagIds: sortedUnique(input.tagIds),
    collectionIds: sortedUnique(input.collectionIds),
    types: sortedUnique(input.types),
    includeDescendants: input.includeDescendants ?? false,
    sort: input.sort ?? 'name_asc',
    limit: Math.max(1, Math.min(MAX_LIMIT, Math.trunc(input.limit ?? DEFAULT_LIMIT))),
  };
}

export function stableAssetQueryKey(input: AssetQuery): string {
  const query = normalizeAssetQuery({ ...input, cursor: undefined });
  return JSON.stringify({
    rootId: query.rootId,
    folderId: query.folderId,
    includeDescendants: query.includeDescendants,
    search: query.search,
    tagIds: query.tagIds,
    collectionIds: query.collectionIds,
    types: query.types,
    rating: query.rating,
    favorite: query.favorite,
    sort: query.sort,
    limit: query.limit,
  });
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function assetDisplayGroupKey(asset: { folderId?: string; path: string }): string {
  if (asset.folderId) return asset.folderId;
  const parentPath = asset.path.replace(/[\\/][^\\/]+$/, '').toLowerCase();
  return `virtual:${parentPath}`;
}
