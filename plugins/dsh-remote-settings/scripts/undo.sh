#!/usr/bin/env sh
# dsh-remote-settings installer undo (POSIX).
#
# Restores every patched copy to its original. Run to revert the fix (e.g.
# before uninstalling the plugin): `sh scripts/undo.sh`.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$DIR/lib/install.js" undo
