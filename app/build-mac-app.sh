#!/bin/zsh
# Builds ~/Applications/Dojo.app: a copy of the Electron runtime with Dojo's name and icon,
# whose Resources/app is a symlink to this folder. Code changes need no rebuild (just restart Dojo),
# rerun this only after an Electron update or an icon change.
# Keep the executable named "Electron": Electron finds its helper apps by that name.
set -e
APP_DIR="${0:A:h}"
A="$HOME/Applications/Dojo.app"
SRC="$APP_DIR/node_modules/electron/dist/Electron.app"
[ -d "$SRC/Contents/Frameworks" ] || { echo "Electron runtime incomplete, see Gotchas in CLAUDE.md"; exit 1; }

rm -rf "$A"
ditto "$SRC" "$A"
cp "$APP_DIR/assets/logo.icns" "$A/Contents/Resources/dojo.icns"
ln -s "$APP_DIR" "$A/Contents/Resources/app"
P="$A/Contents/Info.plist"
plutil -replace CFBundleName -string Dojo "$P"
plutil -replace CFBundleDisplayName -string Dojo "$P"
plutil -replace CFBundleIdentifier -string com.techwithbali.dojo "$P"
plutil -replace CFBundleIconFile -string dojo.icns "$P"
codesign --force --deep -s - "$A"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$A"
echo "Built $A"
