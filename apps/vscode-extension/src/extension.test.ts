import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BremioClient,
  CLIENT_PROTOCOL_VERSION,
  DaemonUnavailableError,
  ProtocolMismatchError,
  readEndpoint,
} from "./client";
import { panelHtml } from "./webview";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A stand-in daemon so protocol handling is testable without a real one. */
async function fakeDaemon(meta: Record<string, unknown>): Promise<number> {
  const server: Server = createServer((req, res) => {
    if (req.headers["x-bremio-token"] !== "tok") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ app: "bremio-daemon" }));
    }
    if (req.url === "/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ready: true }));
    }
    if (req.url === "/meta") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(meta));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

async function endpointFile(port: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ext-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "daemon.json");
  await fs.writeFile(
    file,
    JSON.stringify({ port, token: "tok", pid: process.pid, protocolVersion: 1 }),
    "utf8",
  );
  return file;
}

describe("daemon client", () => {
  it("accepts a daemon speaking the same protocol", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      minimumClientProtocol: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).resolves.toMatchObject({ daemonVersion: "1.0.0" });
  });

  it("names an outdated daemon rather than failing generically", async () => {
    const port = await fakeDaemon({
      daemonVersion: "0.9.0",
      protocolVersion: 0,
      minimumClientProtocol: 0,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).rejects.toBeInstanceOf(ProtocolMismatchError);
    await expect(client.checkProtocol()).rejects.toThrow(/Update the Bremio CLI/);
  });

  it("names an outdated extension rather than failing generically", async () => {
    const port = await fakeDaemon({
      daemonVersion: "9.9.9",
      protocolVersion: 99,
      minimumClientProtocol: 99,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).rejects.toThrow(/Update the extension/);
  });

  it("treats a missing endpoint file as unavailable, not as an error to retry forever", async () => {
    const client = new BremioClient(path.join(os.tmpdir(), "definitely-absent.json"));
    await expect(client.connect()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it("does not trust an endpoint file that no longer answers", async () => {
    const client = new BremioClient(await endpointFile(1));
    await expect(client.connect(400)).rejects.toThrow(/not responding/);
  });

  it("ignores a malformed endpoint file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ext-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "daemon.json");
    await fs.writeFile(file, "{ not json", "utf8");

    expect(await readEndpoint(file)).toBeUndefined();
  });
});

describe("webview", () => {
  const html = panelHtml("test-nonce", "vscode-resource:");

  it("builds no inline event handlers", () => {
    // Handlers were previously built by concatenating ids into onclick
    // attributes, which shipped a quoting bug that produced invalid JS. Data
    // attributes plus one delegated listener make that class of bug
    // structurally impossible, so its absence is worth asserting.
    const markup = html.replace(/\/\/[^\n]*/g, ""); // ignore comments
    expect(markup).not.toMatch(/\sonclick=/);
    expect(markup).toContain('data-action="retry"');
    expect(markup).toContain('data-action="merge"');
  });

  it("parses as valid JavaScript", () => {
    const script = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    // Compiles without executing: catches syntax errors in the generated code.
    expect(() => new Function(script as string)).not.toThrow();
  });

  it("carries the nonce into the policy and the script tag", () => {
    expect(html).toContain("'nonce-test-nonce'");
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it("keeps the brand tokens and confines yellow to actions", () => {
    expect(html).toContain("--bremio-primary: #2563eb");
    expect(html).toContain("--bremio-accent: #f4c542");
    // Navigation and selection are blue; the accent is reserved for the lead
    // badge and the single primary action.
    expect(html).toContain("nav button.active { color: var(--bremio-text); border-bottom-color: var(--bremio-primary); }");
    expect(html).toContain(".badge.lead { background: var(--bremio-accent)");
  });

  it("renders every tab the panel offers", () => {
    for (const tab of ["run", "runs", "capacity", "doctor"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
  });
});
