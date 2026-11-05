import { defaults } from "./config.mjs";

export function createClient(options = {}) {
  const settings = { ...defaults, ...options };
  return {
    settings,
    describe() {
      return `timeout=${settings.timeout}s retries=${settings.retries}`;
    },
  };
}
