//! ============================================================================
//! 模块：文件监控 (watcher.rs)
//! 职责：使用 notify 监听用户本地已添加到工作区的文件夹变动（新增、重命名、删除），
//! 并实时向 Tauri 前端发送事件通知刷新视图。
//! 依赖开源库：`notify`
//! ============================================================================

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::channel;
use std::thread;

pub struct FolderWatcher {
    _watcher: Option<RecommendedWatcher>,
}

impl FolderWatcher {
    pub fn new() -> Self {
        Self { _watcher: None }
    }

    /// 开始监听指定路径
    pub fn watch_path<F>(&mut self, path_str: &str, on_change: F) -> Result<(), String>
    where
        F: Fn(Event) + Send + 'static,
    {
        let path = Path::new(path_str);
        if !path.exists() {
            return Err(format!("监控路径不存在: {}", path_str));
        }

        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;

        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        self._watcher = Some(watcher);

        // 在独立后台线程中轮询事件
        thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                on_change(event);
            }
        });

        Ok(())
    }
}
