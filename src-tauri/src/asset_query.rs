use crate::database::Database;
use crate::models::{
    AssetDetail, AssetPage, AssetQuery, AssetSort, AssetSummary, FolderPage, FolderQuery,
    FolderSummary,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::types::Value;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_PAGE_SIZE: usize = 300;

fn attach_asset_relations(conn: &rusqlite::Connection, items: &mut [AssetSummary]) -> Result<(), String> {
    if items.is_empty() { return Ok(()); }
    let ids = items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
    let placeholders = vec!["?"; ids.len()].join(",");
    let tag_sql = format!("SELECT asset_id, tag_id FROM asset_tags WHERE asset_id IN ({placeholders}) ORDER BY asset_id, tag_id");
    let mut tag_stmt = conn.prepare(&tag_sql).map_err(|e| format!("准备资产标签查询失败: {e}"))?;
    let tag_rows = tag_stmt.query_map(params_from_iter(ids.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("读取资产标签失败: {e}"))?;
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    for row in tag_rows { let (asset_id, tag_id) = row.map_err(|e| format!("读取资产标签行失败: {e}"))?; tags.entry(asset_id).or_default().push(tag_id); }

    let collection_sql = format!("SELECT asset_id, collection_id FROM asset_collections WHERE asset_id IN ({placeholders}) ORDER BY asset_id, collection_id");
    let mut collection_stmt = conn.prepare(&collection_sql).map_err(|e| format!("准备资产集合查询失败: {e}"))?;
    let collection_rows = collection_stmt.query_map(params_from_iter(ids.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("读取资产集合失败: {e}"))?;
    let mut collections: HashMap<String, Vec<String>> = HashMap::new();
    for row in collection_rows { let (asset_id, collection_id) = row.map_err(|e| format!("读取资产集合行失败: {e}"))?; collections.entry(asset_id).or_default().push(collection_id); }

    for item in items {
        item.tag_ids = tags.remove(&item.id).unwrap_or_default();
        item.collection_ids = collections.remove(&item.id).unwrap_or_default();
    }
    Ok(())
}

fn attach_detail_relations(conn: &rusqlite::Connection, items: &mut [AssetDetail]) -> Result<(), String> {
    if items.is_empty() { return Ok(()); }
    let ids = items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
    let placeholders = vec!["?"; ids.len()].join(",");
    let load = |table: &str, column: &str| -> Result<HashMap<String, Vec<String>>, String> {
        let sql = format!("SELECT asset_id, {column} FROM {table} WHERE asset_id IN ({placeholders}) ORDER BY asset_id, {column}");
        let mut statement = conn.prepare(&sql).map_err(|e| format!("准备资产关系查询失败: {e}"))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("读取资产关系失败: {e}"))?;
        let mut result = HashMap::new();
        for row in rows { let (asset_id, relation_id) = row.map_err(|e| format!("读取资产关系行失败: {e}"))?; result.entry(asset_id).or_insert_with(Vec::new).push(relation_id); }
        Ok(result)
    };
    let tags = load("asset_tags", "tag_id")?;
    let collections = load("asset_collections", "collection_id")?;
    for item in items {
        item.tag_ids = tags.get(&item.id).cloned().unwrap_or_default();
        item.collection_ids = collections.get(&item.id).cloned().unwrap_or_default();
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct AssetCursor {
    sort: AssetSort,
    text: Option<String>,
    number: Option<i64>,
    id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FolderCursor {
    name: String,
    id: String,
}

fn encode_cursor(cursor: &AssetCursor) -> Result<String, String> {
    serde_json::to_vec(cursor)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|e| format!("编码资产游标失败: {e}"))
}

fn decode_cursor(value: &str, expected_sort: AssetSort) -> Result<AssetCursor, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "资产游标格式无效".to_string())?;
    let cursor: AssetCursor = serde_json::from_slice(&bytes)
        .map_err(|_| "资产游标内容无效".to_string())?;
    if cursor.sort != expected_sort {
        return Err("资产游标与当前排序不匹配".to_string());
    }
    Ok(cursor)
}

pub(crate) fn append_asset_filters(query: &AssetQuery, sql: &mut String, values: &mut Vec<Value>) {
    if let Some(root_id) = query.root_id.as_ref() {
        sql.push_str(" AND a.root_id = ?");
        values.push(root_id.clone().into());
    }
    if let Some(folder_id) = query.folder_id.as_ref() {
        if query.include_descendants {
            sql.push_str(
                " AND a.folder_id IN (
                    WITH RECURSIVE subtree(id) AS (
                        SELECT id FROM folders WHERE id = ?
                        UNION ALL
                        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
                    ) SELECT id FROM subtree
                )",
            );
        } else {
            sql.push_str(" AND a.folder_id = ?");
        }
        values.push(folder_id.clone().into());
    }
    if let Some(search) = query.search.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        sql.push_str(" AND a.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)");
        values.push(format!("\"{}\"", search.replace('"', "\"\"")).into());
    }
    if !query.types.is_empty() {
        sql.push_str(" AND a.asset_type IN (");
        sql.push_str(&vec!["?"; query.types.len()].join(","));
        sql.push(')');
        values.extend(query.types.iter().cloned().map(Value::from));
    }
    if let Some(rating) = query.rating {
        sql.push_str(" AND COALESCE(u.rating, 0) = ?");
        values.push(i64::from(rating.min(5)).into());
    }
    if let Some(favorite) = query.favorite {
        sql.push_str(" AND COALESCE(u.favorite, 0) = ?");
        values.push(i64::from(favorite).into());
    }
    for tag_id in &query.tag_ids {
        sql.push_str(" AND EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id AND at.tag_id = ?)");
        values.push(tag_id.clone().into());
    }
    for collection_id in &query.collection_ids {
        sql.push_str(" AND EXISTS (SELECT 1 FROM asset_collections ac WHERE ac.asset_id = a.id AND ac.collection_id = ?)");
        values.push(collection_id.clone().into());
    }
}

