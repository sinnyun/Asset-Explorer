use serde::{Deserialize, Serialize};

/// 文件系统可重建事实。该类型刻意不包含任何用户标记字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileFact {
    pub id: String,
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    pub path: String,
    #[serde(rename = "normalizedPath")]
    pub normalized_path: String,
    pub name: String,
    pub extension: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub mime: Option<String>,
    pub size: u64,
    #[serde(rename = "mtimeNs")]
    pub mtime_ns: i64,
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    #[serde(rename = "fileId")]
    pub file_id: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(rename = "metadataStatus")]
    pub metadata_status: String,
    pub generation: i64,
}

/// 用户可编辑状态补丁，与文件事实写入通道完全分离。
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetUserPatch {
    #[serde(rename = "assetId")]
    pub asset_id: String,
    pub rating: Option<u8>,
    pub favorite: Option<bool>,
    pub color: Option<String>,
    #[serde(rename = "customName")]
    pub custom_name: Option<String>,
    pub notes: Option<String>,
}

#[cfg(test)]
impl AssetUserPatch {
    pub fn rating(asset_id: impl Into<String>, rating: u8) -> Self {
        Self {
            asset_id: asset_id.into(),
            rating: Some(rating.min(5)),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MutationSummary {
    pub affected: usize,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetMutationPatch {
    pub rating: Option<u8>,
    pub favorite: Option<bool>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetMutation {
    #[serde(rename = "operationId")]
    pub operation_id: String,
    pub ids: Vec<String>,
    pub selection: Option<SelectionExpression>,
    #[serde(rename = "expectedVersion")]
    pub expected_version: Option<i64>,
    pub patch: AssetMutationPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionExpression {
    pub query: AssetQuery,
    #[serde(rename = "excludedIds")]
    pub excluded_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetDetail {
    pub id: String,
    pub path: String,
    #[serde(rename = "normalizedPath")]
    pub normalized_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub size: u64,
    #[serde(rename = "mtimeNs")]
    pub mtime_ns: i64,
    pub rating: u8,
    pub favorite: bool,
    pub color: Option<String>,
    #[serde(rename = "customName")]
    pub custom_name: Option<String>,
    pub notes: Option<String>,
    #[serde(rename = "tagIds")]
    pub tag_ids: Vec<String>,
    #[serde(rename = "collectionIds")]
    pub collection_ids: Vec<String>,
    #[serde(rename = "recordVersion")]
    pub record_version: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AssetSort {
    #[default]
    NameAsc,
    NameDesc,
    ModifiedDesc,
    ModifiedAsc,
    SizeDesc,
    SizeAsc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AssetQuery {
    #[serde(rename = "rootId")]
    pub root_id: Option<String>,
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    #[serde(rename = "includeDescendants")]
    pub include_descendants: bool,
    pub search: Option<String>,
    #[serde(rename = "tagIds")]
    pub tag_ids: Vec<String>,
    #[serde(rename = "collectionIds")]
    pub collection_ids: Vec<String>,
    pub types: Vec<String>,
    pub rating: Option<u8>,
    pub favorite: Option<bool>,
    pub sort: AssetSort,
    pub cursor: Option<String>,
    pub limit: usize,
}

impl Default for AssetQuery {
    fn default() -> Self {
        Self {
            root_id: None,
            folder_id: None,
            include_descendants: false,
            search: None,
            tag_ids: Vec::new(),
            collection_ids: Vec::new(),
            types: Vec::new(),
            rating: None,
            favorite: None,
            sort: AssetSort::NameAsc,
            cursor: None,
            limit: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub size: u64,
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    #[serde(rename = "mtimeNs")]
    pub mtime_ns: i64,
    pub rating: u8,
    pub favorite: bool,
    pub color: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(rename = "tagIds")]
    pub tag_ids: Vec<String>,
    #[serde(rename = "collectionIds")]
    pub collection_ids: Vec<String>,
    #[serde(rename = "recordVersion")]
    pub record_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetPage {
    pub items: Vec<AssetSummary>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(rename = "totalApprox")]
    pub total_approx: Option<u64>,
    #[serde(rename = "queryRevision")]
    pub query_revision: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FolderQuery {
    #[serde(rename = "rootId")]
    pub root_id: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
}

impl Default for FolderQuery {
    fn default() -> Self {
        Self { root_id: None, parent_id: None, cursor: None, limit: 100 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "isMonitored")]
    pub is_monitored: bool,
    #[serde(rename = "assetCount")]
    pub asset_count: u64,
    #[serde(rename = "hasChildren")]
    pub has_children: bool,
    #[serde(rename = "recordVersion")]
    pub record_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderPage {
    pub items: Vec<FolderSummary>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceShell {
    pub roots: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub collections: Vec<Collection>,
    #[serde(rename = "smartFolders")]
    pub smart_folders: Vec<SmartFolder>,
    pub revision: i64,
}

/// 资产实体模型 (Asset)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub size: u64,
    #[serde(rename = "folderId")]
    pub folder_id: String,
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    #[serde(rename = "dateModified")]
    pub date_modified: String,
    #[serde(rename = "dateAdded")]
    pub date_added: String,
    pub rating: u8,
    pub favorite: bool,
    pub color: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(rename = "fileHash")]
    pub file_hash: Option<String>,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: Option<String>,
}

/// 文件夹实体模型 (Folder)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "isMonitored")]
    pub is_monitored: bool,
    #[serde(rename = "assetCount")]
    pub asset_count: Option<usize>,
    /// 文件夹磁盘修改时间（RFC3339）。用于对账增量剪枝：仅当目录 mtime 与
    /// 库内记录的 mtime 不一致时，才认为该目录存在结构级变化需要深扫。
    /// 前端传入的 Folder JSON 中通常不含该字段，故设为默认缺失。
    #[serde(default)]
    pub mtime: Option<String>,
}

/// 标签实体模型 (Tag)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    #[serde(rename = "isPinned")]
    pub is_pinned: Option<bool>,
    pub count: Option<usize>,
}

/// 集合实体模型 (Collection)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "isPinned")]
    pub is_pinned: Option<bool>,
    pub count: Option<usize>,
}

/// 智能文件夹规则
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartFolderRule {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String, // "name" | "tag" | "collection" | "type" | "size"
    pub operator: String,  // "contains" | "equals" | "greater_than" | "less_than"
    pub value: String,
}

/// 智能文件夹实体模型 (SmartFolder)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartFolder {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub rules: Option<Vec<SmartFolderRule>>,
    #[serde(rename = "matchAll")]
    pub match_all: Option<bool>,
    #[serde(rename = "isSearchHistory")]
    pub is_search_history: Option<bool>,
}

/// 文件夹扫描结果报告
#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub root_folder: Folder,
    pub sub_folders: Vec<Folder>,
    pub assets: Vec<Asset>,
    pub total_files_scanned: usize,
    pub total_duration_ms: u128,
}
