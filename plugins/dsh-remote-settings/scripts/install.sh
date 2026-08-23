#!/usr/bin/env sh
# dsh-remote-settings installer (POSIX).
#
# Auto-detects every copy of the bundle (dsh home, desktop app-data
# harness-versions snapshots, source trees, node_modules) and patches them all.
# Run once after `dsh plugin --profile web add …`.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$DIR/lib/install.js" patch
