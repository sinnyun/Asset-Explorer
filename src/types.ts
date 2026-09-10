export type AssetType = 'image' | 'video' | 'audio' | 'model' | '3d' | 'document' | 'archive' | 'other' | 'folder';

export interface Tag {
  id: string;
  name: string;
  color: string;
  description?: string;
  isPinned?: boolean;
  order?: number;
}

export interface Collection {
  id: string;
  name: string;
  color?: string;
  description?: string;
  isPinned?: boolean;
  order?: number;
}

export interface SmartFolderRule {
  id: string;
  type: 'name' | 'tag' | 'collection' | 'type';
  operator: 'contains' | 'equals';
  value: string;
}

export interface SmartFolder {
  id: string;
  name: string;
  icon: string;
  description?: string;
  filter?: (asset: Asset) => boolean;
  rules?: SmartFolderRule[];
  matchAll?: boolean;
  isSearchHistory?: boolean;
  isPinned?: boolean;
  order?: number;
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  size: number; // in bytes
  dateModified: string;
  dateAdded: string;
  path: string;
  folderId: string;
  tags: string[]; // tag IDs
  collections: string[]; // collection IDs
  thumbnailUrl?: string;
  /** 图片/视频宽度 (像素) — 从 Rust 后端提取 */
  width?: number;
  /** 图片/视频高度 (像素) — 从 Rust 后端提取 */
  height?: number;
  /** 文件 SHA-256 哈希值 — 从 Rust 后端提取 */
  fileHash?: string;
  /** 兼容旧接口: "1920x1080" 格式 */
  dimensions?: string;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  isMonitored: boolean;
  parentId?: string;
  tags: string[];
  collections: string[];
  description?: string;
  isPinned?: boolean;
  order?: number;
}

export type SidebarTab = 'folders' | 'smart' | 'tags' | 'collections';

export interface SelectionItem {
  id: string;
  type: 'asset' | 'folder';
}

export type SortOption = 'name_asc' | 'name_desc' | 'date_modified_desc' | 'date_modified_asc' | 'size_desc' | 'size_asc';
export type ThemeMode = 'light' | 'dark' | 'system';

export type AssetSort = 'name_asc' | 'name_desc' | 'modified_desc' | 'modified_asc' | 'size_desc' | 'size_asc';

export interface AssetQuery {
  rootId?: string;
  folderId?: string;
  includeDescendants?: boolean;
  search?: string;
  tagIds?: string[];
  collectionIds?: string[];
  types?: string[];
  rating?: number;
  favorite?: boolean;
  sort?: AssetSort;
  cursor?: string;
  limit?: number;
}

export interface AssetSummary {
  id: string;
  name: string;
  path: string;
  type: string;
  size: number;
  folderId?: string;
  mtimeNs: number;
  rating: number;
  favorite: boolean;
  color?: string;
  width?: number;
  height?: number;
  recordVersion: number;
}

export interface AssetDetail extends AssetSummary {
  normalizedPath: string;
  customName?: string;
  notes?: string;
}

export interface AssetPage {
  items: AssetSummary[];
  nextCursor?: string;
  totalApprox?: number;
  queryRevision: number;
  limit: number;
}

export interface FolderQuery {
  rootId?: string;
  parentId?: string;
  cursor?: string;
  limit?: number;
}

export interface FolderSummary {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  isMonitored: boolean;
  assetCount: number;
  hasChildren: boolean;
  recordVersion: number;
}

export interface FolderPage {
  items: FolderSummary[];
  nextCursor?: string;
  limit: number;
}

export interface WorkspaceShell {
  roots: Folder[];
  tags: Tag[];
  collections: Collection[];
  smartFolders: SmartFolder[];
  revision: number;
}

export interface SelectionExpression {
  query: AssetQuery;
  excludedIds: string[];
}

export interface AssetMutationPatch {
  rating?: number;
  favorite?: boolean;
  color?: string;
}

export interface AssetMutation {
  operationId: string;
  ids: string[];
  selection?: SelectionExpression;
  expectedVersion?: number;
  patch: AssetMutationPatch;
}

export interface MutationSummary {
  affected: number;
  revision: number;
}

export interface StorageStats {
  data_dir: string;
  db_size_bytes: number;
  thumbnails_size_bytes: number;
  total_size_bytes: number;
  asset_count: number;
}

export interface AssetState {
  assets: Asset[];
  folders: Folder[];
  tags: Tag[];
  collections: Collection[];
  selectedItems: SelectionItem[];
  activeFolderId: string | null;
  activeSmartFolderId: string | null;
  activeTagId: string | null;
  activeCollectionId: string | null;
  activeSidebarTab: SidebarTab;
  expandedFolderIds: string[];
  collapsedGroupIds: string[];
  searchQuery: string;
  viewMode: 'grid' | 'list';
  groupByFolder: boolean;
  includeSubfolders: boolean;
  customSmartFolders: SmartFolder[];
  sortOption: SortOption;
  theme: ThemeMode;
}
