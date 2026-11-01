#!/bin/bash
# Install this Russian speech-to-text bundle into a DSH profile.
#
#   scripts/install.sh                                   # from this checkout (dev/local)
#   scripts/install.sh --spec github:almaziphone/dsh-speech-to-text-ru
#   scripts/install.sh --spec ./dsh-speech-to-text-ru-0.1.0.tgz
#
# The script does, in order (this order matters for DSH bundle precedence):
#   1. enable the shipped "Voice input" bundle  -> gives the speechToText service + mic UI
#   2. install/select this bundle with the app's own `dsh plugin add`
#      (pnpm pulls the pinned sherpa-onnx-node runtime for the current platform)
#   3. pin the default selection in the profile patch, so the choice does not depend on
#      bundle order and survives toggling Voice input later
#
# Options: --profile <name> (default desktop), --dsh <cli path>, --spec <install spec>.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
DSH_CLI="${DSH_CLI:-}"
SPEC=""
MARKER="# >>> dsh-speech-to-text-ru default selection"
END_MARKER="# <<< dsh-speech-to-text-ru default selection"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --dsh) DSH_CLI="$2"; shift 2 ;;
    --spec) SPEC="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SPEC" ] || SPEC="$REPO"

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
[ -f "$PROFILE_DIR/cordis.patch.yml" ] && cp "$PROFILE_DIR/cordis.patch.yml" "$BACKUP/cordis.patch.yml"
echo "backup: $BACKUP"

# 1. Enable Voice input first so this bundle is appended after it in the bundle order.
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
else:
    print("bundle already enabled:", bundle)
PY

# 2. Install / select this bundle (appends it after the voice-input bundle).
echo "--- dsh plugin add $SPEC"
DSH_HOME="$HOME_DIR" "$DSH_CLI" plugin --profile "$PROFILE" add "$SPEC"

# 3. Pin the default recognizer and language in the user patch layer (always wins).
PATCH="$PROFILE_DIR/cordis.patch.yml"
[ -f "$PATCH" ] || printf '[]\n' > "$PATCH"
python3 - "$PATCH" "$MARKER" "$END_MARKER" <<'PY'
import os, sys
path, marker, end_marker = sys.argv[1:4]
text = open(path).read()
start = text.find(marker)
if start != -1:
    end = text.find(end_marker, start)
    if end != -1:
        text = (text[:start] + text[end + len(end_marker):]).rstrip() + "\n"
block = f"""{marker}
# Keep the Russian recognizer + language as the voice-input default regardless of bundle
# order. Remove this block (or edit the values) to use a different default.
- id: speech-to-text
  config:
    defaultProvider: gigaam-ru
    language: ru
{end_marker}
"""
tmp = path + ".voice-ru.tmp"
with open(tmp, "w") as file:
    file.write(text.rstrip() + "\n\n" + block)
os.replace(tmp, path)
print("patched:", path)
PY

cat <<INFO

Done. Refresh the DSH window (Cmd+R / Ctrl+R), then Settings -> Voice input:
recognizer "GigaAM-v3 · RU (int8)", language ru. The first recording downloads ~330 MB of
pinned model weights into $HOME_DIR/speech-to-text/gigaam-ru (verified by SHA-256).

Rollback: cp "$BACKUP/package.json" "$PROFILE_DIR/package.json" && cp "$BACKUP/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
INFO
