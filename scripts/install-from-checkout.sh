#!/bin/bash
# Install this checkout into a DSH profile (development / local use).
#
#   scripts/install-from-checkout.sh [--profile desktop] [--dsh /path/to/dsh]
#
# Uses the app's own `dsh plugin add` (pnpm installs the pinned native runtime), then makes
# sure the shipped Voice input bundle is enabled so the provider has a speechToText service.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
DSH_CLI="${DSH_CLI:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --dsh) DSH_CLI="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$DSH_CLI" ]; then
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"; do
    if [ -x "$candidate" ]; then DSH_CLI="$candidate"; break; fi
  done
fi
[ -n "$DSH_CLI" ] || DSH_CLI="$(command -v dsh || true)"
[ -n "$DSH_CLI" ] || { echo "dsh CLI not found; pass --dsh /path/to/dsh" >&2; exit 1; }

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
[ -d "$PROFILE_DIR" ] || { echo "missing DSH profile $PROFILE_DIR (start DSH once, then retry)" >&2; exit 1; }

BACKUP="$PROFILE_DIR/.voice-ru-backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp "$PROFILE_DIR/package.json" "$BACKUP/package.json"
echo "backup: $BACKUP"

DSH_HOME="$HOME_DIR" "$DSH_CLI" plugin --profile "$PROFILE" add "$REPO"

python3 - "$PROFILE_DIR/package.json" <<'PY'
import json, os, sys
path = sys.argv[1]
manifest = json.load(open(path))
profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
bundles = list(profile.get("bundles", []))
bundle = "@deepseek-ai/dsh-experimental-voice-input-bundle"
if bundle not in bundles:
    bundles.append(bundle)
    profile["bundles"] = bundles
    tmp = path + ".voice-ru.tmp"
    with open(tmp, "w") as file:
        file.write(json.dumps(manifest, indent=2) + "\n")
    os.replace(tmp, path)
    print("enabled bundle:", bundle)
PY

echo
echo "Installed. Refresh the DSH window, then Settings -> Voice input ->"
echo "recognizer 'GigaAM-v3 · RU (int8)', language ru. The first use downloads ~330 MB of"
echo "pinned model weights into $HOME_DIR/speech-to-text/gigaam-ru."
