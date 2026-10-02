import { describe, expect, it } from 'vitest';

import { type ExchangeCoordinator, InMemoryExchangeCoordinator } from './coordinator';
import { PlatformError, SignInReason } from './errors';
import { type IssuedToken, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { NotSignedInError, Session, type SessionConfig } from './session';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore, refusal } from './testing';
import { Code, StatusError } from './transport';

const getSelf = SignInServiceService.getSelf;
const exchange = SignInServiceService.exchangeRefreshToken;
const switchAccount = SignInServiceService.switchAccount;

function setup(held = true, config: Partial<SessionConfig> = {}) {
  const clock = new FakeClock();
  const coordinator = new InMemoryExchangeCoordinator({ clock });
  const transport = new FakeTransport().handle(getSelf, () => ({ user: undefined }));
  const sessionFor = (store: MemoryCredentialStore) => new Session({ transport, store, clock, coordinator, ...config });
  const store = new MemoryCredentialStore(held ? fakeIssuedToken(clock.now()) : undefined);
  return { clock, transport, store, session: sessionFor(store), sessionFor };
}

function successor(now: Date, n: number, account: string): IssuedToken {
  return fakeIssuedToken(now, {
    token: `access-${String(n)}`,
    refreshToken: `refresh-${String(n)}`,
    tokenId: `jti-${String(n)}`,
    activeAccountId: account,
  });
}

const tokenSent = (options: { metadata?: Record<string, string> }) => options.metadata?.['authorization'];

