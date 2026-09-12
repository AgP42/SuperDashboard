#!/usr/bin/env bash
# Fast JS-only dev loop for SuperDashboard.
#
# Rebuilds ONLY the React Native bundle, pushes it, and hot-reloads it in the
# running pluginhost via the firmware's debug broadcast — no .snplg, no manual
# reinstall. Seconds instead of a full build + Settings dance.
#
# LIMITS:
#  - JS only. Native/Java changes (android/…) still need ./buildPlugin.sh + install.
#  - Uses com.ratta.supernote.plugin.action.DEBUG, a debug door open on the current
#    Chauvet beta. It is being closed on public builds (we reported it), so this is
#    a development convenience only, never something the plugin itself relies on.
#
# Usage:  ./dev-reload.sh
set -euo pipefail

PLUGIN_ID="dsh4b0ardplg9x2k"          # PluginConfig.json → pluginID
DEV_BUNDLE="/storage/emulated/0/MyStyle/dev.bundle"
OUT="build/generated/SuperDashboard.bundle"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

echo "→ typecheck"
npx tsc --noEmit

echo "→ bundling JS"
npx react-native bundle \
  --entry-file index.js \
  --bundle-output "$OUT" \
  --platform android \
  --assets-dest build/generated/assets \
  --dev false

echo "→ push"
adb push "$OUT" "$DEV_BUNDLE" >/dev/null

echo "→ hot-reload broadcast"
adb shell am broadcast \
  -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
  -a com.ratta.supernote.plugin.action.DEBUG \
  --es bundle_path "$DEV_BUNDLE" \
  --es plugin_id "$PLUGIN_ID"

echo "✓ reloaded — reopen the dashboard (or re-tap the bubble) to pick it up"
