/**
 * Ordered failover over deciders. Each one sits behind its own breaker; an open breaker is skipped without a
 * call. Only `DeciderUnavailable` is an outage: any other error is a bug and propagates untouched. When every
 * decider is unavailable the last `DeciderUnavailable` is rethrown, so the turn fails exactly as it does with a
 * single decider.
 */
import { DeciderUnavailable, type Decider, type DeciderResult, type DeciderState, type Question } from "@understudy/engine";
import { Breaker, type BreakerOptions } from "./breaker";

export interface NamedDecider {
  readonly name: string;
  readonly decider: Decider;
}

export class FailoverDecider implements Decider {
  private readonly breakers: Breaker[];

  constructor(
    private readonly list: readonly NamedDecider[],
    breakerOptions: BreakerOptions,
    private readonly log: (line: string) => void = console.warn,
  ) {
    this.breakers = list.map(() => new Breaker(breakerOptions));
  }

  async ask(questions: readonly Question[], context: { readonly state: DeciderState }): Promise<DeciderResult> {
    let last: DeciderUnavailable | undefined;
    for (let i = 0; i < this.list.length; i++) {
      const breaker = this.breakers[i];
      if (!breaker.allow()) continue;
      try {
        const result = await this.list[i].decider.ask(questions, context);
        breaker.success();
        return result;
      } catch (e) {
        if (!(e instanceof DeciderUnavailable)) {
          breaker.release();
          throw e;
        }
        breaker.failure();
        last = e;
        const next = this.list[i + 1]?.name ?? "nothing";
        this.log(`provider: ${this.list[i].name} unavailable (${e.reason}), using ${next}`);
      }
    }
    throw last ?? new DeciderUnavailable("breaker_open");
  }
}