describe('Session.switchAccount', () => {
  it('spends the refresh token for one in the named account, and saves it', async () => {
    const { clock, transport, store, session } = setup();
    transport.handle(switchAccount, () => ({ token: successor(clock.now(), 2, 'account-2') }));

    const token = await session.switchAccount('account-2');

    expect(token.activeAccountId).toBe('account-2');
    expect(transport.callsTo(switchAccount)[0]?.request).toEqual({ refreshToken: 'refresh-1', accountId: 'account-2' });
    expect(tokenSent(transport.callsTo(switchAccount)[0]!.options)).toBeUndefined();
    expect((await store.load())?.refreshToken).toBe('refresh-2');
    expect(session.state).toBe('authenticated');
  });

  it('holds calls made during the switch, and serves them its successor (R20)', async () => {
    const { clock, transport, session } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.handle(switchAccount, async () => {
      await held;
      return { token: successor(clock.now(), 2, 'account-2') };
    });

    const switching = session.switchAccount('account-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = session.call(getSelf, {});
    release();
    await Promise.all([switching, call]);

    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
  });

  it('never presents the token twice when it is already being exchanged (R1)', async () => {
    const { clock, transport, session } = setup();
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2, 'account-1') }));
    transport.handle(switchAccount, (req) => ({ token: successor(clock.now(), 3, req.accountId) }));

    clock.advance(60 * 60 * 1000);
    await Promise.all([session.call(getSelf, {}), session.switchAccount('account-2')]);

    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(transport.callsTo(switchAccount).map((c) => (c.request as { refreshToken: string }).refreshToken)).toEqual([
      'refresh-2',
    ]);
  });

  it('switches with the successor when another Session exchanged the token first', async () => {
    const { clock, transport, sessionFor } = setup();
    const cookie = fakeIssuedToken(clock.now());
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2, 'account-1') }));
    transport.handle(switchAccount, (req) => ({ token: successor(clock.now(), 3, req.accountId) }));

    clock.advance(60 * 60 * 1000);
    await sessionFor(new MemoryCredentialStore(cookie)).call(getSelf, {});
    const stale = new MemoryCredentialStore(cookie);
    const token = await sessionFor(stale).switchAccount('account-2');

    expect(token.activeAccountId).toBe('account-2');
    expect(transport.callsTo(switchAccount).map((c) => (c.request as { refreshToken: string }).refreshToken)).toEqual([
      'refresh-2',
    ]);
    expect((await stale.load())?.refreshToken).toBe('refresh-3');
  });

  it('keeps the login where it was when the account is refused and the token still exchanges', async () => {
    const { clock, transport, store, session } = setup();
    transport.handle(switchAccount, () => {
      throw refusal(Code.UNAUTHENTICATED, 'invalid credentials', 'INVALID_CREDENTIALS');
    });
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2, 'account-1') }));

    const err = await session.switchAccount('not-mine').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).is(SignInReason.INVALID_CREDENTIALS)).toBe(true);
    expect(transport.callsTo(exchange).map((c) => c.request)).toEqual([{ refreshToken: 'refresh-1' }]);
    expect((await store.load())?.refreshToken).toBe('refresh-2');
    expect(session.state).toBe('authenticated');
  });

  it('serves calls held during a refused switch the successor, when the login was kept (R20)', async () => {
    const { clock, transport, session } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.handle(switchAccount, async () => {
      await held;
      throw refusal(Code.UNAUTHENTICATED, 'invalid credentials', 'INVALID_CREDENTIALS');
    });
    transport.handle(exchange, () => ({ token: successor(clock.now(), 2, 'account-1') }));

    const switching = session.switchAccount('not-mine').catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = session.call(getSelf, {});
    release();
    const [err] = await Promise.all([switching, call]);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).is(SignInReason.INVALID_CREDENTIALS)).toBe(true);
    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
    expect(session.state).toBe('authenticated');
  });

  it('ends the login when the refused token does not exchange either', async () => {
    const { transport, store, session } = setup();
    transport.handle(switchAccount, () => {
      throw refusal(Code.UNAUTHENTICATED, 'invalid credentials', 'INVALID_CREDENTIALS');
    });
    transport.handle(exchange, () => {
      throw refusal(Code.UNAUTHENTICATED, 'invalid credentials', 'INVALID_CREDENTIALS');
    });

    await expect(session.switchAccount('account-2')).rejects.toBeInstanceOf(PlatformError);

    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it('keeps the access token and drops the refresh token when a switch fails ambiguously (R5)', async () => {
    const { transport, store, session } = setup();
    transport.handle(switchAccount, () => {
      throw new StatusError(Code.UNAVAILABLE, 'connection reset');
    });

    await expect(session.switchAccount('account-2')).rejects.toMatchObject({ code: Code.UNAVAILABLE });

    expect(transport.callsTo(switchAccount)).toHaveLength(1);
    expect(transport.callsTo(exchange)).toHaveLength(0);
    expect(await store.load()).toMatchObject({ token: 'access-1', refreshToken: '' });
  });

  it('keeps the access token and drops the refresh token when a switch answers OK with no token (R5)', async () => {
    const { transport, store, session } = setup();
    transport.handle(switchAccount, () => ({ token: undefined }));

    await expect(session.switchAccount('account-2')).rejects.toThrow('answered OK with no token');

    expect(transport.callsTo(exchange)).toHaveLength(0);
    expect(await store.load()).toMatchObject({ token: 'access-1', refreshToken: '' });
    expect(session.state).toBe('authenticated');
  });

  it('never sends a switch as a takeover, and abandons the refresh token instead (R5)', async () => {
    const takingOver: ExchangeCoordinator = {
      run: (_refreshToken, exchange) => exchange({ idempotencyKey: 'key-from-claim', takeover: true }),
    };
    const { transport, store, session } = setup(true, { coordinator: takingOver });

    await expect(session.switchAccount('account-2')).rejects.toThrow('never reported back');

    expect(transport.callsTo(switchAccount)).toHaveLength(0);
    expect(transport.callsTo(exchange)).toHaveLength(0);
    expect(await store.load()).toMatchObject({ token: 'access-1', refreshToken: '' });
  });

  it('gives up, keeping the login where it is, when the token is exchanged out from under it twice', async () => {
    const clock = new FakeClock();
    let n = 1;
    // Every run answers with another Session's outcome, as though each token had already been exchanged.
    const exchangedElsewhere: ExchangeCoordinator = {
      run: () => Promise.resolve(successor(clock.now(), ++n, 'account-1')),
    };
    const transport = new FakeTransport();
    const store = new MemoryCredentialStore(fakeIssuedToken(clock.now()));
    const session = new Session({ transport, store, clock, coordinator: exchangedElsewhere });

    await expect(session.switchAccount('account-2')).rejects.toThrow('exchanged twice');

    expect(transport.calls).toEqual([]);
    expect(await store.load()).toMatchObject({ refreshToken: 'refresh-3', activeAccountId: 'account-1' });
    expect(session.state).toBe('authenticated');
  });

  it('switches the login it held when a sign-in in flight is refused', async () => {
    const { clock, transport, store, session } = setup();
    const login = SignInServiceService.loginForToken;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    transport.handle(login, async () => {
      await held;
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    });
    transport.handle(switchAccount, (req) => ({ token: successor(clock.now(), 2, req.accountId) }));

    const signingIn = session.signIn(login, { credentials: undefined }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const switching = session.switchAccount('account-2');
    release();
    await signingIn;

    expect((await switching).activeAccountId).toBe('account-2');
    expect(transport.callsTo(switchAccount)[0]?.request).toEqual({ refreshToken: 'refresh-1', accountId: 'account-2' });
    expect((await store.load())?.refreshToken).toBe('refresh-2');
  });

  it('refuses to switch without a login, or to no account', async () => {
    const { transport, session } = setup(false);

    await expect(session.switchAccount('account-2')).rejects.toBeInstanceOf(NotSignedInError);
    await expect(session.switchAccount('')).rejects.toThrow('needs an account');
    expect(transport.callsTo(switchAccount)).toHaveLength(0);
  });
});
