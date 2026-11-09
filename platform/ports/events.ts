/** Realtime fan-out. The engine emits; a transport adapter (none yet) delivers. */
export interface Events {
  emit(channel: string, event: string, payload: Record<string, unknown>): Promise<void>;
}
