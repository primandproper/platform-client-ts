#!/usr/bin/env bash
# Fetch the .proto files this client is generated from, at a pinned platform-go tag.
#
# Two repositories are involved and only one of them is pinned here: platform-go's
# tag is in PLATFORM_GO_VERSION, and the primitives-go version is *read out of that
# tag's go.mod*. Pinning it separately would let the two skew, and generating
# filtering.proto from a different version than the server was built against is a
# wire mismatch that no test in this repo would catch. googleapis' google/rpc protos are
# the one input not fetched: they are vendored under third_party/ with their commit.
#
# Nothing here needs a Go toolchain. This is a TypeScript repository and it stays one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.protos"
PLATFORM_VERSION="$(tr -d '[:space:]' < "$ROOT/PLATFORM_GO_VERSION")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "platform-go $PLATFORM_VERSION"
curl -sSfL "https://github.com/primandproper/platform-go/archive/refs/tags/${PLATFORM_VERSION}.tar.gz" \
  | tar xz -C "$work"
platform_dir="$(find "$work" -maxdepth 1 -type d -name 'platform-go-*' | head -1)"
[ -n "$platform_dir" ] || { echo "::error::platform-go ${PLATFORM_VERSION} did not unpack"; exit 1; }

# The primitives version is whatever platform-go was built against, not a choice.
primitives_version="$(grep -E 'github\.com/primandproper/primitives-go/v[0-9]+ v' "$platform_dir/go.mod" \
  | head -1 | awk '{print $2}')"
[ -n "$primitives_version" ] || { echo "::error::no primitives-go requirement in platform-go's go.mod"; exit 1; }
echo "primitives-go $primitives_version (read from platform-go's go.mod)"

curl -sSfL "https://github.com/primandproper/primitives-go/archive/refs/tags/${primitives_version}.tar.gz" \
  | tar xz -C "$work"
primitives_dir="$(find "$work" -maxdepth 1 -type d -name 'primitives-go-*' | head -1)"
[ -n "$primitives_dir" ] || { echo "::error::primitives-go ${primitives_version} did not unpack"; exit 1; }

# Every .proto lands under one include root, so protoc gets a single --proto_path and
# the import paths inside the files resolve exactly as they do on the server.
rm -rf "$OUT"
mkdir -p "$OUT/include"
count=0
while IFS= read -r p; do
  rel="${p#*/proto/}"
  mkdir -p "$OUT/include/$(dirname "$rel")"
  cp "$p" "$OUT/include/$rel"
  count=$((count + 1))
done < <(find "$platform_dir" "$primitives_dir" -path '*/proto/primandproper/*' -name '*.proto' | sort)

# google/rpc is googleapis, not protoc's bundled well-knowns, so it is vendored at a pinned
# commit rather than fetched: the error detail a client branches on rides in these messages.
VENDORED="$ROOT/third_party/googleapis"
googleapis_commit="$(tr -d '[:space:]' < "$VENDORED/COMMIT")"
while IFS= read -r p; do
  rel="${p#"$VENDORED"/}"
  mkdir -p "$OUT/include/$(dirname "$rel")"
  cp "$p" "$OUT/include/$rel"
  count=$((count + 1))
done < <(find "$VENDORED/google" -name '*.proto' | sort)

cat > "$OUT/SOURCES.txt" <<EOF
platform-go     $PLATFORM_VERSION
primitives-go   $primitives_version
googleapis      $googleapis_commit
files           $count
EOF
echo "$count .proto files -> .protos/include"
