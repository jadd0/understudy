/**
 * Time the engine measures itself with: elapsed milliseconds and waiting. Anything persisted or compared
 * against stored rows (lease expiry, offer expiry, delivery time) uses the database clock, never this one.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
