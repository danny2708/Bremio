#!/usr/bin/env bash
# Run a single test file inside the Linux copy, for diagnosing a POSIX-only
# failure without re-syncing and reinstalling each time.
export PATH="/home/user/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin"
cd "${BREMIO_POSIX_DIR:-$HOME/bremio-posix}" || exit 1
corepack pnpm exec vitest run "${1:-apps/daemon/src/protocol.test.ts}" 2>&1 | tail -40