impl Database {
    pub fn query_assets(&self, query: &AssetQuery) -> Result<AssetPage, String> {
        let query = query.clone();
        self.read(move |conn| {
            let limit = query.limit.clamp(1, MAX_PAGE_SIZE);
            let mut sql = String::from(
                "SELECT a.id, a.name, a.path, a.asset_type, a.size, a.folder_id, a.mtime_ns,
                        COALESCE(u.rating, 0), COALESCE(u.favorite, 0), u.color,
                        a.width, a.height, a.record_version
                 FROM assets a
                 LEFT JOIN asset_user_state u ON u.asset_id = a.id
                 WHERE a.deleted_at IS NULL",
            );
            let mut values: Vec<Value> = Vec::new();

            append_asset_filters(&query, &mut sql, &mut values);

            if let Some(raw_cursor) = query.cursor.as_ref() {
                let cursor = decode_cursor(raw_cursor, query.sort)?;
                match query.sort {
                    AssetSort::NameAsc => {
                        let text = cursor.text.ok_or_else(|| "资产名称游标缺少值".to_string())?;
                        sql.push_str(" AND (lower(a.name) > ? OR (lower(a.name) = ? AND a.id > ?))");
                        values.extend([Value::from(text.clone()), Value::from(text), Value::from(cursor.id)]);
                    }
                    AssetSort::NameDesc => {
                        let text = cursor.text.ok_or_else(|| "资产名称游标缺少值".to_string())?;
                        sql.push_str(" AND (lower(a.name) < ? OR (lower(a.name) = ? AND a.id < ?))");
                        values.extend([Value::from(text.clone()), Value::from(text), Value::from(cursor.id)]);
                    }
                    AssetSort::ModifiedDesc | AssetSort::SizeDesc => {
                        let number = cursor.number.ok_or_else(|| "资产数值游标缺少值".to_string())?;
                        let column = if query.sort == AssetSort::ModifiedDesc { "a.mtime_ns" } else { "a.size" };
                        sql.push_str(&format!(" AND ({column} < ? OR ({column} = ? AND a.id < ?))"));
                        values.extend([Value::from(number), Value::from(number), Value::from(cursor.id)]);
                    }
                    AssetSort::ModifiedAsc | AssetSort::SizeAsc => {
                        let number = cursor.number.ok_or_else(|| "资产数值游标缺少值".to_string())?;
                        let column = if query.sort == AssetSort::ModifiedAsc { "a.mtime_ns" } else { "a.size" };
                        sql.push_str(&format!(" AND ({column} > ? OR ({column} = ? AND a.id > ?))"));
                        values.extend([Value::from(number), Value::from(number), Value::from(cursor.id)]);
                    }
                }
            }

            sql.push_str(match query.sort {
                AssetSort::NameAsc => " ORDER BY lower(a.name) ASC, a.id ASC",
                AssetSort::NameDesc => " ORDER BY lower(a.name) DESC, a.id DESC",
                AssetSort::ModifiedDesc => " ORDER BY a.mtime_ns DESC, a.id DESC",
                AssetSort::ModifiedAsc => " ORDER BY a.mtime_ns ASC, a.id ASC",
                AssetSort::SizeDesc => " ORDER BY a.size DESC, a.id DESC",
                AssetSort::SizeAsc => " ORDER BY a.size ASC, a.id ASC",
            });
            sql.push_str(" LIMIT ?");
            values.push(((limit + 1) as i64).into());

            let mut statement = conn.prepare(&sql).map_err(|e| format!("准备资产分页查询失败: {e}"))?;
            let rows = statement
                .query_map(params_from_iter(values.iter()), |row| {
                    Ok(AssetSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        asset_type: row.get(3)?,
                        size: row.get::<_, i64>(4)? as u64,
                        folder_id: row.get(5)?,
                        mtime_ns: row.get(6)?,
                        rating: row.get::<_, i64>(7)? as u8,
                        favorite: row.get::<_, i64>(8)? != 0,
                        color: row.get(9)?,
                        width: row.get(10)?,
                        height: row.get(11)?,
                        tag_ids: Vec::new(),
                        collection_ids: Vec::new(),
                        record_version: row.get(12)?,
                    })
                })
                .map_err(|e| format!("执行资产分页查询失败: {e}"))?;
            let mut items = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取资产分页结果失败: {e}"))?;

            let has_more = items.len() > limit;
            items.truncate(limit);
            attach_asset_relations(conn, &mut items)?;
            let next_cursor = if has_more {
                items.last().map(|last| {
                    let (text, number) = match query.sort {
                        AssetSort::NameAsc | AssetSort::NameDesc => (Some(last.name.to_lowercase()), None),
                        AssetSort::ModifiedDesc | AssetSort::ModifiedAsc => (None, Some(last.mtime_ns)),
                        AssetSort::SizeDesc | AssetSort::SizeAsc => (None, Some(last.size as i64)),
                    };
                    encode_cursor(&AssetCursor { sort: query.sort, text, number, id: last.id.clone() })
                }).transpose()?
            } else {
                None
            };
            let query_revision = conn
                .query_row("SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'revision'", [], |row| row.get(0))
                .map_err(|e| format!("读取查询版本失败: {e}"))?;

            Ok(AssetPage {
                items,
                next_cursor,
                total_approx: None,
                query_revision,
                limit,
            })
        })
    }

    pub fn query_folders(&self, query: &FolderQuery) -> Result<FolderPage, String> {
        let query = query.clone();
        self.read(move |conn| {
            let limit = query.limit.clamp(1, MAX_PAGE_SIZE);
            let mut sql = String::from(
                "SELECT f.id, f.name, f.path, f.parent_id, f.is_monitored, f.record_version,
                        (SELECT COUNT(*) FROM assets a WHERE a.folder_id = f.id AND a.deleted_at IS NULL),
                        EXISTS(SELECT 1 FROM folders child WHERE child.parent_id = f.id)
                 FROM folders f WHERE 1 = 1",
            );
            let mut values: Vec<Value> = Vec::new();
            if let Some(root_id) = query.root_id.as_ref() {
                sql.push_str(" AND f.root_id = ?");
                values.push(root_id.clone().into());
            }
            match query.parent_id.as_ref() {
                Some(parent_id) => {
                    sql.push_str(" AND f.parent_id = ?");
                    values.push(parent_id.clone().into());
                }
                None => sql.push_str(" AND f.parent_id IS NULL"),
            }
            if let Some(cursor) = query.cursor.as_ref() {
                let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| "文件夹游标格式无效".to_string())?;
                let cursor: FolderCursor = serde_json::from_slice(&bytes)
                    .map_err(|_| "文件夹游标内容无效".to_string())?;
                sql.push_str(" AND (lower(f.name) > ? OR (lower(f.name) = ? AND f.id > ?))");
                values.extend([
                    Value::from(cursor.name.clone()),
                    Value::from(cursor.name),
                    Value::from(cursor.id),
                ]);
            }
            sql.push_str(" ORDER BY lower(f.name) ASC, f.id ASC LIMIT ?");
            values.push(((limit + 1) as i64).into());

            let mut statement = conn.prepare(&sql).map_err(|e| format!("准备文件夹分页查询失败: {e}"))?;
            let rows = statement
                .query_map(params_from_iter(values.iter()), |row| {
                    Ok(FolderSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        parent_id: row.get(3)?,
                        is_monitored: row.get::<_, i64>(4)? != 0,
                        record_version: row.get(5)?,
                        asset_count: row.get::<_, i64>(6)? as u64,
                        has_children: row.get::<_, i64>(7)? != 0,
                    })
                })
                .map_err(|e| format!("执行文件夹分页查询失败: {e}"))?;
            let mut items = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取文件夹分页结果失败: {e}"))?;
            let has_more = items.len() > limit;
            items.truncate(limit);
            let next_cursor = if has_more {
                items
                    .last()
                    .map(|last| {
                        serde_json::to_vec(&FolderCursor {
                            name: last.name.to_lowercase(),
                            id: last.id.clone(),
                        })
                        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                        .map_err(|e| format!("编码文件夹游标失败: {e}"))
                    })
                    .transpose()?
            } else {
                None
            };
            Ok(FolderPage { items, next_cursor, limit })
        })
    }

    pub fn get_asset_details(&self, ids: &[String]) -> Result<Vec<AssetDetail>, String> {
        if ids.len() > MAX_PAGE_SIZE {
            return Err(format!("单次最多读取 {MAX_PAGE_SIZE} 个资产详情"));
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let requested = ids.to_vec();
        self.read(move |conn| {
            let placeholders = vec!["?"; requested.len()].join(",");
            let sql = format!(
                "SELECT a.id, a.path, a.normalized_path, a.name, a.asset_type, a.size, a.mtime_ns,
                        COALESCE(u.rating, 0), COALESCE(u.favorite, 0), u.color,
                        u.custom_name, u.notes, a.record_version
                 FROM assets a LEFT JOIN asset_user_state u ON u.asset_id = a.id
                 WHERE a.deleted_at IS NULL AND a.id IN ({placeholders})",
            );
            let mut statement = conn.prepare(&sql).map_err(|e| format!("准备资产详情查询失败: {e}"))?;
            let rows = statement
                .query_map(params_from_iter(requested.iter()), |row| {
                    Ok(AssetDetail {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        normalized_path: row.get(2)?,
                        name: row.get(3)?,
                        asset_type: row.get(4)?,
                        size: row.get::<_, i64>(5)? as u64,
                        mtime_ns: row.get(6)?,
                        rating: row.get::<_, i64>(7)? as u8,
                        favorite: row.get::<_, i64>(8)? != 0,
                        color: row.get(9)?,
                        custom_name: row.get(10)?,
                        notes: row.get(11)?,
                        tag_ids: Vec::new(),
                        collection_ids: Vec::new(),
                        record_version: row.get(12)?,
                    })
                })
                .map_err(|e| format!("执行资产详情查询失败: {e}"))?;
            let mut details = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取资产详情失败: {e}"))?;
            attach_detail_relations(conn, &mut details)?;
            let by_id = details
                .into_iter()
                .map(|detail| (detail.id.clone(), detail))
                .collect::<std::collections::HashMap<_, _>>();
            Ok(requested.iter().filter_map(|id| by_id.get(id).cloned()).collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trip_keeps_sort_and_values() {
        let cursor = AssetCursor {
            sort: AssetSort::SizeDesc,
            text: None,
            number: Some(42),
            id: "asset-42".to_string(),
        };
        let encoded = encode_cursor(&cursor).unwrap();
        let decoded = decode_cursor(&encoded, AssetSort::SizeDesc).unwrap();
        assert_eq!(decoded.number, Some(42));
        assert_eq!(decoded.id, "asset-42");
    }
}
