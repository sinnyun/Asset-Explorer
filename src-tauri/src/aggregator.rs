//! ============================================================================
//! 模块：数据聚合 (aggregator.rs)
//! 职责：负责对内存与库中的资产数据进行多维聚合分析、统计计数、分类分箱以及智能规则匹配。
//! 依赖开源库：`rayon`, `serde`, `serde_json`
//! ============================================================================

use crate::models::{AggregationReport, Asset, SmartFolder, SmartFolderRule};
use rayon::prelude::*;
use std::collections::HashMap;

/// 对当前资产列表进行多维度的聚合统计分析
pub fn aggregate_asset_metrics(assets: &[Asset]) -> AggregationReport {
    let total_assets = assets.len();
    let total_bytes: u64 = assets.iter().map(|a| a.size).sum();

    let mut type_counts: HashMap<String, usize> = HashMap::new();
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut collection_counts: HashMap<String, usize> = HashMap::new();
    let mut folder_counts: HashMap<String, usize> = HashMap::new();
    let mut rating_distribution: HashMap<u8, usize> = HashMap::new();
    let mut size_buckets: HashMap<String, usize> = HashMap::new();
    let mut format_extensions: HashMap<String, usize> = HashMap::new();

    // 初始化大小分箱计数
    size_buckets.insert("< 1 MB".to_string(), 0);
    size_buckets.insert("1 MB - 10 MB".to_string(), 0);
    size_buckets.insert("10 MB - 100 MB".to_string(), 0);
    size_buckets.insert("> 100 MB".to_string(), 0);

    for asset in assets {
        // 1. 类型聚合
        *type_counts.entry(asset.asset_type.clone()).or_insert(0) += 1;

        // 2. 文件夹聚合
        *folder_counts.entry(asset.folder_id.clone()).or_insert(0) += 1;

        // 3. 标签聚合
        for tag in &asset.tags {
            *tag_counts.entry(tag.clone()).or_insert(0) += 1;
        }

        // 4. 集合聚合
        for col in &asset.collections {
            *collection_counts.entry(col.clone()).or_insert(0) += 1;
        }

        // 5. 评分分布聚合
        *rating_distribution.entry(asset.rating).or_insert(0) += 1;

        // 6. 大小分箱聚合
        let mb = asset.size as f64 / (1024.0 * 1024.0);
        if mb < 1.0 {
            *size_buckets.get_mut("< 1 MB").unwrap() += 1;
        } else if mb <= 10.0 {
            *size_buckets.get_mut("1 MB - 10 MB").unwrap() += 1;
        } else if mb <= 100.0 {
            *size_buckets.get_mut("10 MB - 100 MB").unwrap() += 1;
        } else {
            *size_buckets.get_mut("> 100 MB").unwrap() += 1;
        }

        // 7. 格式后缀名聚合
        if let Some(pos) = asset.name.rfind('.') {
            let ext = asset.name[pos + 1..].to_lowercase();
            *format_extensions.entry(ext).or_insert(0) += 1;
        }
    }

    AggregationReport {
        total_assets,
        total_bytes,
        type_counts,
        tag_counts,
        collection_counts,
        folder_counts,
        rating_distribution,
        size_buckets,
        format_extensions,
    }
}

/// 匹配单条规则
fn evaluate_single_rule(asset: &Asset, rule: &SmartFolderRule) -> bool {
    let val_lower = rule.value.to_lowercase();
    match rule.rule_type.as_str() {
        "name" => match rule.operator.as_str() {
            "contains" => asset.name.to_lowercase().contains(&val_lower),
            "equals" => asset.name.to_lowercase() == val_lower,
            _ => false,
        },
        "type" => match rule.operator.as_str() {
            "equals" | "contains" => asset.asset_type.to_lowercase() == val_lower,
            _ => false,
        },
        "tag" => match rule.operator.as_str() {
            "contains" | "equals" => asset.tags.iter().any(|t| t.to_lowercase().contains(&val_lower)),
            _ => false,
        },
        "collection" => match rule.operator.as_str() {
            "contains" | "equals" => asset.collections.iter().any(|c| c.to_lowercase().contains(&val_lower)),
            _ => false,
        },
        "size" => {
            let threshold: u64 = rule.value.parse().unwrap_or(0);
            match rule.operator.as_str() {
                "greater_than" => asset.size > threshold,
                "less_than" => asset.size < threshold,
                _ => false,
            }
        }
        _ => true,
    }
}

/// 评估智能文件夹匹配资产（支持 Rayon 并发过滤）
pub fn filter_assets_by_smart_folder(assets: &[Asset], smart_folder: &SmartFolder) -> Vec<String> {
    let rules = match &smart_folder.rules {
        Some(r) if !r.is_empty() => r,
        _ => return assets.iter().map(|a| a.id.clone()).collect(),
    };

    let match_all = smart_folder.match_all.unwrap_or(true);

    assets
        .par_iter()
        .filter(|asset| {
            if match_all {
                rules.iter().all(|rule| evaluate_single_rule(asset, rule))
            } else {
                rules.iter().any(|rule| evaluate_single_rule(asset, rule))
            }
        })
        .map(|a| a.id.clone())
        .collect()
}
