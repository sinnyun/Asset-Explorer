use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
}

/// 标签实体模型 (Tag)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub count: Option<usize>,
}

/// 集合实体模型 (Collection)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub root_folder: Folder,
    pub sub_folders: Vec<Folder>,
    pub assets: Vec<Asset>,
    pub total_files_scanned: usize,
    pub total_duration_ms: u128,
}

/// 数据聚合结果 (Aggregation Report)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregationReport {
    pub total_assets: usize,
    pub total_bytes: u64,
    pub type_counts: HashMap<String, usize>,
    pub tag_counts: HashMap<String, usize>,
    pub collection_counts: HashMap<String, usize>,
    pub folder_counts: HashMap<String, usize>,
    pub rating_distribution: HashMap<u8, usize>,
    pub size_buckets: HashMap<String, usize>, // e.g. "< 1MB", "1MB - 10MB", "> 10MB"
    pub format_extensions: HashMap<String, usize>,
}
