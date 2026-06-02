export interface CloudClientDeps {
  apiBase: string;
  fetchImpl?: (url: string, opts: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  getToken: () => string;
  idFactory?: () => string;
  WebSocketImpl?: unknown;
  scheduleReconnect?: (fn: () => void, ms: number) => void;
}

export interface ConnectEventsOptions {
  sinceSeq: () => number;
  onEvent: (envelope: any) => void;
  onStatus?: (status: string) => void;
}

export interface CloudClient {
  api(path: string, options?: Record<string, any>): Promise<any>;
  apiBase: string;
  connectEvents(opts: ConnectEventsOptions): void;
  disconnectEvents(): void;
  stopEvents(): void;
}

export interface EventsClient {
  connect(opts: ConnectEventsOptions): void;
  disconnect(): void;
  stop(): void;
}

export function createCloudClient(deps: CloudClientDeps): CloudClient;
export function createEventsClient(deps: CloudClientDeps): EventsClient;
export function eventsUrlFor(apiBase: string, sinceSeq: number): string;
export function backoffMs(attempt: number): number;
