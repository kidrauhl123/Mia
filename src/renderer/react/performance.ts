declare global {
  interface Window {
    __miaPerformance?: {
      enabled?: boolean;
      measure?<T>(name: string, operation: () => T): T;
      record?(name: string, value: number): void;
      snapshot?(): unknown;
    };
  }
}

function now(): number {
  const value = Number(window.performance?.now?.());
  return Number.isFinite(value) ? value : Date.now();
}

export function measureReactCommit<T>(name: string, operation: () => T): T {
  const startedAt = now();
  try {
    return operation();
  } finally {
    window.__miaPerformance?.record?.(name, Math.max(0, now() - startedAt));
  }
}
