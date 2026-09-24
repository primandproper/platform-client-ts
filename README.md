# platform-client-ts

The TypeScript client for services built on [`platform-go`](https://github.com/primandproper/platform-go): generated
stubs for platform's own protos, and the runtime that makes calling them safe.

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

## What it speaks

**platform-go v14.1.0** (`PLATFORM_GO_VERSION`). The generated stubs are exactly that tag's protos, and the runtime
implements
[`platform-go`'s client contract](https://github.com/primandproper/platform-go/blob/v14.1.0/docs/client-contract.md) as
it describes that tag. Two rules need a server at least that new: R10 (the keyed refresh retry, which is opt-in for that
reason) and R11 (sign-in reasons, which an older server simply does not send).

The package is `0.x` until DDB's web frontend has adopted it. Its version is its own: it states the platform-go tag it
speaks rather than mirroring it, because a client-only fix needs a version number of its own to ship under.

## Using it

One `Session` per login, for every service that login calls: platform's and the product's own. It holds the session,
refreshes it, and sends the tenant's metadata on every call (R12). Any ts-proto `outputServices=grpc-js` method
definition goes through it, so a product's own services share the same refresher instead of racing it.

**One `ExchangeCoordinator` per deployment.** A refresh token works once (R1), and every `Session` exchanges through a
coordinator that makes sure each token is presented once however many Sessions hold it, keeping the outcome for a minute
(`settledGraceMs`) for a request that arrives still holding the spent token. The default is an in-memory one shared by
the whole process, which is right for one process and wrong for several: a deployment of more than one instance needs a
coordinator they all share, which is `SharedExchangeCoordinator` ([below](#several-instances)).

```ts
import * as grpc from '@grpc/grpc-js';
import { createGrpcJsTransport, getAuthStatus, Session, signIn } from '@primandproper/platform-client';
import { RecipesServiceService } from './generated/recipes'; // a product's own stubs

const session = new Session({
  transport: createGrpcJsTransport({ address: 'api.example.com:443', credentials: grpc.credentials.createSsl() }),
  store: myCredentialStore, // required: there is no default, see below
  metadata: { 'x-tenant': 'acme' }, // only if the deployment carries the tenant in metadata
  idempotentRefresh: true, // R10: only if the server is v14.1.0+ AND its refresh-token store supports it
});

const result = await signIn(session, { handle: { emailAddress: 'a@example.com' }, password });
if (result.kind === 'second_factor_required') {
  await result.resend(await promptForCode());
}

const status = await getAuthStatus(session); // status.requiredActions says where to send them
const recipe = await session.call(RecipesServiceService.getRecipe, { id });
```

**There is no default `CredentialStore`.** It holds the refresh token, which belongs in the platform's most protected
store and nowhere a log, a crash report or a URL can reach. A default that could not meet that bar would be worse than
none. The in-memory `MemoryCredentialStore` in `@primandproper/platform-client/testing` is for tests, alongside
`FakeTransport` and `FakeClock`.

### A Session per request

A backend-for-frontend holds a browser's session in a cookie, so it builds a `Session` per request over a store backed
by that request's cookie. Concurrent requests near expiry, and a request that left the browser before the refreshed
cookie arrived, all carry the same refresh token; the coordinator exchanges it once and hands each of them the
successor. Nothing here deletes the cookie on a failed refresh: `Session` clears the store only when the login is really
over (R2, R7).

```ts
// SvelteKit's hooks.server.ts; any framework with request-scoped cookies has the same shape.
import type { Cookies, Handle } from '@sveltejs/kit';
import { type CredentialStore, IssuedToken, Session } from '@primandproper/platform-client';

const cookieName = 'session';

function cookieStore(cookies: Cookies): CredentialStore {
  return {
    async load() {
      const raw = cookies.get(cookieName);
      return raw ? IssuedToken.fromJSON(JSON.parse(raw)) : undefined;
    },
    async save(token) {
      cookies.set(cookieName, JSON.stringify(IssuedToken.toJSON(token)), {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        expires: token.refreshTokenExpiresAt ?? token.expiresAt,
      });
    },
    async clear() {
      cookies.delete(cookieName, { path: '/' });
    },
  };
}

export const handle: Handle = async ({ event, resolve }) => {
  // transport is built once per process; the Session, like the cookie, is per request.
  event.locals.session = new Session({ transport, store: cookieStore(event.cookies) });
  return resolve(event);
};
```

### Several instances

A load balancer sends one browser's concurrent requests to different instances, which share no memory, so each would
exchange the same refresh token. `SharedExchangeCoordinator` coordinates them through a `CoordinationStore` you write
over a store they already share; the package takes no dependency on one. The first instance to claim a token exchanges
it and publishes the outcome for `settledGraceMs`, and the rest poll for it. The published successor is sealed with
AES-GCM under a key derived from the spent refresh token, so read access to the store yields nothing usable. An instance
that dies mid-exchange leaves a claim that expires after `claimTtlMs` (90s by default), and the next caller takes the
exchange over under the same idempotency key: sent as an R10 retry with `idempotentRefresh` on, and never sent with it
off. A store that cannot be reached fails the refresh with `ExchangeNotSentError` before the token is sent, so the
session keeps its refresh token and tries again on the next call.

With Redis or Valkey, through `redis` (node-redis):

```ts
import { createClient } from 'redis';
import { type CoordinationStore, SharedExchangeCoordinator } from '@primandproper/platform-client';

const redis = await createClient({ url: process.env.REDIS_URL }).connect();

const coordinationStore: CoordinationStore = {
  async setIfAbsent(key, value, ttlMs) {
    return (await redis.set(key, value, { NX: true, PX: ttlMs })) === 'OK'; // SET key value NX PX ttl
  },
  async get(key) {
    return (await redis.get(key)) ?? undefined; // GET key
  },
  async set(key, value, ttlMs) {
    await redis.set(key, value, { PX: ttlMs }); // SET key value PX ttl
  },
};

// One per process, shared by every Session it builds.
const coordinator = new SharedExchangeCoordinator({ store: coordinationStore });
event.locals.session = new Session({ transport, store: cookieStore(event.cookies), coordinator });
```

**`idempotentRefresh` is off by default.** A client cannot tell from the wire whether the server supports R10, and
against one that does not, a keyed retry is a bare retry: reuse, and the login revoked. Off, an exchange that fails
ambiguously keeps the session until its access token expires and never re-sends the refresh token (R5).

**Only a Node transport ships today** (`@grpc/grpc-js`). A browser calling services directly would need a gRPC-web or
Connect transport behind the same `Transport` interface.

## The contract, rule by rule

| rule | what                                                           | where                                                                                           |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| R1   | one refresh at a time                                          | `Session` (`refresh`), `ExchangeCoordinator`                                                    |
| R2   | a failed refresh that is not a refusal does not sign out       | `Session` (`settleFailedExchange`)                                                              |
| R3   | one refresh-and-retry on `UNAUTHENTICATED`, never a loop       | `Session.call`                                                                                  |
| R4   | an idempotency key per logical operation, outside the retry    | the refresh exchange; any other call passes its own `idempotency-key` in `CallOptions.metadata` |
| R5   | never re-send a refresh token bare                             | `Session` (`abandonRefreshToken`)                                                               |
| R6   | persist the successor before using it                          | `Session` (`adopt`)                                                                             |
| R7   | `UNAUTHENTICATED` from an exchange is signed out, no questions | `Session` (`settleFailedExchange`)                                                              |
| R8   | cursors are opaque                                             | `pages`, `items`                                                                                |
| R9   | `counts_known` gates the counts                                | `counts`                                                                                        |
| R10  | retry an ambiguous exchange once, same key                     | `SessionConfig.idempotentRefresh` (opt-in), `isAmbiguous`                                       |
| R11  | branch on the reason, never the message                        | `PlatformError.is`, `SignInReason`                                                              |
| R12  | the tenant travels identically on every call                   | `SessionConfig.metadata`, `withConstantMetadata`                                                |
| R13  | the reason where there is one, the code where there is not     | `PlatformError`                                                                                 |
| R14  | walk until a page has no rows                                  | `pages`                                                                                         |
| R15  | the same screen whether the address exists or not              | `requestPasswordReset`, `requestMagicLink`                                                      |
| R16  | verify a reset link before rendering the form                  | `verifyPasswordResetToken`                                                                      |
| R17  | sign out on the server, then locally                           | `signOut`, `signOutEverywhere`                                                                  |

Streams are not covered, because the contract parks them: no platform-go proto declares one.

## Codegen

```bash
pnpm install
pnpm run codegen        # fetch the protos, then generate
pnpm exec tsc --noEmit  # typecheck
pnpm test               # vitest
pnpm run build          # ESM and .d.ts into dist/
pnpm run check-build    # import the built package from plain Node
pnpm run check-consumer # typecheck a consumer on other runtime versions against the packed package
```

**One pin, one derived version.** `PLATFORM_GO_VERSION` names a `platform-go` tag. The `primitives-go` version is _read
out of that tag's `go.mod`_ rather than pinned separately — `filtering.proto` lives there, and generating it from a
different version than the server was built against is a wire mismatch nothing in this repository would catch.

`scripts/fetch-protos.sh` downloads both tarballs from GitHub and lays every `.proto` under one include root. **No Go
toolchain**: this is a TypeScript repository and it stays one, which is why it fetches a tag rather than resolving the
module cache the way DDB's Makefile does. `google/rpc/status.proto` and `error_details.proto`, which carry the sign-in
reasons, are googleapis rather than protoc's well-knowns, and are vendored under `third_party/googleapis` at the commit
recorded beside them.

Flags match DDB's (`outputServices=grpc-js`, `esModuleInterop=true`, then prettier), because output that does not match
is output that cannot be dropped in.

### In a product

A product's protos import platform's (`User`, `Account`, `QueryFilter`). Map those imports onto this package's subpaths
rather than generating a second copy of platform's messages:

```
--ts_proto_opt=Mprimandproper/platform/identity/v1/identity.proto=@primandproper/platform-client/identity/v1
--ts_proto_opt=Mprimandproper/platform/filtering/v1/filtering.proto=@primandproper/platform-client/filtering/v1
```

The product's generated `encode` then hands its `BinaryWriter` to ours, which only typechecks if both sides load the
same `@bufbuild/protobuf`. That is why it and `@grpc/grpc-js` are peer dependencies: the product installs them, and this
package uses the product's copy.

### Upgrading

Edit `PLATFORM_GO_VERSION`, run `pnpm run codegen`, commit the diff. CI fails if the committed output is not exactly
what the pinned tag produces, so a bumped pin without a regeneration — or a hand-edited generated file — is a red build
rather than a runtime surprise.
