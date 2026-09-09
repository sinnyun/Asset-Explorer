use crate::database::{Database, V2_DATABASE_FILE};
use crate::models::{AssetUserPatch, FileFact};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "asset-explorer-v2-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn v2_database_uses_distinct_file_and_starts_empty() {
    let dir = TestDir::new("empty");
    let v2_path = dir.join(V2_DATABASE_FILE);
    let db = Database::init_v2_at(&v2_path).expect("initialize V2 database");

    assert_eq!(db.asset_count().expect("count assets"), 0);
    assert!(v2_path.exists());
    assert!(!dir.join("assethub.db").exists());
}

fn test_db(label: &str) -> (TestDir, Database) {
    let dir = TestDir::new(label);
    let db = Database::init_v2_at(&dir.join(V2_DATABASE_FILE)).expect("initialize test database");
    (dir, db)
}

fn fact(id: &str, normalized_path: &str, size: u64, mtime_ns: i64) -> FileFact {
    FileFact {
        id: id.to_string(),
        folder_id: None,
        path: normalized_path.to_string(),
        normalized_path: normalized_path.to_string(),
        name: normalized_path.rsplit('\\').next().unwrap_or(id).to_string(),
        extension: "png".to_string(),
        asset_type: "image".to_string(),
        mime: Some("image/png".to_string()),
        size,
        mtime_ns,
        volume_id: None,
        file_id: None,
        width: None,
        height: None,
        metadata_status: "pending".to_string(),
        generation: 1,
    }
}

#[test]
fn rescanning_file_facts_preserves_user_state() {
    let (_dir, db) = test_db("preserve-user-state");
    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\a.png", 100, 10)])
        .expect("insert file fact");
    db.patch_user_state(&AssetUserPatch::rating("asset-a", 5))
        .expect("set rating");

    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\a.png", 200, 20)])
        .expect("refresh file fact");

    let detail = db
        .get_asset_detail("asset-a")
        .expect("read detail")
        .expect("asset exists");
    assert_eq!(detail.rating, 5);
    assert_eq!(detail.size, 200);
    assert_eq!(detail.mtime_ns, 20);
}

#[test]
fn normalized_path_is_unique() {
    let (_dir, db) = test_db("unique-path");
    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\same.png", 100, 10)])
        .expect("insert first path");

    let error = db
        .upsert_file_facts(&[fact("asset-b", r"d:\assets\same.png", 100, 10)])
        .expect_err("duplicate normalized path must be rejected");

    assert!(error.contains("normalized_path"), "unexpected error: {error}");
}

#[test]
fn user_state_is_stored_outside_assets_table() {
    let (_dir, db) = test_db("separate-user-state");
    assert!(!db.table_columns("assets").unwrap().contains(&"rating".to_string()));
    assert!(db
        .table_columns("asset_user_state")
        .unwrap()
        .contains(&"rating".to_string()));
}
