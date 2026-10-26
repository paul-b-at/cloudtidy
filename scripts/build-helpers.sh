#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS 26+ and Xcode 26+.' >&2; exit 1; }
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 26 )) || { echo 'Requires macOS 26+.' >&2; exit 1; }
mkdir -p bin
xcrun swiftc -O -parse-as-library -target "$(uname -m)-apple-macos26.0" helpers/classify.swift -o bin/classify
xcrun swiftc -O helpers/ocr.swift -o bin/ocr
echo 'Built bin/classify and bin/ocr. Run bun run doctor next.'
