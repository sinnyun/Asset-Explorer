//! Bounded thumbnail request admission and worker permits.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

struct Inner {
    workers: Arc<Semaphore>,
    queued: AtomicUsize,
    capacity: usize,
}

#[derive(Clone)]
pub struct ThumbnailCoordinator {
    inner: Arc<Inner>,
}

pub struct ThumbnailReservation {
    inner: Arc<Inner>,
}

impl ThumbnailCoordinator {
    pub fn new(worker_count: usize, queue_capacity: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                workers: Arc::new(Semaphore::new(worker_count.max(1))),
                queued: AtomicUsize::new(0),
                capacity: queue_capacity.max(1),
            }),
        }
    }

    pub fn reserve(&self) -> Result<ThumbnailReservation, String> {
        self.inner.queued.fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
            (queued < self.inner.capacity).then_some(queued + 1)
        }).map_err(|_| "thumbnail queue is full".to_string())?;
        Ok(ThumbnailReservation { inner: self.inner.clone() })
    }

    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.inner.queued.load(Ordering::Acquire)
    }
}

impl ThumbnailReservation {
    pub async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        self.inner.workers.clone().acquire_owned().await
            .map_err(|_| "thumbnail workers are closed".to_string())
    }
}

impl Drop for ThumbnailReservation {
    fn drop(&mut self) {
        self.inner.queued.fetch_sub(1, Ordering::AcqRel);
    }
}
