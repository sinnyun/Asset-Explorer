export type AssetType = 'image' | 'video' | 'model' | 'document' | 'folder';

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
  dimensions?: string; // for images/videos e.g., "1920x1080"
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
