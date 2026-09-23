import { isAmbiguous, PlatformError, toPlatformError } from './errors';
import { type IssuedToken, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import {
  type Authorizer,
  bearerAuthorizer,
  type Clock,
  type CredentialStore,
  type Metadata,
  systemClock,
} from './seams';
import { type CallOptions, Code, type Transport, type UnaryMethod, withConstantMetadata } from './transport';

/**
 * refreshSkew is how long before an access token's expiry a call refreshes it instead. The contract fixes it at thirty
 * seconds so that two clients do not differ over a value neither can derive, so it is not configurable.
 */
const refreshSkewMs = 30_000;

/** remintWindow is how long after an exchange the server will honour a keyed retry of it. It is not configurable there. */
const remintWindowMs = 10 * 60 * 1000;

const idempotencyKeyHeader = 'idempotency-key';

/**
 * defaultExchangeDeadline is generous on purpose. A short deadline on the exchange turns a slow success into an
 * ambiguous failure, which costs a keyed retry with R10 on and the refresh token with it off.
 */
const defaultExchangeDeadlineMs = 30_000;

export type SessionState = 'anonymous' | 'authenticating' | 'authenticated' | 'refreshing';

export interface SessionConfig {
  transport: Transport;
  store: CredentialStore;
  clock?: Clock;
  authorizer?: Authorizer;
  /**
   * metadata is sent on every call, anonymous and authenticated alike: where a deployment carries the tenant in
   * metadata, this is where it goes (R12).
   */
  metadata?: Metadata;
  /**
   * idempotentRefresh turns on R10: an exchange that fails ambiguously is retried once under the idempotency key the
   * first attempt carried, and the server answers with a fresh successor instead of treating it as reuse.
   *
   * It is off unless the deployment says its server supports it, because a client cannot tell from the wire. It needs
   * a server built from platform-go v14.1.0 or later AND a refresh-token store that implements the behaviour (the ones
   * platform-go ships do; a consumer's own may not). Against one that does not, a keyed retry is a bare retry: reuse,
   * and the login revoked. Off, an ambiguous failure keeps the session until its access token expires and never
   * re-sends the refresh token (R5).
   */
  idempotentRefresh?: boolean;
  /** exchangeDeadlineMs bounds each ExchangeRefreshToken attempt. Thirty seconds unless set. */
  exchangeDeadlineMs?: number;
}

/** NotSignedInError is what an authenticated call rejects with when there is no session to make it with. */
export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotSignedInError';
  }
}

/** A response from one of the three doors that mint a session. */
export interface TokenResponse {
  token: IssuedToken | undefined;
}

/**
 * Session is the sign-in state machine, and the one thing in a process that holds and refreshes an access token. Every
 * service a process calls, platform's and its own alike, goes through one Session, because two refreshers would present
 * the same refresh token twice, which is reuse, which revokes the login (R1).
 *
 * Single-flight is per Session. Two Sessions over one shared store (two browser tabs, say) are two refreshers; a store
 * shared that way has to serialize them itself, with the Web Locks API or its equivalent.
 */
export class Session {
  private readonly transport: Transport;
  private readonly store: CredentialStore;
  private readonly clock: Clock;
  private readonly authorizer: Authorizer;
  private readonly idempotentRefresh: boolean;
  private readonly exchangeDeadlineMs: number;

  private current: IssuedToken | undefined;
  private currentState: SessionState = 'anonymous';
  private loading: Promise<void> | undefined;
  private signingIn: Promise<IssuedToken> | undefined;
  private refreshing: Promise<IssuedToken> | undefined;
  private readonly listeners = new Set<(state: SessionState) => void>();

  constructor(config: SessionConfig) {
    this.transport = config.metadata ? withConstantMetadata(config.transport, config.metadata) : config.transport;
    this.store = config.store;
    this.clock = config.clock ?? systemClock;
    this.authorizer = config.authorizer ?? bearerAuthorizer;
    this.idempotentRefresh = config.idempotentRefresh ?? false;
    this.exchangeDeadlineMs = config.exchangeDeadlineMs ?? defaultExchangeDeadlineMs;
  }

  get state(): SessionState {
    return this.currentState;
  }

