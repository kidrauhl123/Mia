export interface AssistantContentBlock {
  type: "text" | "thinking" | "recap" | "tool" | "file_edit" | string;
  id?: string;
  text?: string;
  name?: string;
  preview?: string;
  path?: string;
  title?: string;
  diff?: string;
  action?: string;
  status?: string;
  duration?: number | null;
  additions?: number;
  deletions?: number;
  error?: boolean;
}

export interface AssistantContentBlockCollector {
  collect(kindOrEvent: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  payload(finalText?: string): AssistantContentBlock[];
}

export function normalizeContentBlocks(input: unknown): AssistantContentBlock[];
export function contentBlocksWithFinalText(input: unknown, finalText?: string): AssistantContentBlock[];
export function displayTextFromContentBlocks(input: unknown): string;
export function createAssistantContentBlockCollector(): AssistantContentBlockCollector;
