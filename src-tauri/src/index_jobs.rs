//! Bounded coordinator for filesystem indexing jobs.

use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
#[cfg(test)]
use std::time::{Duration, Instant};

const MAX_JOB_HISTORY: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JobSnapshot {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "rootId")]
    pub root_id: String,
    pub status: JobStatus,
    pub error: Option<String>,
}

impl JobSnapshot {
    pub fn is_terminal(&self) -> bool {
        matches!(self.status, JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled)
    }
}

struct JobRecord {
    cancelled: Arc<AtomicBool>,
    snapshot: Mutex<JobSnapshot>,
    changed: Condvar,
}

struct CoordinatorState {
    active_by_root: HashMap<String, String>,
    jobs: HashMap<String, Arc<JobRecord>>,
    history: VecDeque<String>,
}

type JobWork = Box<dyn FnOnce(Arc<AtomicBool>) -> Result<(), String> + Send + 'static>;

struct JobRequest {
    job_id: String,
    root_id: String,
    record: Arc<JobRecord>,
    work: JobWork,
}

#[derive(Clone)]
pub struct IndexCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
    sender: mpsc::SyncSender<JobRequest>,
    next_id: Arc<AtomicU64>,
}

impl IndexCoordinator {
    pub fn new(worker_count: usize, queue_capacity: usize) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<JobRequest>(queue_capacity.max(1));
        let receiver = Arc::new(Mutex::new(receiver));
        let state = Arc::new(Mutex::new(CoordinatorState {
            active_by_root: HashMap::new(),
            jobs: HashMap::new(),
            history: VecDeque::new(),
        }));

        for worker_index in 0..worker_count.max(1) {
            let receiver = receiver.clone();
            let state = state.clone();
            std::thread::Builder::new()
                .name(format!("asset-index-{worker_index}"))
                .spawn(move || loop {
                    let request = match receiver.lock().recv() {
                        Ok(request) => request,
                        Err(_) => break,
                    };
                    update_record(&request.record, JobStatus::Running, None);
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        (request.work)(request.record.cancelled.clone())
                    }));
                    let (status, error) = if request.record.cancelled.load(Ordering::Acquire) {
                        (JobStatus::Cancelled, None)
                    } else {
                        match result {
                            Ok(Ok(())) => (JobStatus::Completed, None),
                            Ok(Err(error)) => (JobStatus::Failed, Some(error)),
                            Err(_) => (JobStatus::Failed, Some("index worker panicked".to_string())),
                        }
                    };
                    update_record(&request.record, status, error);
                    let mut guard = state.lock();
                    if guard.active_by_root.get(&request.root_id) == Some(&request.job_id) {
                        guard.active_by_root.remove(&request.root_id);
                    }
                })
                .expect("start bounded index worker");
        }

        Self { state, sender, next_id: Arc::new(AtomicU64::new(1)) }
    }

    pub fn start<F>(&self, root_id: impl Into<String>, work: F) -> Result<String, String>
    where
        F: FnOnce(Arc<AtomicBool>) -> Result<(), String> + Send + 'static,
    {
        let root_id = root_id.into();
        let mut state = self.state.lock();
        if let Some(job_id) = state.active_by_root.get(&root_id) {
            return Ok(job_id.clone());
        }

        let job_id = format!("index-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let record = Arc::new(JobRecord {
            cancelled: Arc::new(AtomicBool::new(false)),
            snapshot: Mutex::new(JobSnapshot {
                job_id: job_id.clone(),
                root_id: root_id.clone(),
                status: JobStatus::Queued,
                error: None,
            }),
            changed: Condvar::new(),
        });
        state.active_by_root.insert(root_id.clone(), job_id.clone());
        state.jobs.insert(job_id.clone(), record.clone());
        state.history.push_back(job_id.clone());
        while state.history.len() > MAX_JOB_HISTORY {
            if let Some(oldest) = state.history.pop_front() {
                if state.jobs.get(&oldest).is_some_and(|job| job.snapshot.lock().is_terminal()) {
                    state.jobs.remove(&oldest);
                }
            }
        }
        drop(state);

        let request = JobRequest { job_id: job_id.clone(), root_id: root_id.clone(), record, work: Box::new(work) };
        if let Err(error) = self.sender.try_send(request) {
            let mut state = self.state.lock();
            state.active_by_root.remove(&root_id);
            state.jobs.remove(&job_id);
            return Err(format!("index queue is full: {error}"));
        }
        Ok(job_id)
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let record = self.state.lock().jobs.get(job_id).cloned();
        if let Some(record) = record {
            record.cancelled.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }

    pub fn status(&self, job_id: &str) -> Option<JobSnapshot> {
        let record = self.state.lock().jobs.get(job_id).cloned()?;
        let snapshot = record.snapshot.lock().clone();
        Some(snapshot)
    }

    #[cfg(test)]
    pub fn wait(&self, job_id: &str, timeout: Duration) -> Option<JobSnapshot> {
        let record = self.state.lock().jobs.get(job_id).cloned()?;
        let deadline = Instant::now() + timeout;
        let mut snapshot = record.snapshot.lock();
        while !snapshot.is_terminal() {
            let now = Instant::now();
            if now >= deadline || record.changed.wait_for(&mut snapshot, deadline - now).timed_out() {
                break;
            }
        }
        Some(snapshot.clone())
    }

    #[cfg(test)]
    pub fn active_job_count(&self) -> usize {
        self.state.lock().active_by_root.len()
    }
}

fn update_record(record: &JobRecord, status: JobStatus, error: Option<String>) {
    let mut snapshot = record.snapshot.lock();
    snapshot.status = status;
    snapshot.error = error;
    record.changed.notify_all();
}
