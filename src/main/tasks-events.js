function createTasksEventBus() {
  const subscribers = new Set();

  function subscribe(send) {
    subscribers.add(send);
    return () => subscribers.delete(send);
  }

  function emit(type, payload) {
    const envelope = { type, payload, at: Date.now() };
    for (const send of subscribers) {
      try { send(envelope); } catch { /* ignore broken pipe */ }
    }
  }

  return { subscribe, emit, _size: () => subscribers.size };
}

module.exports = { createTasksEventBus };
