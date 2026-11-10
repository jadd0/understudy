/**
 * Ordered failover over generators, the same shape as `FailoverDecider`: a breaker per generator, an open one is
 * skipped, `GeneratorError` is the outage (`not_configured`, `http_402` and `http_429` skip the entry without counting a failure), anything else propagates, and all-failed rethrows the last error.
 */
import { GeneratorError, type GenerateInput, type GenerateResult, type Generator } from "@understudy/engine";
import { Breaker, PER_CREATOR_CODES, type BreakerOptions } from "./breaker";

export interface NamedGenerator {
  readonly name: string;
  readonly generator: Generator;
}

export class FailoverGenerator implements Generator {
  private readonly breakers: Breaker[];

  constructor(
    private readonly list: readonly NamedGenerator[],
    breakerOptions: BreakerOptions,
    private readonly log: (line: string) => void = console.warn,
  ) {
    this.breakers = list.map(() => new Breaker(breakerOptions));
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let last: GeneratorError | undefined;
    for (let i = 0; i < this.list.length; i++) {
      const breaker = this.breakers[i];
      if (!breaker.allow()) continue;
      try {
        const result = await this.list[i].generator.generate(input);
        breaker.success();
        return result;
      } catch (e) {
        if (!(e instanceof GeneratorError)) {
          breaker.release();
          throw e;
        }
        // No key, a spent budget (402) or a rate limit (429) belong to one creator, not to the provider: skip the
        // entry without counting a failure, so one creator cannot open the breaker every creator shares.
        if (PER_CREATOR_CODES.has(e.code)) breaker.release();
        else breaker.failure();
        last = e;
        const next = this.list[i + 1]?.name ?? "nothing";
        this.log(`provider: ${this.list[i].name} unavailable (${e.code}), using ${next}`);
      }
    }
    throw last ?? new GeneratorError("breaker_open");
  }
}

/** The same generator with the model pinned, for a fallback that is a second model on the same vendor. */
export function withModel(generator: Generator, model: string): Generator {
  return { generate: (input) => generator.generate({ ...input, model }) };
}