  /** onStateChange calls `listener` on every transition, and returns a function that stops it. */
  onStateChange(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * held answers the session as it stands once any sign-in or refresh in flight has settled, or undefined when there is
   * none. It never refreshes.
   */
  async held(): Promise<IssuedToken | undefined> {
    await this.ensureLoaded();
    await this.signingIn?.catch(() => undefined);
    await this.refreshing?.catch(() => undefined);
    return this.current;
  }

  /**
   * clear forgets the session here and in the store. On its own it ends nothing on the server: the refresh token stays
   * exchangeable for the rest of its window, which is why signing out is `signOut`, not this (R17).
   */
  async clear(): Promise<void> {
    await this.end();
  }

  /** callAnonymous makes a call that carries no credential. */
  async callAnonymous<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options?: CallOptions): Promise<Res> {
    try {
      return await this.transport.unary(method, request, options);
    } catch (err) {
      throw toPlatformError(err);
    }
  }

  /**
   * call makes an authenticated call, refreshing first if the token is inside the skew. A call answered UNAUTHENTICATED
   * refreshes once and retries once, and a second UNAUTHENTICATED ends the session (R3).
   */
  async call<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options?: CallOptions): Promise<Res> {
    const token = await this.accessToken();
    try {
      return await this.send(method, request, options, token);
    } catch (err) {
      if (!isUnauthenticated(err)) {
        throw err;
      }
    }

    const retryWith = await this.refreshAfterRefusal(token);
    try {
      return await this.send(method, request, options, retryWith);
    } catch (err) {
      if (isUnauthenticated(err)) {
        await this.end();
      }
      throw err;
    }
  }

  /**
   * callOptionallyAuthenticated makes a call that carries the credential whenever a session is held and none otherwise,
   * for an RPC that answers an anonymous caller rather than refusing one. A held session is refreshed as `call` would;
   * one that turns out to have ended makes the call anonymously instead.
   */
  async callOptionallyAuthenticated<Req, Res>(
    method: UnaryMethod<Req, Res>,
    request: Req,
    options?: CallOptions,
  ): Promise<Res> {
    if (!(await this.held())) {
      return this.callAnonymous(method, request, options);
    }
    try {
      return await this.call(method, request, options);
    } catch (err) {
      if (err instanceof NotSignedInError) {
        return this.callAnonymous(method, request, options);
      }
      throw err;
    }
  }

  /**
   * signIn makes a call to one of the three doors that mint a session and adopts what it answers. A refusal leaves the
   * session as it was, and is surfaced for the caller to branch on.
   */
  async signIn<Req>(
    method: UnaryMethod<Req, TokenResponse>,
    request: Req,
    options?: CallOptions,
  ): Promise<IssuedToken> {
    await this.ensureLoaded();
    const attempt = this.adoptFrom(method, request, options);
    this.signingIn = attempt;
    try {
      return await attempt;
    } finally {
      if (this.signingIn === attempt) {
        this.signingIn = undefined;
      }
    }
  }

  private async adoptFrom<Req>(
    method: UnaryMethod<Req, TokenResponse>,
    request: Req,
    options?: CallOptions,
  ): Promise<IssuedToken> {
    this.setState('authenticating');
    let response: TokenResponse;
    try {
      response = await this.callAnonymous(method, request, options);
    } catch (err) {
      this.setState(this.current ? 'authenticated' : 'anonymous');
      throw err;
    }
    if (!response.token) {
      this.setState(this.current ? 'authenticated' : 'anonymous');
      throw new Error(`${method.path} answered OK with no token`);
    }
    await this.adopt(response.token);
    return response.token;
  }

  private async accessToken(): Promise<IssuedToken> {
    await this.ensureLoaded();
    if (this.signingIn) {
      await this.signingIn.catch(() => undefined);
    }
    if (this.refreshing) {
      return this.refreshing;
    }

    const held = this.current;
    if (!held) {
      throw new NotSignedInError();
    }
    const now = this.clock.now().getTime();

    if (!held.refreshToken) {
      // A service that stores no refresh tokens: the access token is the whole login, and it ends when it expires.
      if (held.expiresAt && now >= held.expiresAt.getTime()) {
        await this.end();
        throw new NotSignedInError();
      }
      return held;
    }
    if (held.refreshTokenExpiresAt && now >= held.refreshTokenExpiresAt.getTime()) {
      await this.end();
      throw new NotSignedInError();
    }
    if (held.expiresAt && now >= held.expiresAt.getTime() - refreshSkewMs) {
      return this.refresh();
    }
    return held;
  }

  private async refreshAfterRefusal(refused: IssuedToken): Promise<IssuedToken> {
    if (this.refreshing) {
      return this.refreshing;
    }
    if (this.current && this.current.token !== refused.token) {
      // Somebody else refreshed while this call was in flight; retry with what they got.
      return this.current;
    }
    if (!this.current?.refreshToken) {
      await this.end();
      throw new NotSignedInError();
    }
    return this.refresh();
  }

  private refresh(): Promise<IssuedToken> {
    if (!this.refreshing) {
      this.refreshing = this.exchange().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async exchange(): Promise<IssuedToken> {
    const held = this.current;
    if (!held?.refreshToken) {
      throw new NotSignedInError();
    }
    this.setState('refreshing');

    // R10's key is minted once per logical exchange, outside the retry, and sent on the first attempt: a key that was
    // not on the original request cannot be recognised on the retry.
    const key = this.idempotentRefresh ? globalThis.crypto.randomUUID() : undefined;
    const startedAt = this.clock.now().getTime();

    let response: TokenResponse;
    try {
      response = await this.exchangeOnce(held.refreshToken, key);
    } catch (first) {
      const retryable =
        key !== undefined && isAmbiguous(first) && this.clock.now().getTime() - startedAt < remintWindowMs;
      if (!retryable) {
        await this.settleFailedExchange(held, first);
        throw first;
      }
      try {
        // One retry per key: honouring it clears the key, so a second presentation would be reuse.
        response = await this.exchangeOnce(held.refreshToken, key);
      } catch (second) {
        await this.settleFailedExchange(held, second);
        throw second;
      }
    }

    if (!response.token) {
      await this.abandonRefreshToken(held);
      throw new Error(`${SignInServiceService.exchangeRefreshToken.path} answered OK with no token`);
    }
    await this.adopt(response.token);
    return response.token;
  }

  private exchangeOnce(refreshToken: string, key: string | undefined): Promise<TokenResponse> {
    return this.callAnonymous(
      SignInServiceService.exchangeRefreshToken,
      { refreshToken },
      {
        // A deadline is wall-clock time for the transport, not the Clock seam's, which decides expiry.
        deadline: new Date(Date.now() + this.exchangeDeadlineMs),
        metadata: key ? { [idempotencyKeyHeader]: key } : undefined,
      },
    );
  }

  private async settleFailedExchange(held: IssuedToken, err: unknown): Promise<void> {
    if (err instanceof PlatformError && (err.code === Code.UNAUTHENTICATED || err.code === Code.PERMISSION_DENIED)) {
      // R7: signed out, and there is no learning why. PERMISSION_DENIED is the directory refusing them: stop asking.
      await this.end();
    } else if (isAmbiguous(err)) {
      await this.abandonRefreshToken(held);
    } else {
      this.setState('authenticated');
    }
  }

  /**
   * abandonRefreshToken is what an exchange that may have spent the refresh token leaves behind. Re-sending it bare would
   * be R5's one forbidden act, and not signing out is R2's, so the session keeps its access token and drops the refresh
   * token, in the store as well so that a restart cannot re-send it either. That is the valid shape of a service that
   * stores no refresh tokens: the login lasts until the access token expires.
   */
  private async abandonRefreshToken(held: IssuedToken): Promise<void> {
    const remaining: IssuedToken = { ...held, refreshToken: '', refreshTokenExpiresAt: undefined };
    this.current = remaining;
    this.setState('authenticated');
    await this.store.save(remaining);
  }

  /**
   * adopt makes `token` the session. It is saved before anything else happens with it (R6): a successor that was
   * exchanged and not persisted is a login that ends at the next restart. If saving fails the token is still used, since
   * it is the only live one, and the failure is surfaced.
   */
  private async adopt(token: IssuedToken): Promise<void> {
    try {
      await this.store.save(token);
    } finally {
      this.current = token;
      this.setState('authenticated');
    }
  }

  private async end(): Promise<void> {
    this.current = undefined;
    this.setState('anonymous');
    await this.store.clear();
  }

  private async send<Req, Res>(
    method: UnaryMethod<Req, Res>,
    request: Req,
    options: CallOptions | undefined,
    token: IssuedToken,
  ): Promise<Res> {
    const metadata = { ...options?.metadata, ...this.authorizer.credentials(token.token) };
    return this.callAnonymous(method, request, { ...options, metadata });
  }

  private ensureLoaded(): Promise<void> {
    this.loading ??= this.store.load().then(
      (token) => {
        if (token && !this.current) {
          this.current = token;
          this.setState('authenticated');
        }
      },
      (err: unknown) => {
        this.loading = undefined;
        throw err;
      },
    );
    return this.loading;
  }

  private setState(next: SessionState): void {
    if (next === this.currentState) {
      return;
    }
    this.currentState = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

function isUnauthenticated(err: unknown): boolean {
  return err instanceof PlatformError && err.code === Code.UNAUTHENTICATED;
}
