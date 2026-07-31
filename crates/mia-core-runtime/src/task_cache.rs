use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dashmap::DashMap;
use tokio::sync::Mutex;

// Native ACP and Hermes each own one cache, and every warm entry can retain an
// agent process plus its MCP children. Four recent sessions per backend keeps
// normal conversation switching warm without allowing a desktop app to retain
// dozens of process trees.
pub(crate) const DEFAULT_RUNTIME_TASK_CACHE_CAPACITY: usize = 4;

pub(crate) struct BoundedTaskCache<T> {
    tasks: DashMap<String, Arc<Mutex<T>>>,
    last_used: DashMap<String, u64>,
    last_used_at: DashMap<String, Instant>,
    owner_keys: DashMap<String, String>,
    mutation: Mutex<()>,
    clock: AtomicU64,
    capacity: usize,
}

impl<T> Default for BoundedTaskCache<T> {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_RUNTIME_TASK_CACHE_CAPACITY)
    }
}

impl<T> BoundedTaskCache<T> {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            tasks: DashMap::new(),
            last_used: DashMap::new(),
            last_used_at: DashMap::new(),
            owner_keys: DashMap::new(),
            mutation: Mutex::new(()),
            clock: AtomicU64::new(0),
            capacity: capacity.max(1),
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.tasks.len()
    }

    pub(crate) fn get(&self, key: &str) -> Option<Arc<Mutex<T>>> {
        let task = self.tasks.get(key).map(|entry| entry.value().clone());
        if task.is_some() {
            self.touch(key);
        }
        task
    }

    pub(crate) fn remove(&self, key: &str) {
        self.tasks.remove(key);
        self.last_used.remove(key);
        self.last_used_at.remove(key);
        self.owner_keys.remove(key);
    }

    pub(crate) fn set_owner(&self, key: &str, owner_key: &str) {
        self.owner_keys
            .insert(key.to_string(), owner_key.to_string());
    }

    pub(crate) async fn get_or_try_insert_with<F, Fut>(
        &self,
        key: &str,
        logical_prefix: &str,
        factory: F,
    ) -> Result<Arc<Mutex<T>>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        if let Some(task) = self.get(key) {
            return Ok(task);
        }

        let _mutation = self.mutation.lock().await;
        if let Some(task) = self.get(key) {
            return Ok(task);
        }

        let stale_keys = self
            .tasks
            .iter()
            .filter(|entry| {
                entry.key().starts_with(logical_prefix)
                    && Arc::strong_count(entry.value()) == 1
                    && entry.value().try_lock().is_ok()
            })
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for stale_key in stale_keys {
            self.remove(&stale_key);
        }

        self.evict_idle_for_incoming()?;
        let task = Arc::new(Mutex::new(factory().await?));
        self.tasks.insert(key.to_string(), task.clone());
        self.touch(key);
        Ok(task)
    }

    pub(crate) fn touch(&self, key: &str) {
        let tick = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        self.last_used.insert(key.to_string(), tick);
        self.last_used_at.insert(key.to_string(), Instant::now());
    }

    pub(crate) async fn remove_idle_older_than(
        &self,
        max_idle: Duration,
        protected_owners: &HashSet<String>,
    ) -> Vec<String> {
        let _mutation = self.mutation.lock().await;
        let now = Instant::now();
        let stale_keys = self
            .tasks
            .iter()
            .filter_map(|entry| {
                let key = entry.key();
                let is_protected = self
                    .owner_keys
                    .get(key)
                    .is_some_and(|owner| protected_owners.contains(owner.value()));
                let expired = self
                    .last_used_at
                    .get(key)
                    .is_some_and(|last_used| now.duration_since(*last_used) >= max_idle);
                (!is_protected
                    && expired
                    && Arc::strong_count(entry.value()) == 1
                    && entry.value().try_lock().is_ok())
                .then(|| key.clone())
            })
            .collect::<Vec<_>>();
        for key in &stale_keys {
            self.remove(key);
        }
        stale_keys
    }

    fn evict_idle_for_incoming(&self) -> Result<()> {
        let required = self
            .tasks
            .len()
            .saturating_add(1)
            .saturating_sub(self.capacity);
        if required == 0 {
            return Ok(());
        }

        let mut candidates = self
            .tasks
            .iter()
            .filter_map(|entry| {
                let idle =
                    Arc::strong_count(entry.value()) == 1 && entry.value().try_lock().is_ok();
                idle.then(|| {
                    (
                        self.last_used
                            .get(entry.key())
                            .map(|value| *value)
                            .unwrap_or(0),
                        entry.key().clone(),
                    )
                })
            })
            .collect::<Vec<_>>();
        candidates.sort_unstable();
        for (_, key) in candidates.into_iter().take(required) {
            self.remove(&key);
        }

        if self.tasks.len() >= self.capacity {
            bail!(
                "runtime session capacity reached ({} active sessions)",
                self.capacity
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cache_evicts_the_least_recently_used_idle_entry() {
        let cache = BoundedTaskCache::with_capacity(2);
        cache
            .get_or_try_insert_with("a:1", "a:", || async { Ok(1) })
            .await
            .unwrap();
        cache
            .get_or_try_insert_with("b:1", "b:", || async { Ok(2) })
            .await
            .unwrap();
        assert!(cache.get("a:1").is_some());

        cache
            .get_or_try_insert_with("c:1", "c:", || async { Ok(3) })
            .await
            .unwrap();

        assert!(cache.get("a:1").is_some());
        assert!(cache.get("b:1").is_none());
        assert!(cache.get("c:1").is_some());
        assert_eq!(cache.len(), 2);
    }

    #[tokio::test]
    async fn cache_rejects_new_entries_when_every_cached_task_is_busy() {
        let cache = BoundedTaskCache::with_capacity(1);
        let task = cache
            .get_or_try_insert_with("a:1", "a:", || async { Ok(1) })
            .await
            .unwrap();
        let _busy = task.lock().await;

        let error = cache
            .get_or_try_insert_with("b:1", "b:", || async { Ok(2) })
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("runtime session capacity reached")
        );
        assert_eq!(cache.len(), 1);
    }

    #[tokio::test]
    async fn cache_does_not_evict_a_checked_out_task_before_it_is_locked() {
        let cache = BoundedTaskCache::with_capacity(1);
        let checked_out = cache
            .get_or_try_insert_with("a:1", "a:", || async { Ok(1) })
            .await
            .unwrap();

        let error = cache
            .get_or_try_insert_with("b:1", "b:", || async { Ok(2) })
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("runtime session capacity reached")
        );
        assert_eq!(*checked_out.lock().await, 1);
        assert_eq!(cache.len(), 1);
    }

    #[tokio::test]
    async fn idle_cleanup_respects_active_owner_leases() {
        let cache = BoundedTaskCache::with_capacity(2);
        cache
            .get_or_try_insert_with("a:1", "a:", || async { Ok(1) })
            .await
            .unwrap();
        cache
            .get_or_try_insert_with("b:1", "b:", || async { Ok(2) })
            .await
            .unwrap();
        cache.set_owner("a:1", "conversation-a");
        cache.set_owner("b:1", "conversation-b");

        let protected = HashSet::from(["conversation-a".to_string()]);
        let removed = cache
            .remove_idle_older_than(Duration::ZERO, &protected)
            .await;

        assert_eq!(removed, vec!["b:1"]);
        assert!(cache.get("a:1").is_some());
        assert!(cache.get("b:1").is_none());
    }
}
