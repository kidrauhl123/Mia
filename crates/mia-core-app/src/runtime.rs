//! Runtime process registry for app-level cancellation.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mia_core_runtime::RuntimeCancellation;

#[derive(Debug, Clone, Default)]
pub struct RuntimeRegistry {
    cancellations: Arc<Mutex<HashMap<String, RuntimeCancellation>>>,
    active_conversation_turns: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveConversationTurn {
    pub conversation_id: String,
    pub turn_id: String,
}

#[derive(Debug)]
pub struct ConversationRuntimeClaim {
    conversation_id: String,
    turn_id: String,
    active_conversation_turns: Arc<Mutex<HashMap<String, String>>>,
    released: bool,
}

impl RuntimeRegistry {
    pub fn try_claim_conversation(
        &self,
        conversation_id: impl Into<String>,
    ) -> Result<ConversationRuntimeClaim, ActiveConversationTurn> {
        let conversation_id = conversation_id.into();
        let mut active = self
            .active_conversation_turns
            .lock()
            .expect("runtime registry active conversation mutex poisoned");
        if let Some(turn_id) = active.get(&conversation_id) {
            return Err(ActiveConversationTurn {
                conversation_id,
                turn_id: turn_id.clone(),
            });
        }
        active.insert(conversation_id.clone(), String::new());
        Ok(ConversationRuntimeClaim {
            conversation_id,
            turn_id: String::new(),
            active_conversation_turns: self.active_conversation_turns.clone(),
            released: false,
        })
    }

    pub fn register(&self, turn_id: impl Into<String>) -> RuntimeCancellation {
        let cancellation = RuntimeCancellation::new();
        self.cancellations
            .lock()
            .expect("runtime registry mutex poisoned")
            .insert(turn_id.into(), cancellation.clone());
        cancellation
    }

    pub fn cancel(&self, turn_id: &str) -> bool {
        let cancellation = self
            .cancellations
            .lock()
            .expect("runtime registry mutex poisoned")
            .get(turn_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            true
        } else {
            false
        }
    }

    pub fn remove(&self, turn_id: &str) {
        self.cancellations
            .lock()
            .expect("runtime registry mutex poisoned")
            .remove(turn_id);
    }
}

impl ConversationRuntimeClaim {
    pub fn set_turn_id(&mut self, turn_id: impl Into<String>) {
        if self.released {
            return;
        }
        let next = turn_id.into();
        let mut active = self
            .active_conversation_turns
            .lock()
            .expect("runtime registry active conversation mutex poisoned");
        if active.get(&self.conversation_id) == Some(&self.turn_id) {
            active.insert(self.conversation_id.clone(), next.clone());
            self.turn_id = next;
        }
    }

    pub fn release(&mut self) -> bool {
        if self.released {
            return false;
        }
        self.released = true;
        let mut active = self
            .active_conversation_turns
            .lock()
            .expect("runtime registry active conversation mutex poisoned");
        if active.get(&self.conversation_id) == Some(&self.turn_id) {
            active.remove(&self.conversation_id);
            true
        } else {
            false
        }
    }
}

impl Drop for ConversationRuntimeClaim {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_claim_blocks_until_released() {
        let registry = RuntimeRegistry::default();
        let mut claim = registry.try_claim_conversation("conv_1").unwrap();
        claim.set_turn_id("turn_1");
        let active = registry.try_claim_conversation("conv_1").unwrap_err();
        assert_eq!(active.turn_id, "turn_1");

        assert!(claim.release());
        assert!(registry.try_claim_conversation("conv_1").is_ok());
    }
}
