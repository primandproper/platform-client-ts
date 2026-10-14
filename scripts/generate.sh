#!/usr/bin/env bash
# Generate the TypeScript client from the fetched .proto files.
#
# outputServices=generic-definitions rather than grpc-js, whose method definitions call Buffer
# at runtime and so cannot run in a browser or React Native. methodsOf in src/transport.ts turns
# a definition into the methods a Transport carries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/generated"
INCLUDE="$ROOT/.protos/include"

[ -d "$INCLUDE" ] || { echo "::error::no .protos/include — run scripts/fetch-protos.sh first"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

PROTOS=()
while IFS= read -r proto; do PROTOS+=("$proto"); done < <(find "$INCLUDE" -name '*.proto' | sort)

PATH="$ROOT/node_modules/.bin:$PATH" protoc \
  --ts_proto_out="$OUT" \
  --ts_proto_opt=outputServices=generic-definitions \
  --ts_proto_opt=esModuleInterop=true \
  --proto_path "$INCLUDE" \
  "${PROTOS[@]}"

cp "$ROOT/.protos/SOURCES.txt" "$OUT/SOURCES.txt"
echo "generated $(find "$OUT" -name '*.ts' | wc -l | tr -d ' ') files -> src/generated"
