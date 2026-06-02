export interface ApprovalItem {
  conversationId: string;
  runId: string;
  preview: string;
}

export interface ApprovalQueue {
  onRequest(req: Partial<ApprovalItem>): void;
  onResponded(runId: string): void;
  resolve(runId: string): void;
  active(): ApprovalItem | null;
  size(): number;
}

export function createApprovalQueue(): ApprovalQueue;
