import { neonConfig } from "@neondatabase/serverless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPool, localProxy } from "./db";

const LOCAL = { wsProxy: "localhost:4454/v2", useSecureWebSocket: false, pipelineTLS: false, pipelineConnect: false };

describe("localProxy", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("points the driver at the compose proxy on the URL's own host %s", (host) => {
    expect(localProxy(`postgres://postgres:postgres@${host}:5437/understudy`, {})).toEqual({ ...LOCAL, wsProxy: `${host}:4454/v2` });
  });

  it("leaves a hosted Neon URL on the driver's defaults", () => {
    expect(localProxy("postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require", {})).toBeNull();
  });

  it("honours NEON_LOCAL_PROXY_PORT", () => {
    expect(localProxy("postgres://u:p@localhost:5437/d", { NEON_LOCAL_PROXY_PORT: "4999" })?.wsProxy).toBe("localhost:4999/v2");
  });

  it.each(["", "  "])("treats an empty NEON_LOCAL_PROXY_PORT (%j) as unset", (port) => {
    expect(localProxy("postgres://u:p@localhost:5437/d", { NEON_LOCAL_PROXY_PORT: port })?.wsProxy).toBe("localhost:4454/v2");
  });
});

describe("createPool", () => {
  // The test setup points the global driver config at the local proxy; start from the driver's real defaults.
  let saved: typeof neonConfig.opts;
  beforeEach(() => {
    saved = neonConfig.opts;
    neonConfig.opts = {};
  });
  afterEach(() => {
    neonConfig.opts = saved;
  });

  const settings = (client: { neonConfig: { wsProxy: unknown; useSecureWebSocket: boolean; pipelineTLS: boolean; pipelineConnect: unknown } }) => ({
    wsProxy: typeof client.neonConfig.wsProxy === "function" ? "default" : client.neonConfig.wsProxy,
    useSecureWebSocket: client.neonConfig.useSecureWebSocket,
    pipelineTLS: client.neonConfig.pipelineTLS,
    pipelineConnect: client.neonConfig.pipelineConnect,
  });

  it("puts the local proxy on a local pool's connections and leaves the global config at its defaults", async () => {
    const local = createPool("postgres://postgres:postgres@127.0.0.1:5437/understudy", {});
    const hosted = createPool("postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require", {});
    const url = "postgres://u:p@127.0.0.1:5437/d";
    expect(settings(new local.Client({ connectionString: url }) as never)).toEqual({ ...LOCAL, wsProxy: "127.0.0.1:4454/v2" });
    // a hosted pool created after a local one, in the same process, keeps the driver's defaults
    const h = settings(new hosted.Client({ connectionString: "postgres://u:p@h.neon.tech/d" }) as never);
    expect(h.useSecureWebSocket).toBe(neonConfig.defaults.useSecureWebSocket);
    expect(h.pipelineTLS).toBe(neonConfig.defaults.pipelineTLS);
    expect(h.pipelineConnect).toBe(neonConfig.defaults.pipelineConnect);
    expect(h.wsProxy).not.toBe(LOCAL.wsProxy);
    expect(neonConfig.opts).toEqual({});
    expect(neonConfig.wsProxy).not.toBe(LOCAL.wsProxy);
    expect(neonConfig.useSecureWebSocket).toBe(true);
    await Promise.all([local.end(), hosted.end()]);
  });
});
