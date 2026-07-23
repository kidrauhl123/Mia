use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Result, bail};
use dashmap::DashMap;
use tokio::sync::Mutex;

// Native ACP and Hermes each own one cache. Keeping both at 16 leaves ample
// headroom under macOS' common 256-FD soft limit while still preserving warm
// sessions for recently used conversations.
pub(crate) const DEFAULT_RUNTIME_TASK_CACHE_CAPACITY: usize = 16;

pub(crate) struct BoundedTaskCache<T> {
    tasks: DashMap<String, Arc<Mutex<T>>>,
    last_used: DashMap<String, u64>,
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

    fn touch(&self, key: &str) {
        let tick = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        self.last_used.insert(key.to_string(), tick);
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
}
