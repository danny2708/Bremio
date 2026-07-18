/**
 * Renders the TUI to an in-memory terminal and asserts the first frame draws.
 *
 * The TUI needs a real TTY to run interactively, so this is the only automated
 * guard that the Ink tree mounts without crashing (bad hook usage, JSX/runtime
 * errors, missing exports). Run with: corepack pnpm tui:smoke
 */
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { App } from "./app";
import { theme } from "./theme";

function fakeStdout(): PassThrough & { columns: number; rows: number } {
  const stream = new PassThrough();
  // isTTY matters: Ink only renders incrementally to a TTY-like stream,
  // otherwise it defers the single frame until unmount.
  Object.assign(stream, { columns: 100, rows: 40, isTTY: true });
  return stream as PassThrough & { columns: number; rows: number };
}

function fakeStdin(): PassThrough {
  const stream = new PassThrough();
  // Ink refuses to install input handlers unless raw mode looks supported.
  Object.assign(stream, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  return stream;
}

async function main(): Promise<void> {
  const stdout = fakeStdout();
  let frames = "";
  stdout.on("data", (chunk: Buffer) => {
    frames += chunk.toString();
  });

  const instance = render(
    createElement(App, { version: "smoke", repoPath: process.cwd() }),
    {
      stdout: stdout as never,
      stdin: fakeStdin() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  void instance;

  const plain = frames.replace(/\[[0-9;]*[A-Za-z]/g, "");
  const expectations: Array<[string, boolean]> = [
    ["renders the wordmark", plain.includes("██")],
    ["renders the menu", plain.includes("Doctor") && plain.includes("Capacity")],
    ["renders the run entry", plain.includes("Run")],
    // Colour cannot be observed here: chalk strips styling when the target is
    // not a TTY, so assert the brand token itself instead.
    ["brand red is the primary accent", theme.primary === "#d43002"],
  ];

  const failures = expectations.filter(([, ok]) => !ok).map(([label]) => label);
  console.log(plain.split("\n").filter((line) => line.trim()).slice(0, 14).join("\n"));
  for (const [label, ok] of expectations) console.log(`${ok ? "✓" : "✗"} ${label}`);

  if (failures.length > 0) {
    throw new Error(`TUI smoke failed: ${failures.join(", ")}`);
  }
  console.log("\nTUI smoke passed.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`TUI smoke failed: ${(err as Error).message}`);
  process.exit(1);
});
