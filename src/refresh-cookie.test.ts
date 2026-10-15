import { afterEach, describe, expect, it, vi } from 'vitest';

import { type IssuedToken, SignInServiceDefinition } from './generated/primandproper/platform/signin/v1/signin';
import { type ExchangeLock, type HintStorage, refreshCookieCredentialStore } from './refresh-cookie';
import { NotSignedInError, Session, type SessionConfig, type SessionState } from './session';
import { signOut } from './signout';
import { FakeClock, fakeIssuedToken, FakeTransport } from './testing';
import { Code, methodsOf, StatusError } from './transport';

const SignInService = methodsOf(SignInServiceDefinition);

const getSelf = SignInService.getSelf;
const exchange = SignInService.exchangeRefreshToken;
const login = SignInService.loginForToken;
const switchAccount = SignInService.switchAccount;
const signOutRpc = SignInService.signOut;

const dayMs = 24 * 60 * 60 * 1000;

class MemoryHints implements HintStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** cookieIssued is what a v15.2.0 server answers over gRPC-web: the refresh token is in a cookie, not the body. */
function cookieIssued(now: Date, n: number, overrides: Partial<IssuedToken> = {}): IssuedToken {
  return fakeIssuedToken(now, {
    token: `access-${String(n)}`,
    tokenId: `jti-${String(n)}`,
    refreshToken: '',
    refreshTokenExpiresAt: new Date(now.getTime() + dayMs),
    ...overrides,
  });
}

/**
 * cookieServer stands in for the server and the browser's cookie jar: an exchange sent with the field empty spends the
 * cookie the jar held when the request left, and a cookie presented twice is reuse. While `offline`, no request leaves.
 */
function cookieServer(clock: FakeClock, transport: FakeTransport) {
  const jar = { cookie: 'cookie-1' as string | undefined, offline: false };
  const spent = new Set<string>();
  let n = 1;
  transport.handle(exchange, async (request) => {
    if (jar.offline) {
      throw new TypeError('Failed to fetch');
    }
    const presented = request.refreshToken || jar.cookie;
    // The response takes a round trip, during which another tab may send the same cookie.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!presented || spent.has(presented)) {
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    }
    spent.add(presented);
    n++;
    jar.cookie = `cookie-${String(n)}`;
    return { token: cookieIssued(clock.now(), n) };
  });
  return jar;
}

function setup(hint?: (now: Date) => Date, config: Partial<SessionConfig> = {}) {
  const clock = new FakeClock();
  const hints = new MemoryHints();
  if (hint) {
    hints.setItem('hint', hint(clock.now()).toISOString());
  }
  const transport = new FakeTransport().handle(getSelf, () => ({ user: undefined }));
  // A Session over a fresh store is a page that just loaded, or another tab.
  const load = () =>
    new Session({ transport, store: refreshCookieCredentialStore({ hints, key: 'hint' }), clock, ...config });
  const session = load();
  const states: SessionState[] = [];
  session.onStateChange((s) => states.push(s));
  return { clock, hints, transport, session, states, load };
}

const tokenSent = (options: { metadata?: Record<string, string> }) => options.metadata?.['authorization'];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshCookieCredentialStore', () => {
  it('keeps the access token in memory and persists only the refresh token expiry', async () => {
    const { clock, hints, transport, session } = setup();
    const issued = cookieIssued(clock.now(), 1);
    transport.handle(login, () => ({ token: issued }));

    await session.signIn(login, { credentials: undefined });

    expect([...hints.items.entries()]).toEqual([['hint', issued.refreshTokenExpiresAt!.toISOString()]]);
    expect(await session.held()).toBe(issued);
  });

  it('writes no hint for a token that carries its own refresh token, since no cookie was set', async () => {
    const { clock, hints, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    transport.handle(login, () => ({ token: fakeIssuedToken(clock.now()) }));

    await session.signIn(login, { credentials: undefined });

    expect(hints.items.size).toBe(0);
  });

  it('reads an unparseable hint as no session', async () => {
    const hints = new MemoryHints();
    hints.setItem('hint', 'not a date');

    expect(await refreshCookieCredentialStore({ hints, key: 'hint' }).load()).toBeUndefined();
  });

  it('signs in, and reloads as signed out, when the hint storage throws', async () => {
    const clock = new FakeClock();
    const broken: HintStorage = {
      getItem: () => {
        throw new Error('storage is disabled');
      },
      setItem: () => Promise.reject(new Error('quota exceeded')),
      removeItem: () => {
        throw new Error('storage is disabled');
      },
    };
    const transport = new FakeTransport().handle(login, () => ({ token: cookieIssued(clock.now(), 1) }));
    const store = refreshCookieCredentialStore({ hints: broken });

    await new Session({ transport, store, clock }).signIn(login, { credentials: undefined });
    await expect(store.clear()).resolves.toBeUndefined();

    expect(await refreshCookieCredentialStore({ hints: broken }).load()).toBeUndefined();
  });

  it('refuses to be built with nowhere to keep the hint', () => {
    expect(() => refreshCookieCredentialStore()).toThrow(/needs hints/);
  });
});

