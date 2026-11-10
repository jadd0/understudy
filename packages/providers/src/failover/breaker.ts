/**
 * Per-provider circuit breaker. Closed until `failures` failures land within `windowMs`; then open for
 * `cooldownMs`; then half-open, where exactly one call is let through: its success closes the breaker, its
 * failure opens it again for another cooldown. The clock is injected so tests never wait.
 */
export interface BreakerOptions {
  readonly failures: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly clock: { now(): number };
}

/** Failure codes that describe one creator's situation (no key, budget spent, rate limited), not the provider's health. */
export const PER_CREATOR_CODES: ReadonlySet<string> = new Set(["not_configured", "http_402", "http_429"]);

type State = "closed" | "open" | "half_open";

export class Breaker {
  private state: State = "closed";
  private failureTimes: number[] = [];
  private openedAt = 0;
  private probing = false;

  constructor(private readonly options: BreakerOptions) {}

  /** True when a call may go to the provider now. In half-open it is true once, until that call reports back. */
  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.options.clock.now() - this.openedAt < this.options.cooldownMs) return false;
      this.state = "half_open";
      this.probing = false;
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.state = "closed";
    this.failureTimes = [];
    this.probing = false;
  }

  /** Frees the half-open probe slot when the call ended in something that says nothing about the provider. */
  release(): void {
    this.probing = false;
  }

  failure(): void {
    const now = this.options.clock.now();
    if (this.state === "half_open") {
      this.trip(now);
      return;
    }
    this.failureTimes = this.failureTimes.filter((t) => now - t < this.options.windowMs);
    this.failureTimes.push(now);
    if (this.failureTimes.length >= this.options.failures) this.trip(now);
  }

  get isOpen(): boolean {
    return this.state !== "closed";
  }

  private trip(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.failureTimes = [];
    this.probing = false;
  }
}
