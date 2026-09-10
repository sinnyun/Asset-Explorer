//! Pure bounded filesystem-event coalescing state machine.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
    Replace,
}

#[derive(Debug, Clone)]
pub struct RawFsEvent {
    pub root_id: String,
    pub normalized_path: String,
    pub kind: ChangeKind,
    pub is_directory: bool,
    observed_at: Instant,
}

impl RawFsEvent {
    pub fn file(root_id: &str, path: &str, kind: ChangeKind, observed_at: Instant) -> Self {
        Self::new(root_id, path, kind, false, observed_at)
    }

    pub fn directory(root_id: &str, path: &str, kind: ChangeKind, observed_at: Instant) -> Self {
        Self::new(root_id, path, kind, true, observed_at)
    }

    fn new(root_id: &str, path: &str, kind: ChangeKind, is_directory: bool, observed_at: Instant) -> Self {
        Self {
            root_id: root_id.to_string(),
            normalized_path: crate::database::normalize_windows_path(path),
            kind,
            is_directory,
            observed_at,
        }
    }
}

pub type TargetedFsChange = RawFsEvent;

pub struct EventCoalescer {
    capacity: usize,
    quiet_period: Duration,
    pending: HashMap<(String, String), RawFsEvent>,
    dirty_roots: HashSet<String>,
}

impl EventCoalescer {
    pub fn new(capacity: usize, quiet_period: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            quiet_period,
            pending: HashMap::new(),
            dirty_roots: HashSet::new(),
        }
    }

    pub fn push(&mut self, event: RawFsEvent) -> bool {
        let key = (event.root_id.clone(), event.normalized_path.clone());

        if !self.pending.contains_key(&key) && self.pending.len() >= self.capacity {
            self.dirty_roots.insert(event.root_id);
            return false;
        }

        if !event.is_directory && self.pending.values().any(|pending| {
            pending.root_id == event.root_id
                && pending.is_directory
                && is_descendant(&event.normalized_path, &pending.normalized_path)
        }) {
            return true;
        }

        if event.is_directory {
            self.pending.retain(|_, pending| {
                pending.root_id != event.root_id
                    || !is_descendant(&pending.normalized_path, &event.normalized_path)
            });
        }

        if let Some(previous) = self.pending.get_mut(&key) {
            match merge(previous.kind, event.kind) {
                Some(kind) => {
                    previous.kind = kind;
                    previous.is_directory |= event.is_directory;
                    previous.observed_at = event.observed_at;
                }
                None => {
                    self.pending.remove(&key);
                }
            }
        } else {
            self.pending.insert(key, event);
        }
        true
    }

    pub fn drain_ready(&mut self, now: Instant) -> Vec<TargetedFsChange> {
        let mut ready_keys = self.pending.iter()
            .filter(|(_, event)| now.saturating_duration_since(event.observed_at) >= self.quiet_period)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        ready_keys.sort();
        ready_keys.into_iter().filter_map(|key| self.pending.remove(&key)).collect()
    }

    #[cfg(test)]
    pub fn is_root_dirty(&self, root_id: &str) -> bool {
        self.dirty_roots.contains(root_id)
    }
}

fn merge(previous: ChangeKind, next: ChangeKind) -> Option<ChangeKind> {
    use ChangeKind::*;
    match (previous, next) {
        (Create, Modify | Create) => Some(Create),
        (Create, Remove) => None,
        (Remove, Create) => Some(Replace),
        (Remove, Modify | Remove) => Some(Remove),
        (Modify, Remove) => Some(Remove),
        (Modify, Create) => Some(Replace),
        (Modify, Modify) => Some(Modify),
        (_, Replace) => Some(Replace),
        (Replace, Remove) => Some(Remove),
        (Replace, _) => Some(Replace),
    }
}

fn is_descendant(path: &str, directory: &str) -> bool {
    path != directory && path.starts_with(&format!("{}\\", directory.trim_end_matches('\\')))
}