describe('Session with the refresh token in a cookie', () => {
  it('resumes after a reload with a valid cookie, without a sign-in', async () => {
    const { clock, hints, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    cookieServer(clock, transport);

    await session.call(getSelf, {});

    expect(transport.callsTo(exchange).map((c) => c.request)).toEqual([{ refreshToken: '' }]);
    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
    expect(session.state).toBe('authenticated');
    expect(hints.getItem('hint')).toBe(new Date(clock.now().getTime() + dayMs).toISOString());
  });

  it('lands signed out after a reload with an expired or foreign cookie', async () => {
    const { clock, hints, transport, session, states } = setup((now) => new Date(now.getTime() + dayMs));
    const jar = cookieServer(clock, transport);
    jar.cookie = undefined;

    await expect(session.call(getSelf, {})).rejects.toMatchObject({ code: Code.UNAUTHENTICATED });

    expect(session.state).toBe('anonymous');
    expect(states.at(-1)).toBe('anonymous');
    expect(await session.held()).toBeUndefined();
    expect(hints.items.size).toBe(0);
    expect(transport.callsTo(getSelf)).toEqual([]);
  });

  it('lands signed out without a round trip once the hinted expiry has passed', async () => {
    const { clock, hints, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    cookieServer(clock, transport);

    clock.advance(dayMs);

    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(NotSignedInError);
    expect(transport.calls).toEqual([]);
    expect(hints.items.size).toBe(0);
  });

  it('is unreachable after an offline reload, keeps the hint, and resumes from the same cookie once back', async () => {
    const { clock, hints, transport, session, states } = setup((now) => new Date(now.getTime() + dayMs));
    const hint = hints.getItem('hint');
    const jar = cookieServer(clock, transport);
    jar.offline = true;

    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(TypeError);

    expect(session.state).toBe('unreachable');
    expect(states.at(-1)).toBe('unreachable');
    expect(hints.getItem('hint')).toBe(hint);
    expect(transport.callsTo(getSelf)).toEqual([]);

    jar.offline = false;
    await session.call(getSelf, {});

    expect(transport.callsTo(exchange)).toHaveLength(2);
    expect(transport.callsTo(getSelf).map((c) => tokenSent(c.options))).toEqual(['Bearer access-2']);
    expect(jar.cookie).toBe('cookie-2');
    expect(session.state).toBe('authenticated');
  });

  it.each([Code.UNAVAILABLE, Code.DEADLINE_EXCEEDED, Code.INTERNAL, Code.UNKNOWN])(
    'is unreachable after a reload whose exchange fails ambiguously with %s, and keeps the hint',
    async (code) => {
      const { hints, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
      const hint = hints.getItem('hint');
      transport.handle(exchange, () => {
        throw new StatusError(code, 'no answer');
      });

      await expect(session.call(getSelf, {})).rejects.toMatchObject({ code });

      expect(session.state).toBe('unreachable');
      expect(hints.getItem('hint')).toBe(hint);
      expect(transport.callsTo(getSelf)).toEqual([]);
    },
  );

  it('stays unreachable when a sign-in fails, rather than claiming the hint is a login', async () => {
    const { transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    transport.handle(exchange, () => {
      throw new TypeError('Failed to fetch');
    });
    transport.handle(login, () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(TypeError);

    await expect(session.signIn(login, { credentials: undefined })).rejects.toBeInstanceOf(TypeError);

    expect(session.state).toBe('unreachable');
  });

  it('keeps the access token it still holds when a refresh in the skew cannot reach the server', async () => {
    const { clock, hints, transport, session } = setup();
    const issued = cookieIssued(clock.now(), 1);
    transport.handle(login, () => ({ token: issued }));
    transport.handle(exchange, () => {
      throw new TypeError('Failed to fetch');
    });
    await session.signIn(login, { credentials: undefined });

    clock.advance(60 * 60 * 1000 - 30_000);
    await expect(session.call(getSelf, {})).rejects.toBeInstanceOf(TypeError);

    expect(session.state).toBe('authenticated');
    expect(await session.held()).toBe(issued);
    expect(hints.getItem('hint')).toBe(issued.refreshTokenExpiresAt!.toISOString());
  });

  it('refreshes in the skew by sending the field empty', async () => {
    const { clock, transport, session } = setup();
    cookieServer(clock, transport);
    transport.handle(login, () => ({ token: cookieIssued(clock.now(), 1) }));
    await session.signIn(login, { credentials: undefined });

    clock.advance(60 * 60 * 1000 - 30_000);
    await session.call(getSelf, {});

    expect(transport.callsTo(exchange).map((c) => c.request)).toEqual([{ refreshToken: '' }]);
    expect(tokenSent(transport.callsTo(getSelf)[0]!.options)).toBe('Bearer access-2');
  });

  it('retries an ambiguous exchange under the same key with R10 on, the field still empty', async () => {
    const { clock, transport, session } = setup((now) => new Date(now.getTime() + dayMs), {
      idempotentRefresh: true,
    });
    let attempts = 0;
    transport.handle(exchange, () => {
      if (attempts++ === 0) {
        throw new StatusError(Code.UNAVAILABLE, 'connection reset');
      }
      return { token: cookieIssued(clock.now(), 2) };
    });

    await session.call(getSelf, {});

    const sent = transport.callsTo(exchange);
    expect(sent.map((c) => c.request)).toEqual([{ refreshToken: '' }, { refreshToken: '' }]);
    expect(sent[0]!.options.metadata?.['idempotency-key']).toBeTruthy();
    expect(sent[1]!.options.metadata?.['idempotency-key']).toBe(sent[0]!.options.metadata?.['idempotency-key']);
  });

  it('switches account by sending the field empty', async () => {
    const { clock, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    transport.handle(switchAccount, () => ({ token: cookieIssued(clock.now(), 2, { activeAccountId: 'account-2' }) }));

    const token = await session.switchAccount('account-2');

    expect(transport.callsTo(switchAccount)[0]?.request).toEqual({ refreshToken: '', accountId: 'account-2' });
    expect(token.activeAccountId).toBe('account-2');
  });

  it('signs out by sending the field empty, and clears the hint', async () => {
    const { hints, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    transport.handle(signOutRpc, () => ({}));

    await signOut(session);

    expect(transport.callsTo(signOutRpc)[0]?.request).toEqual({ refreshToken: '' });
    expect(hints.items.size).toBe(0);
    expect(session.state).toBe('anonymous');
  });

  it('exchanges one tab at a time, each presenting the cookie the last one left', async () => {
    const { clock, transport, load } = setup((now) => new Date(now.getTime() + dayMs));
    cookieServer(clock, transport);

    await Promise.all([load().call(getSelf, {}), load().call(getSelf, {})]);

    expect(transport.callsTo(getSelf).map((c) => tokenSent(c.options))).toEqual(['Bearer access-2', 'Bearer access-3']);
  });

  it('is reuse when tabs are not serialized, which is what the lock is for', async () => {
    const unlocked: ExchangeLock = { run: (fn) => fn() };
    const { clock, transport, load } = setup((now) => new Date(now.getTime() + dayMs), { exchangeLock: unlocked });
    cookieServer(clock, transport);

    const results = await Promise.allSettled([load().call(getSelf, {}), load().call(getSelf, {})]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('takes the Web Lock where there is one', async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    const { clock, transport, session } = setup((now) => new Date(now.getTime() + dayMs));
    cookieServer(clock, transport);

    await session.call(getSelf, {});

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe('primandproper-platform-client:refresh-token-cookie');
  });

  it('leaves a refresh token in the body to the coordinator, outside the lock', async () => {
    const lock = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    const { clock, transport, session } = setup(undefined, { exchangeLock: lock as ExchangeLock });
    transport.handle(login, () => ({ token: fakeIssuedToken(clock.now()) }));
    transport.handle(exchange, () => ({ token: fakeIssuedToken(clock.now(), { token: 'access-2' }) }));
    await session.signIn(login, { credentials: undefined });

    clock.advance(60 * 60 * 1000);
    await session.call(getSelf, {});

    expect(transport.callsTo(exchange).map((c) => c.request)).toEqual([{ refreshToken: 'refresh-1' }]);
    expect(lock.run).not.toHaveBeenCalled();
  });
});
