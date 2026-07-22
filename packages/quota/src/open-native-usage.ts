import { exec } from "node:child_process";

const USAGE_URLS: Record<string, string> = {
  codex: "https://platform.openai.com/usage",
  claude: "https://claude.ai/settings/usage",
};

export function openNativeUsageFor(
  agentId: string,
): (() => Promise<void>) | undefined {
  const url = USAGE_URLS[agentId];
  if (!url) return undefined;
  return () => openUrl(url);
}

function openUrl(url: string): Promise<void> {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  return new Promise((resolve, reject) => {
    exec(cmd, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
