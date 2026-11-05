/** Parse CLI flags into createClient options. */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = Number(argv[i + 1]);
    if (flag === "--timeout-ms") options.timeoutMs = value;
    else if (flag === "--retries") options.retries = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return options;
}
