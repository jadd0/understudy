import { describe, expect, it } from "vitest";
import { localProxy } from "./db";

const LOCAL = { wsProxy: "localhost:4454/v2", useSecureWebSocket: false, pipelineTLS: false, pipelineConnect: false };

describe("localProxy", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("points the driver at the compose proxy for %s", (host) => {
    expect(localProxy(`postgres://postgres:postgres@${host}:5437/understudy`, {})).toEqual(LOCAL);
  });

  it("leaves a hosted Neon URL on the driver's defaults", () => {
    expect(localProxy("postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require", {})).toBeNull();
  });

  it("honours NEON_LOCAL_PROXY_PORT", () => {
    expect(localProxy("postgres://u:p@localhost:5437/d", { NEON_LOCAL_PROXY_PORT: "4999" })?.wsProxy).toBe("localhost:4999/v2");
  });
});
