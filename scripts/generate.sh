#!/usr/bin/env bash
# Generate the TypeScript client from the fetched .proto files.
#
# Flags match what dinnerdonebetter already generates with, because the output has to
# drop into that app in place of the copies it maintains by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/generated"
INCLUDE="$ROOT/.protos/include"

[ -d "$INCLUDE" ] || { echo "::error::no .protos/include — run scripts/fetch-protos.sh first"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

PATH="$ROOT/node_modules/.bin:$PATH" protoc \
  --ts_proto_out="$OUT" \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=esModuleInterop=true \
  --proto_path "$INCLUDE" \
  $(find "$INCLUDE" -name '*.proto' | sort)

cp "$ROOT/.protos/SOURCES.txt" "$OUT/SOURCES.txt"
echo "generated $(find "$OUT" -name '*.ts' | wc -l | tr -d ' ') files -> src/generated"
