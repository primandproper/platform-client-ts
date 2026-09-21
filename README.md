# platform-client-ts

The TypeScript client for services built on [`platform-go`](https://github.com/primandproper/platform-go): generated
stubs for platform's own protos, and (not yet) the runtime that makes calling them safe.

It is the third tier. `primitives-*` is how to do a thing, `platform-go` is what a product has, and this is **how to
talk to a service built on platform-go**. A product's own protos generate in the product's repository; only platform's
generate here.

## Why it exists

DDB's iOS app and web frontend each maintain their own copy of this. Worse, most of each copy is frozen: its Makefile
carries eight TypeScript domains and nine Swift ones through every regeneration as preserved directories, because — in
its own words — _"it was generated from this repository's own protos before each domain moved, so it describes services
the server no longer runs."_

They are preserved rather than regenerated because regenerating one means porting every call site in two apps. This
repository is what lets those domains land one at a time, against the real schema, once instead of twice.

## What is here now

**Generated stubs only.** `src/generated/` holds 15 files (12 protos plus the google well-knowns) built from a pinned
`platform-go` tag. The output is **committed**, so a consumer needs neither `protoc` nor this repository's toolchain.

The generated `identity` client here is byte-identical to the one DDB generates today, which is the point: this is a
drop-in, not a rewrite.

## What is not here yet

The runtime, and it is the part that matters — auth refresh, deadlines, pagination, idempotency keys, stream reconnect,
error mapping, and the headless flows over them. It is specified in
[`platform-go`'s client contract](https://github.com/primandproper/platform-go/blob/main/docs/client-contract.md), and
one of that document's open questions ([platform-go#869](https://github.com/primandproper/platform-go/issues/869)) has
to be answered before the refresh path can be written correctly.

## Codegen

```bash
pnpm install
pnpm run codegen        # fetch the protos, then generate
pnpm exec tsc --noEmit  # typecheck
```

**One pin, one derived version.** `PLATFORM_GO_VERSION` names a `platform-go` tag. The `primitives-go` version is _read
out of that tag's `go.mod`_ rather than pinned separately — `filtering.proto` lives there, and generating it from a
different version than the server was built against is a wire mismatch nothing in this repository would catch.

`scripts/fetch-protos.sh` downloads both tarballs from GitHub and lays every `.proto` under one include root. **No Go
toolchain**: this is a TypeScript repository and it stays one, which is why it fetches a tag rather than resolving the
module cache the way DDB's Makefile does.

Flags match DDB's (`outputServices=grpc-js`, `esModuleInterop=true`, then prettier), because output that does not match
is output that cannot be dropped in.

### Upgrading

Edit `PLATFORM_GO_VERSION`, run `pnpm run codegen`, commit the diff. CI fails if the committed output is not exactly
what the pinned tag produces, so a bumped pin without a regeneration — or a hand-edited generated file — is a red build
rather than a runtime surprise.
