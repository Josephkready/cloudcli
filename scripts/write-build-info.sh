#!/usr/bin/env bash
#
# Writes the #458 build identity (git SHA + build time) to a JSON file.
#
# This is a separate script rather than an inline heredoc in dante-build.sh so the JSON
# encoding can be unit-tested directly (src/test/danteBuildInfoWriter.test.ts). The two
# values are parsed by the server and served over /health; a raw shell heredoc would emit
# malformed JSON — or allow JSON injection — if a value ever contained a double-quote,
# backslash or newline. Python's `json.dump` escapes whatever it is given, so the output
# is always valid JSON regardless of the inputs.
#
# Usage: write-build-info.sh <sha> <built_at> <output-file>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  printf 'usage: %s <sha> <built_at> <output-file>\n' "$0" >&2
  exit 2
fi

python3 -c 'import json,sys; json.dump({"sha": sys.argv[1], "built_at": sys.argv[2]}, sys.stdout)' "$1" "$2" > "$3"
