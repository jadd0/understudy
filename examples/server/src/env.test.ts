import { describe, expect, test } from "vitest";
import { EnvMissing, readEnv } from "./env";

const MINIMAL = { DATABASE_URL: "postgres://x", UNDERSTUDY_API_KEY: "k", CLAUDE_SECRET_KEY: "c" };

describe("server env", () => {
  test("the three required keys are enough, with loopback and 8787 by default", () => {
    const env = readEnv(MINIMAL);
    expect(env).toMatchObject({ port: 8787, host: "127.0.0.1", typesafeKey: null, webhookUrl: null });
  });

  test("a missing required key is named", () => {
    expect(() => readEnv({ DATABASE_URL: "postgres://x" })).toThrow(EnvMissing);
    try {
      readEnv({ DATABASE_URL: "postgres://x" });
    } catch (e) {
      expect((e as EnvMissing).names).toEqual(["UNDERSTUDY_API_KEY", "CLAUDE_SECRET_KEY"]);
    }
  });

  test("the gateway url is optional and read only when set", () => {
    expect(readEnv(MINIMAL).gatewayUrl).toBeNull();
    expect(readEnv({ ...MINIMAL, GATEWAY_URL: "http://gateway.test" }).gatewayUrl).toBe("http://gateway.test");
    expect(readEnv({ ...MINIMAL, GATEWAY_URL: "  " }).gatewayUrl).toBeNull();
  });

  test("HOST overrides the listen address", () => {
    expect(readEnv({ ...MINIMAL, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
