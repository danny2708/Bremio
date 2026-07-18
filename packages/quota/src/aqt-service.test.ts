import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeAqtService,
  readAqtServiceEndpoint,
  refreshAqtIfAvailable,
  requestAqtRefresh,
} from "./aqt-service";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A stand-in for AQT's loopback API, including its token requirement. */
async function startFakeAqt(options: {
  token: string;
  onRefresh?: () => unknown;
  failHealth?: boolean;
}): Promise<{ port: number }> {
  const server: Server = createServer((req, res) => {
    if (req.headers["x-aqt-token"] !== options.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid token." }));
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      if (options.failHealth) {
        res.writeHead(500);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ app: "AI Quota Tray", version: "9.9.9" }));
      return;
    }
    if (req.url === "/refresh" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(options.onRefresh?.() ?? { results: [] }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port };
}

async function writeEndpointFile(contents: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-aqt-"));
  const file = path.join(dir, "local-api.json");
  await fs.writeFile(file, JSON.stringify(contents), "utf8");
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return file;
}

describe("AQT loopback client", () => {
  it("reports not-published when no endpoint file exists", async () => {
    const status = await probeAqtService({ endpointPath: path.join(os.tmpdir(), "definitely-absent.json") });
    expect(status.state).toBe("not-published");
  });

  it("ignores a malformed endpoint file rather than throwing", async () => {
    const file = await writeEndpointFile({ port: "not-a-number" });
    expect(await readAqtServiceEndpoint(file)).toBeUndefined();
    expect((await probeAqtService({ endpointPath: file })).state).toBe("not-published");
  });

  it("reports live when the published endpoint answers", async () => {
    const { port } = await startFakeAqt({ token: "secret" });
    const file = await writeEndpointFile({ port, token: "secret" });

    const status = await probeAqtService({ endpointPath: file });
    expect(status.state).toBe("live");
    expect(status.version).toBe("9.9.9");
  });

  it("treats a published-but-dead endpoint as stale, not live", async () => {
    // Port 1 on loopback is not listening; this is the post-crash case where
    // the endpoint file outlives the process that wrote it.
    const file = await writeEndpointFile({ port: 1, token: "secret" });
    const status = await probeAqtService({ endpointPath: file, timeoutMs: 500 });
    expect(status.state).toBe("stale-endpoint");
  });

  it("rejects a wrong token instead of reporting live", async () => {
    const { port } = await startFakeAqt({ token: "correct" });
    const file = await writeEndpointFile({ port, token: "wrong" });

    const status = await probeAqtService({ endpointPath: file });
    expect(status.state).toBe("stale-endpoint");
    expect(status.error).toContain("401");
  });

  it("returns provider results from a successful refresh", async () => {
    const { port } = await startFakeAqt({
      token: "secret",
      onRefresh: () => ({
        results: [
          { providerId: "codex", refreshed: true, message: "ok" },
          { providerId: "antigravity", refreshed: false, message: "not running" },
        ],
      }),
    });

    const outcome = await requestAqtRefresh({ port, token: "secret" });
    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results?.[0]?.providerId).toBe("codex");
  });

  it("degrades to last-known data instead of failing when AQT is absent", async () => {
    const file = await writeEndpointFile({ port: 1, token: "secret" });
    const { status, refresh } = await refreshAqtIfAvailable({
      endpointPath: file,
      timeoutMs: 500,
    });
    expect(status.state).toBe("stale-endpoint");
    expect(refresh).toBeUndefined();
  });

  it("refreshes end to end when the service is live", async () => {
    let refreshCalls = 0;
    const { port } = await startFakeAqt({
      token: "secret",
      onRefresh: () => {
        refreshCalls += 1;
        return { results: [{ providerId: "codex", refreshed: true, message: "ok" }] };
      },
    });
    const file = await writeEndpointFile({ port, token: "secret" });

    const { status, refresh } = await refreshAqtIfAvailable({ endpointPath: file });
    expect(status.state).toBe("live");
    expect(refresh?.ok).toBe(true);
    expect(refreshCalls).toBe(1);
  });
});
