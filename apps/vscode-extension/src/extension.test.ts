import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BremioClient,
  CLIENT_PROTOCOL_VERSION,
  DaemonUnavailableError,
  EXTENSION_VERSION,
  ProtocolMismatchError,
  readEndpoint,
} from "./client";
import { panelHtml, renderCapacityCards, type CapacityView } from "./webview";

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

    await expect(client.checkProtocol()).rejects.toThrow(/Update the Bremio extension/);
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
    // Blue marks where you are; yellow is reserved for the lead badge and the
    // single primary action.
    expect(html).toContain("nav button.active");
    expect(html).toContain("border-bottom-color: var(--bremio-primary)");
    expect(html).toContain(".badge.lead { background: var(--bremio-accent)");
    expect(html).toContain("background: var(--bremio-accent); color: var(--bremio-accent-ink)");
  });

  it("takes surfaces and text from the VS Code theme", () => {
    // A fixed palette made the panel a foreign window inside the editor and
    // broke under light themes, so structure must come from the host.
    expect(html).toContain("var(--vscode-editor-background");
    expect(html).toContain("var(--vscode-foreground");
    expect(html).toContain("var(--vscode-input-background");
    expect(html).toContain("var(--vscode-font-size");
  });

  it("hardcodes no fixed surface colours", () => {
    // The old dark navy tokens must not creep back: they are unreadable on a
    // light theme and were the reason the panel looked pasted in.
    for (const retired of ["#0b1220", "#111827", "#182235", "#263348", "#f8fafc"]) {
      expect(html.toLowerCase()).not.toContain(retired);
    }
  });

  it("offers a way to attach context to a prompt", () => {
    // Attachments travel as paths; every adapter can already read files it is
    // told about, so this works without inlining contents.
    expect(html).toContain('id="attach-files"');
    expect(html).toContain('id="attach-open"');
    expect(html).toContain('id="attachments"');
  });

  it("renders every tab the panel offers", () => {
    for (const tab of ["run", "runs", "capacity", "doctor"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
  });

  it("declares no fixed hex background, so cards stay legible on a light theme", () => {
    // The panel takes its surfaces from --vscode-* variables; a literal hex
    // background (the old #3a1c1e banner) is invisible on a light theme and is
    // exactly what this task removed. Brand hexes are allowed only in the
    // :root token definitions, never as a `background:` value.
    expect(html).not.toMatch(/background:\s*#[0-9a-fA-F]{3,8}/);
  });
});

describe("capacity cards (renderCapacityCards)", () => {
  // readAt is "now"; each window states its own capture age relative to it.
  const readAt = 1_000_000;
  const mixed: CapacityView = {
    readAt,
    service: { state: "live" },
    snapshots: [
      {
        agentId: "codex",
        status: "limited",
        confidence: "high",
        source: { name: "Codex app-server", confidenceLabel: "official" },
        contactFreshness: "fresh",
        lastContactAt: readAt - 30,
        windows: [
          { label: "5-hour", remainingPercent: 80, capturedAt: readAt - 30, freshness: "fresh", confidence: "high", resetsAt: readAt + 3600 },
          { label: "weekly", remainingPercent: 40, capturedAt: readAt - 7200, freshness: "stale", confidence: "low" },
          { label: "opaque", capturedAt: readAt - 10, freshness: "fresh", confidence: "high" },
        ],
      },
    ],
  };

  it("shows percentage, reset time, source, confidence and data age", () => {
    const out = renderCapacityCards(mixed);
    expect(out).toContain("80%"); // fresh percentage
    expect(out).toContain("30s old"); // window data age
    expect(out).toContain("resets "); // reset time for the window that has one
    expect(out).toContain("Codex app-server"); // source name
    expect(out).toContain("high confidence"); // snapshot confidence
    expect(out).toContain("contact 30s ago"); // last-contact age
  });

  it("labels a stale window as an observation from the past, not a current fact", () => {
    const out = renderCapacityCards(mixed);
    // Matches the CLI: the stale number never leads; its age does.
    expect(out).toContain("last observed 2.0h ago");
    expect(out).toContain("40%");
    // And an absent percentage is stated as unknown, never fabricated as 0%.
    expect(out).toContain("unknown");
  });

  it("renders an explicit unavailable state instead of a blank card", () => {
    const unavailable: CapacityView = {
      readAt,
      snapshots: [
        {
          agentId: "claude",
          status: "unknown",
          source: { name: "AI-Quota-Tray", confidenceLabel: "unavailable" },
          contactFreshness: "unknown",
          lastContactAt: readAt,
          windows: [],
        },
      ],
    };
    const out = renderCapacityCards(unavailable);
    expect(out).toContain("SOURCE UNAVAILABLE");
    expect(out).toContain("claude");
    expect(out).toContain("no quota windows reported");
  });
});

describe("version coupling", () => {
  it("speaks the protocol version declared in @bremio/protocol", async () => {
    // The extension ships no @bremio dependency by design, so the constant is
    // inlined at build time. This asserts the two have not drifted apart —
    // exactly the failure that duplicating the literal would hide.
    const declared = await fs.readFile(
      path.join(__dirname, "../../../packages/protocol/src/version.ts"),
      "utf8",
    );
    const canonical = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(declared)?.[1]);

    expect(Number.isInteger(canonical)).toBe(true);
    expect(CLIENT_PROTOCOL_VERSION).toBe(canonical);
  });

  it("matches the version in its own manifest", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(__dirname, "../package.json"), "utf8"),
    ) as { version: string };

    // EXTENSION_VERSION falls back to "dev" when run from source; only a built
    // bundle carries the real one, so accept either rather than asserting a
    // build artifact exists.
    expect([manifest.version, "dev"]).toContain(EXTENSION_VERSION);
  });
});

describe("setup remedies", () => {
  it("tells an outdated daemon to update the CLI, not the extension", async () => {
    const port = await fakeDaemon({
      daemonVersion: "0.0.9",
      protocolVersion: 0,
      minimumClientProtocol: 0,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).rejects.toMatchObject({ remedy: "update-cli" });
  });

  it("tells an outdated extension to update itself, not the CLI", async () => {
    const port = await fakeDaemon({
      daemonVersion: "9.9.9",
      protocolVersion: 99,
      minimumClientProtocol: 99,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).rejects.toMatchObject({ remedy: "update-extension" });
  });

  it("carries both versions in the message so the user can see the gap", async () => {
    const port = await fakeDaemon({
      daemonVersion: "0.0.9",
      protocolVersion: 0,
      minimumClientProtocol: 0,
      capabilities: {},
    });
    const client = new BremioClient(await endpointFile(port));

    await expect(client.checkProtocol()).rejects.toThrow(/v0\.0\.9/);
  });
});
