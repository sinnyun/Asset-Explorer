use crate::database::{Database, V2_DATABASE_FILE};
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
