#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS 26+ and Xcode 26+.' >&2; exit 1; }
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 26 )) || { echo 'Requires macOS 26+.' >&2; exit 1; }
# Apple Intelligence needs Apple silicon. `uname -m` reports x86_64 in a Rosetta shell, so ask the hardware instead.
[[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == 1 ]] || { echo 'Requires an Apple silicon Mac.' >&2; exit 1; }
sdk=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)
(( ${sdk%%.*} >= 26 )) || { echo "Requires the macOS 26+ SDK (found $sdk). Install Xcode 26+ and run xcode-select -s." >&2; exit 1; }
mkdir -p bin
target=arm64-apple-macos26.0
# Build to temporary names so a failed build never leaves a stale or half-updated binary behind.
xcrun --sdk macosx swiftc -O -parse-as-library -target "$target" helpers/classify.swift -o bin/classify.tmp
xcrun --sdk macosx swiftc -O -target "$target" helpers/ocr.swift -o bin/ocr.tmp
# The linker already ad-hoc signs arm64 output; signing again with a fixed identifier is idempotent and explicit.
codesign --force --sign - --identifier local.cloudtidy.classify bin/classify.tmp
codesign --force --sign - --identifier local.cloudtidy.ocr bin/ocr.tmp
mv -f bin/classify.tmp bin/classify
mv -f bin/ocr.tmp bin/ocr
echo 'Built bin/classify and bin/ocr. Run bun run doctor next.'
