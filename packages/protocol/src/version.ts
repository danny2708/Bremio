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

/**
 * 2 as of v1.0.0. Every wire change since protocol 1 was additive — the
 * `/sessions` and `/sessions/:id` routes, and optional fields on run detail and
 * the report. An old client against a new daemon is therefore fine: it ignores
 * fields it does not know and never calls the new routes.
 *
 * The bump exists for the *other* direction, which is the one that actually
 * breaks. A v1.0 extension asks a 0.1 daemon for `/sessions` and gets a 404 —
 * a confusing failure in a surface that looks merely empty. At protocol 2 the
 * handshake answers "the running daemon is older than this extension" and names
 * the fix instead, which is the entire reason this mechanism exists.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The oldest client protocol the daemon will still serve.
 *
 * Deliberately still 1: a 0.1 extension talking to a v1.0 daemon works, it
 * simply does not use sessions. Raising this would refuse those clients
 * outright, and nothing about the additive changes requires that.
 */
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
