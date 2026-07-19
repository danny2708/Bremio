/**
 * Wire-protocol version for the daemon's HTTP + SSE surface.
 *
 * This lives in `protocol` because that is the package whose whole purpose is
 * to be the single source of truth for shapes both sides agree on. It was
 * previously declared in the daemon and *duplicated* as a literal in the VS
 * Code extension, which depends on no `@bremio/*` package by design — two
 * constants for one fact, free to drift apart silently.
 *
 * The extension still ships no Bremio dependency: its bundler inlines this
 * value at build time, so there is one declaration and no runtime coupling.
 *
 * Bump `PROTOCOL_VERSION` when the wire format changes in a way an older
 * client cannot handle. Raise `MINIMUM_CLIENT_PROTOCOL` only when older
 * clients must be actively refused rather than merely warned.
 */

export const PROTOCOL_VERSION = 1;

/** The oldest client protocol the daemon will still serve. */
export const MINIMUM_CLIENT_PROTOCOL = 1;

export type ProtocolCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      /** Which side needs updating — the actionable part of the message. */
      outdated: "client" | "daemon";
      reason: string;
    };

/**
 * Decide whether a client and daemon can talk, and say which side is behind.
 *
 * Returning the direction matters: "incompatible" leaves a user with nothing
 * to do, while "your daemon is older than this extension" names the fix.
 */
export function checkProtocolCompatibility(input: {
  clientProtocol: number;
  daemonProtocol: number;
  daemonMinimumClient: number;
}): ProtocolCompatibility {
  if (input.clientProtocol < input.daemonMinimumClient) {
    return {
      compatible: false,
      outdated: "client",
      reason:
        `The daemon requires client protocol ${input.daemonMinimumClient}, ` +
        `but this client speaks ${input.clientProtocol}.`,
    };
  }
  if (input.daemonProtocol < input.clientProtocol) {
    return {
      compatible: false,
      outdated: "daemon",
      reason:
        `This client requires daemon protocol ${input.clientProtocol}, ` +
        `but the running daemon supports ${input.daemonProtocol}.`,
    };
  }
  return { compatible: true };
}
