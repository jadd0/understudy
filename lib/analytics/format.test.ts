import { expect, test } from "vitest";
import { DASH, count, ms, pct, seconds, usd, usdMicros } from "./format";

test("formats_render_dash_for_null_and_never_nan", () => {
  for (const f of [usd, usdMicros, pct, ms, seconds, count]) {
    expect(f(null)).toBe(DASH);
    expect(f(NaN)).toBe(DASH);
    expect(f(Infinity)).toBe(DASH);
  }
});

test("formats_known_values", () => {
  expect(usd(123456)).toBe("$1,234.56");
  expect(usd(5)).toBe("$0.05");
  expect(usd(-250)).toBe("-$2.50");
  expect(usdMicros(1275)).toBe("$0.0013");
  expect(usdMicros(2_500_000)).toBe("$2.50");
  expect(pct(0.5)).toBe("50.0%");
  expect(ms(450)).toBe("450 ms");
  expect(ms(3700)).toBe("3.70 s");
  expect(seconds(60)).toBe("60 s");
  expect(seconds(600)).toBe("10.0 min");
  expect(seconds(7200)).toBe("2.0 h");
});
