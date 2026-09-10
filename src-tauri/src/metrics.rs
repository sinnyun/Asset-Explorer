//! Low-overhead aggregated diagnostics. Never stores file paths or per-file events.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Default)]
pub struct PipelineMetrics {
    query_count: AtomicU64,
    query_micros: AtomicU64,
    error_count: AtomicU64,
    watcher_dropped_events: AtomicU64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiagnosticsSnapshot {
    #[serde(rename = "queryCount")]
    pub query_count: u64,
    #[serde(rename = "averageQueryMicros")]
    pub average_query_micros: u64,
    #[serde(rename = "errorCount")]
    pub error_count: u64,
    #[serde(rename = "watcherDroppedEvents")]
    pub watcher_dropped_events: u64,
    #[serde(rename = "activeIndexJobs")]
    pub active_index_jobs: usize,
    #[serde(rename = "databaseWrites")]
    pub database_writes: usize,
    #[serde(rename = "thumbnailRequests")]
    pub thumbnail_requests: usize,
    #[serde(rename = "assetCount")]
    pub asset_count: usize,
}

impl PipelineMetrics {
    pub fn record_query(&self, duration: Duration, success: bool) {
        self.query_count.fetch_add(1, Ordering::Relaxed);
        self.query_micros.fetch_add(duration.as_micros().min(u64::MAX as u128) as u64, Ordering::Relaxed);
        if !success {
            self.error_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record_watcher_drop(&self) {
        self.watcher_dropped_events.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self, active_index_jobs: usize, database_writes: usize, thumbnail_requests: usize, asset_count: usize) -> DiagnosticsSnapshot {
        let query_count = self.query_count.load(Ordering::Relaxed);
        let query_micros = self.query_micros.load(Ordering::Relaxed);
        DiagnosticsSnapshot {
            query_count,
            average_query_micros: if query_count == 0 { 0 } else { query_micros / query_count },
            error_count: self.error_count.load(Ordering::Relaxed),
            watcher_dropped_events: self.watcher_dropped_events.load(Ordering::Relaxed),
            active_index_jobs,
            database_writes,
            thumbnail_requests,
            asset_count,
        }
    }

    #[cfg(test)]
    pub fn reset_counters(&self) {
        self.query_count.store(0, Ordering::Relaxed);
        self.query_micros.store(0, Ordering::Relaxed);
        self.error_count.store(0, Ordering::Relaxed);
        self.watcher_dropped_events.store(0, Ordering::Relaxed);
    }
}

pub fn global() -> &'static PipelineMetrics {
    static METRICS: OnceLock<PipelineMetrics> = OnceLock::new();
    METRICS.get_or_init(PipelineMetrics::default)
}
