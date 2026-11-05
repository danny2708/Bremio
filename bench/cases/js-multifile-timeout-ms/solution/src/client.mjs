import { defaults } from "./config.mjs";

export function createClient(options = {}) {
  if ("timeout" in options) {
    throw new Error("the `timeout` option was renamed to `timeoutMs` (milliseconds)");
  }
  const settings = { ...defaults, ...options };
  return {
    settings,
    describe() {
      return `timeoutMs=${settings.timeoutMs} retries=${settings.retries}`;
    },
  };
}
