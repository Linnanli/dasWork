#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Codex Linux sandbox preparation is only supported on Linux." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install --yes bubblewrap apparmor-profiles apparmor-utils

readonly profile_source=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
readonly profile_target=/etc/apparmor.d/bwrap-userns-restrict
if [[ -f "$profile_source" ]]; then
  sudo install -m 0644 "$profile_source" "$profile_target"
  sudo apparmor_parser -r "$profile_target"
fi

command -v bwrap
bwrap --version
codex sandbox -- /bin/true
