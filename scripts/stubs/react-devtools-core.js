// Ink statically imports react-devtools-core but only calls it when its
// devtools mode is enabled, which Bremio never turns on. Bundling the real
// package would add megabytes of dev tooling to the shipped CLI, so this
// no-op stub is aliased in at build time.
export function connectToDevTools() {}
export default { connectToDevTools };
