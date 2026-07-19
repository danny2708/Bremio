#!/usr/bin/env bash
# POSIX verification for Bremio.
#
# Windows is the machine this project is developed on, so the POSIX paths —
# process groups, 0600 permissions, atomic discovery writes — had only ever
# been reasoned about, never run. This copies the source into the Linux
# filesystem (the Windows node_modules holds Windows binaries and cannot be
# reused), installs there, and runs the tests that actually differ by platform.
#
# Usage, from a WSL/Linux shell:  bash scripts/posix-verify.sh
set -uo pipefail

SOURCE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET="${BREMIO_POSIX_DIR:-$HOME/bremio-posix}"
NODE_BIN="${BREMIO_NODE_BIN:-}"

if [ -n "$NODE_BIN" ]; then export PATH="$NODE_BIN:$PATH"; fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail=0
check() { if [ "$1" -eq 0 ]; then printf '  \033[32mPASS\033[0m  %s\n' "$2"; else printf '  \033[31mFAIL\033[0m  %s\n' "$2"; fail=1; fi; }

say "environment"
echo "  $(uname -srm)"
echo "  node $(node --version 2>/dev/null || echo MISSING)"
command -v node >/dev/null || { echo "node is required"; exit 1; }

say "syncing source into the Linux filesystem"
mkdir -p "$TARGET"
# node_modules and dist are excluded deliberately: they hold Windows binaries.
tar -C "$SOURCE" \
  --exclude=node_modules --exclude=.git --exclude=dist --exclude='*.tgz' \
  --exclude=.bremio --exclude=target --exclude='*.vsix' \
  -cf - . 2>/dev/null | tar -C "$TARGET" -xf -
echo "  synced to $TARGET"

say "installing dependencies for Linux"
cd "$TARGET" || exit 1
corepack enable >/dev/null 2>&1
if ! corepack pnpm install --silent >/tmp/bremio-posix-install.log 2>&1; then
  echo "  install failed; tail of log:"; tail -5 /tmp/bremio-posix-install.log; exit 1
fi
echo "  installed"

# The platform-dependent surfaces, and only those: process groups and signals,
# the lock and discovery file (including permission bits), SQLite, and SSE.
say "process supervisor — process groups, kill(-pgid), tree termination"
corepack pnpm exec vitest run packages/adapter-sdk/src/process-supervisor.test.ts 2>&1 | tail -5
check $? "supervisor"

say "daemon lifecycle — single-instance lock, discovery, reconciliation"
corepack pnpm exec vitest run apps/daemon/src/lifecycle.test.ts 2>&1 | tail -5
check $? "lifecycle"

say "storage — SQLite under a POSIX filesystem"
corepack pnpm exec vitest run apps/daemon/src/storage.test.ts 2>&1 | tail -4
check $? "storage"

say "protocol — SSE stream, resume and terminal close"
corepack pnpm exec vitest run apps/daemon/src/protocol.test.ts 2>&1 | tail -4
check $? "protocol"

say "cancellation states"
corepack pnpm exec vitest run apps/daemon/src/cancellation.test.ts 2>&1 | tail -4
check $? "cancellation"

# Permission bits are a POSIX-only guarantee, so assert them where they exist
# rather than trusting the Windows run where the mode is ignored.
say "discovery file permissions (POSIX-only guarantee)"
# tsx, not plain node: the daemon sources are TypeScript.
cat > /tmp/bremio-perm-check.mts <<'CHECK'
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishEndpoint } from "./apps/daemon/src/endpoint";
const dir = await mkdtemp(join(tmpdir(), "bremio-perm-"));
const file = join(dir, "daemon.json");
await publishEndpoint(
  { port: 1234, token: "secret", pid: process.pid, startedAt: new Date().toISOString(),
    daemonVersion: "test", protocolVersion: 1 },
  file,
);
const mode = (await stat(file)).mode & 0o777;
console.log("  mode:", mode.toString(8));
process.exit(mode === 0o600 ? 0 : 1);
CHECK
cp /tmp/bremio-perm-check.mts "$TARGET/perm-check.mts"
corepack pnpm exec tsx ./perm-check.mts 2>&1 | tail -3
check $? "0600 on the token file"
rm -f "$TARGET/perm-check.mts"

say "result"
if [ "$fail" -eq 0 ]; then
  printf '  \033[32mall POSIX checks passed\033[0m\n'
else
  printf '  \033[31msome POSIX checks failed\033[0m\n'
fi
exit "$fail"
