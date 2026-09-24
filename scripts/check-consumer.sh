#!/usr/bin/env bash
# Install the packed package into a consumer whose own tree resolves a different @bufbuild/protobuf and @grpc/grpc-js
# than ours, and typecheck code that hands the consumer's objects to ours. That is what a product does once it maps its
# protos' platform imports onto our subpaths: its generated encode passes its BinaryWriter into our User.encode. With a
# second copy of either package nested under ours, the private fields on those classes make every such call a type
# error, so this fails the moment either one stops being a peer. Run `pnpm run build` first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f dist/index.mjs ] || { echo "::error::no dist/index.mjs — run 'pnpm run build' first"; exit 1; }

# Deliberately not the versions in our devDependencies: the consumer's must be the only copies, and a match would hide
# a nested one.
CONSUMER_PROTOBUF=2.11.0
CONSUMER_GRPC_JS=1.14.5
TYPESCRIPT="$(node -p "require('./package.json').devDependencies.typescript")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pnpm pack --pack-destination "$WORK" >/dev/null
TARBALL="$(ls "$WORK"/*.tgz)"

mkdir "$WORK/consumer"
cd "$WORK/consumer"

cat >package.json <<EOF
{
  "name": "consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@bufbuild/protobuf": "$CONSUMER_PROTOBUF",
    "@grpc/grpc-js": "$CONSUMER_GRPC_JS",
    "@primandproper/platform-client": "file:$TARBALL",
    "typescript": "$TYPESCRIPT"
  }
}
EOF

cat >tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["*.ts"]
}
EOF

# The shape ts-proto emits for a product message with a platform message field, once
# primandproper/platform/identity/v1/identity.proto is mapped onto our identity/v1 subpath.
cat >profile.ts <<'EOF'
import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire';
import { User } from '@primandproper/platform-client/identity/v1';

export interface Profile {
  user: User | undefined;
}

export const Profile = {
  encode(message: Profile, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.user !== undefined) {
      User.encode(message.user, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Profile {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message: Profile = { user: undefined };
    while (reader.pos < end) {
      const tag = reader.uint32();
      if (tag >>> 3 === 1) {
        message.user = User.decode(reader, reader.uint32());
      } else {
        reader.skip(tag & 7);
      }
    }
    return message;
  },
};
EOF

# The consumer builds the channel credentials; our transport opens the channel with them.
cat >transport.ts <<'EOF'
import { credentials } from '@grpc/grpc-js';
import { createGrpcJsTransport } from '@primandproper/platform-client';

export const transport = createGrpcJsTransport({ address: 'localhost:0', credentials: credentials.createInsecure() });
EOF

npm install --no-audit --no-fund --loglevel=error >/dev/null

nested="$(find node_modules/@primandproper/platform-client -path '*/node_modules/*' -name package.json -maxdepth 4 2>/dev/null || true)"
if [ -n "$nested" ]; then
  echo "::error::the package brought its own copies of dependencies the consumer already has:"
  echo "$nested"
fi

if ! npx --no-install tsc -p .; then
  echo "::error::a consumer on @bufbuild/protobuf $CONSUMER_PROTOBUF and @grpc/grpc-js $CONSUMER_GRPC_JS cannot pass its objects to ours"
  exit 1
fi
[ -z "$nested" ] || exit 1

echo "consumer on @bufbuild/protobuf $CONSUMER_PROTOBUF and @grpc/grpc-js $CONSUMER_GRPC_JS shares our runtime"
