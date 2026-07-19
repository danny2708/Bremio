import { describe, expect, it } from "vitest";
import {
  MINIMUM_CLIENT_PROTOCOL,
  PROTOCOL_VERSION,
  checkProtocolCompatibility,
} from "./version";

describe("protocol compatibility", () => {
  it("accepts a client and daemon on the same version", () => {
    expect(
      checkProtocolCompatibility({
        clientProtocol: PROTOCOL_VERSION,
        daemonProtocol: PROTOCOL_VERSION,
        daemonMinimumClient: MINIMUM_CLIENT_PROTOCOL,
      }),
    ).toEqual({ compatible: true });
  });

  it("names the client as outdated when the daemon requires newer", () => {
    const result = checkProtocolCompatibility({
      clientProtocol: 1,
      daemonProtocol: 2,
      daemonMinimumClient: 2,
    });

    // Which side is behind is the actionable part; "incompatible" alone leaves
    // the user with nothing to do.
    expect(result).toMatchObject({ compatible: false, outdated: "client" });
  });

  it("names the daemon as outdated when it is behind the client", () => {
    const result = checkProtocolCompatibility({
      clientProtocol: 2,
      daemonProtocol: 1,
      daemonMinimumClient: 1,
    });

    expect(result).toMatchObject({ compatible: false, outdated: "daemon" });
  });

  it("prefers the client remedy when both are out of step", () => {
    // A client too old for the daemon's floor cannot be fixed by updating the
    // daemon, so that instruction must win.
    const result = checkProtocolCompatibility({
      clientProtocol: 1,
      daemonProtocol: 3,
      daemonMinimumClient: 2,
    });

    expect(result).toMatchObject({ compatible: false, outdated: "client" });
  });

  it("keeps the minimum at or below the current version", () => {
    // Requiring a client newer than the protocol the daemon itself speaks
    // would lock out every client, including a correct one.
    expect(MINIMUM_CLIENT_PROTOCOL).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });
});
