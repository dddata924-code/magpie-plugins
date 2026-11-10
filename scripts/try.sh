#!/bin/sh
# Adds a package to a magpie in a sandbox of its own (.sandbox/<name>), so
# your real magpie, agents and sign-ins are never touched:
#   scripts/try.sh <package> [magpie plugin args…]
#   scripts/try.sh grok                    # add it and list what it signs in to
#   scripts/try.sh grok login grok         # then sign in
#   scripts/try.sh grok provider test grok # one tiny request per API
# MAGPIE is the magpie binary (default: magpie on PATH).
#
# The sandbox is given HOME, and USERPROFILE too: on Windows magpie's
# home comes from USERPROFILE (appdir.homeVar) and HOME is not read, so
# with `env -i` giving only HOME, USERPROFILE is unset — magpie found no
# home at all and stopped before doing anything, with "USERPROFILE is not
# set: magpie needs the home folder to find its own files and the
# agents'". A portable magpie.exe is an exception: it ignores both and
# cannot be sandboxed this way.
set -eu
name=$1; shift
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$root/.sandbox/$name
mkdir -p "$sb"
m=${MAGPIE:-magpie}
run() { env -i PATH="$PATH" HOME="$sb" USERPROFILE="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" "$m" "$@"; }
if [ ! -f "$sb/.added" ]; then
  run plugin add "$root/packages/$name" </dev/null
  touch "$sb/.added"
fi
case "${1:-}" in
  "") run plugin </dev/null ;;
  provider|models) run "$@" </dev/null ;;
  *) run plugin "$@" ;;
esac
