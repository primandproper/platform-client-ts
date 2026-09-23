import { describe, expect, it } from 'vitest';

import { PlatformError } from './errors';
import { type IssuedToken, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { NotSignedInError, Session, type SessionState } from './session';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore } from './testing';
import { Code, StatusError } from './transport';

const getSelf = SignInServiceService.getSelf;
const exchange = SignInServiceService.exchangeRefreshToken;
const login = SignInServiceService.loginForToken;

function setup(held?: (now: Date) => IssuedToken | undefined) {
  const clock = new FakeClock();
  const store = new MemoryCredentialStore(held ? held(clock.now()) : undefined);
  const transport = new FakeTransport().handle(getSelf, () => ({ user: undefined }) as never);
  const session = new Session({ transport, store, clock, metadata: { 'x-tenant': 'acme' } });
  const states: SessionState[] = [];
  session.onStateChange((s) => states.push(s));
  return { clock, store, transport, session, states };
}

function successor(now: Date, n: number): IssuedToken {
  return fakeIssuedToken(now, { token: `access-${n}`, refreshToken: `refresh-${n}`, tokenId: `jti-${n}` });
}

const tokenSent = (options: { metadata?: Record<string, string> }) => options.metadata?.['authorization'];

describe('Session', () => {
  it('adopts a stored session and sends its token with the tenant entries', async () => {
    const { transport, session } = setup((now) => fakeIssuedToken(now));

    await session.call(getSelf, {});

    expect(session.state).toBe('authenticated');
    expect(transport.callsTo(getSelf)[0]?.options.metadata).toEqual({
      'authorization': 'Bearer access-1',
      'x-tenant': 'acme',
    });
  });

  it('sends the tenant entries on an anonymous call too, and no credential', async () => {
    const { transport, session } = setup((now) => fakeIssuedToken(now));

    await session.callAnonymous(getSelf, {});

    expect(transport.callsTo(getSelf)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('refuses an authenticated call with no session', async () => {
    const { transport, session } = setup();

    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(NotSignedInError);
    expect(transport.calls).toEqual([]);
    expect(session.state).toBe('anonymous');
  });

  it('does not refresh outside the skew', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));

    clock.advance(60 * 60 * 1000 - 31_000);
    await session.call(getSelf, {});

    expect(transport.callsTo(exchange)).toEqual([]);
  });

  it('refreshes inside the skew, persisting the successor before using it', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2) }));
    let storedWhenUsed: IssuedToken | undefined;
    transport.handle(getSelf, async () => {
      storedWhenUsed = await store.load();
      return { user: undefined } as never;
    });

    clock.advance(60 * 60 * 1000 - 30_000);
    await session.call(getSelf, {});

    expect(transport.callsTo(exchange).map((c) => c.request)).toEqual([{ refreshToken: 'refresh-1' }]);
    expect(transport.callsTo(exchange)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
    expect(storedWhenUsed?.refreshToken).toBe('refresh-2');
    expect(session.state).toBe('authenticated');
  });

  it('makes one exchange for any number of concurrent callers (R1)', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.handle(exchange, async () => {
      await held;
      return { token: successor(clock.now(), 2) };
    });

    clock.advance(60 * 60 * 1000);
    const calls = Array.from({ length: 5 }, () => session.call(getSelf, {}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state).toBe('refreshing');
    release();
    await Promise.all(calls);

    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(transport.callsTo(getSelf).map((c) => tokenSent(c.options))).toEqual(Array(5).fill('Bearer access-2'));
  });

  it('ends the session without a round trip once the refresh token has expired', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));

    clock.advance(24 * 60 * 60 * 1000);

    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(NotSignedInError);
    expect(transport.calls).toEqual([]);
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it.each([
    ['UNAUTHENTICATED (R7)', Code.UNAUTHENTICATED],
    ['PERMISSION_DENIED', Code.PERMISSION_DENIED],
  ])('signs out when the exchange is refused with %s', async (_name, code) => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => {
      throw new StatusError(code, 'refused');
    });

    clock.advance(60 * 60 * 1000);
    const err = await session.call(getSelf, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).code).toBe(code);
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
    expect(transport.callsTo(getSelf)).toEqual([]);
  });

  it('keeps the session when the exchange fails some other way (R2)', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => {
      throw new StatusError(Code.RESOURCE_EXHAUSTED, 'slow down');
    });

    clock.advance(60 * 60 * 1000 - 10_000);
    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(PlatformError);

    expect(session.state).toBe('authenticated');
    expect((await store.load())?.refreshToken).toBe('refresh-1');
  });

  it('never re-sends a refresh token an ambiguous exchange may have spent (R2, R5)', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => {
      throw new StatusError(Code.UNAVAILABLE, 'connection reset');
    });

    clock.advance(60 * 60 * 1000 - 10_000);
    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(PlatformError);

    expect(session.state).toBe('authenticated');
    expect((await store.load())?.refreshToken).toBe('');

    await session.call(getSelf, {});
    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-1');

    clock.advance(10_000);
    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(NotSignedInError);
    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(session.state).toBe('anonymous');
  });

  it('refreshes once and retries once when a call is answered UNAUTHENTICATED (R3)', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2) }));
    transport.handle(getSelf, (_req, options) => {
      if (tokenSent(options) === 'Bearer access-1') {
        throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
      }
      return { user: undefined } as never;
    });

    await session.call(getSelf, {});

    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(transport.callsTo(getSelf).map((c) => tokenSent(c.options))).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('signs out on a second UNAUTHENTICATED rather than looping (R3)', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2) }));
    transport.handle(getSelf, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    });

    await expect(session.call(getSelf, {})).rejects.toMatchObject({ code: Code.UNAUTHENTICATED });

    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(transport.callsTo(getSelf)).toHaveLength(2);
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it('does not surface an error that is not UNAUTHENTICATED as a reason to refresh', async () => {
    const { transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(getSelf, () => {
      throw new StatusError(Code.NOT_FOUND, 'no');
    });

    await expect(session.call(getSelf, {})).rejects.toMatchObject({ code: Code.NOT_FOUND });
    expect(transport.callsTo(exchange)).toEqual([]);
  });

  it('treats a session with no refresh token as valid until its access token expires', async () => {
    const { clock, transport, session } = setup((now) =>
      fakeIssuedToken(now, { refreshToken: '', refreshTokenExpiresAt: undefined }),
    );

    clock.advance(60 * 60 * 1000 - 1);
    await session.call(getSelf, {});
    clock.advance(1);

    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(NotSignedInError);
    expect(transport.callsTo(exchange)).toEqual([]);
    expect(session.state).toBe('anonymous');
  });

  it('adopts and saves what a sign-in door answers', async () => {
    const { clock, store, transport, session, states } = setup();
    transport.handle(login, () => ({ token: fakeIssuedToken(clock.now()) }));

    const token = await session.signIn(login, { credentials: undefined });

    expect(token.token).toBe('access-1');
    expect((await store.load())?.token).toBe('access-1');
    expect(states).toEqual(['authenticating', 'authenticated']);
    expect(transport.callsTo(login)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('stays anonymous when a sign-in is refused, and surfaces the refusal', async () => {
    const { store, transport, session, states } = setup();
    transport.handle(login, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    });

    await expect(session.signIn(login, { credentials: undefined })).rejects.toBeInstanceOf(PlatformError);

    expect(await store.load()).toBeUndefined();
    expect(states).toEqual(['authenticating', 'anonymous']);
  });

  it('serves a call that was waiting on a sign-in', async () => {
    const { clock, transport, session } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.handle(login, async () => {
      await held;
      return { token: fakeIssuedToken(clock.now()) };
    });

    const signingIn = session.signIn(login, { credentials: undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waiting = session.call(getSelf, {});
    release();
    await Promise.all([signingIn, waiting]);

    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-1');
  });

  it('still uses a successor it failed to persist, and surfaces the failure', async () => {
    const { clock, store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2) }));
    store.save = async () => {
      throw new Error('disk full');
    };

    clock.advance(60 * 60 * 1000);
    await expect(session.call(getSelf, {})).rejects.toThrow('disk full');
    await session.call(getSelf, {});

    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
    expect(transport.callsTo(exchange)).toHaveLength(1);
  });
});
