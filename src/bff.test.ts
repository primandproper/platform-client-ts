import { describe, expect, it } from 'vitest';

import { encryptedCredentialStore, redirectOnNotSignedIn, resolveOrRedirect, type SealedCookie } from './bff';
import { InMemoryExchangeCoordinator } from './coordinator';
import { PlatformError } from './errors';
import { type IssuedToken, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { NotSignedInError, Session } from './session';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore } from './testing';
import { Code, StatusError } from './transport';

const getSelf = SignInServiceService.getSelf;
const exchange = SignInServiceService.exchangeRefreshToken;

class FakeCookie implements SealedCookie {
  value: string | undefined;
  expires: Date | undefined;
  writes = 0;

  get() {
    return this.value;
  }

  set(value: string, expires: Date | undefined) {
    this.value = value;
    this.expires = expires;
    this.writes++;
  }

  delete() {
    this.value = undefined;
    this.writes++;
  }
}

const key = (fill: number) => new Uint8Array(32).fill(fill);

describe('encryptedCredentialStore', () => {
  it('opens what it sealed, and seals it out of the plain', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date());

    await encryptedCredentialStore(key(1), cookie).save(token);

    expect(cookie.value).not.toContain(token.refreshToken);
    expect(await encryptedCredentialStore(key(1), cookie).load()).toEqual(token);
  });

  it('expires the cookie with the refresh token, not the access token', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date());

    await encryptedCredentialStore(key(1), cookie).save(token);

    expect(cookie.expires).toEqual(token.refreshTokenExpiresAt);
  });

  it('expires the cookie with the access token when there is no refresh token', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date(), { refreshToken: '', refreshTokenExpiresAt: undefined });

    await encryptedCredentialStore(key(1), cookie).save(token);

    expect(cookie.expires).toEqual(token.expiresAt);
  });

  it('reads a cookie sealed under another key as no session, and replaces it on the next save', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date());
    await encryptedCredentialStore(key(1), cookie).save(token);

    const rotated = encryptedCredentialStore(key(2), cookie);

    expect(await rotated.load()).toBeUndefined();
    await rotated.save(token);
    expect(await encryptedCredentialStore(key(2), cookie).load()).toEqual(token);
  });

  it.each([
    ['garbage', 'not a sealed cookie'],
    ['an empty value', ''],
    ['bad base64', '%%%'],
  ])('reads %s as no session', async (_name, value) => {
    const cookie = new FakeCookie();
    cookie.value = value;

    expect(await encryptedCredentialStore(key(1), cookie).load()).toBeUndefined();
  });

  it('reads a tampered cookie as no session', async () => {
    const cookie = new FakeCookie();
    await encryptedCredentialStore(key(1), cookie).save(fakeIssuedToken(new Date()));
    const value = cookie.value ?? '';
    cookie.value = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');

    expect(await encryptedCredentialStore(key(1), cookie).load()).toBeUndefined();
  });

  it('does not rewrite the cookie with the token it loaded', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date());
    await encryptedCredentialStore(key(1), cookie).save(token);
    const writes = cookie.writes;

    const store = encryptedCredentialStore(key(1), cookie);
    const loaded = (await store.load())!;
    await store.save({ ...loaded });

    expect(cookie.writes).toBe(writes);
  });

  it('does not rewrite the cookie with the token it just saved, and does with a new one', async () => {
    const cookie = new FakeCookie();
    const now = new Date();
    const store = encryptedCredentialStore(key(1), cookie);

    await store.save(fakeIssuedToken(now));
    await store.save(fakeIssuedToken(now));
    expect(cookie.writes).toBe(1);

    await store.save(fakeIssuedToken(now, { token: 'access-2' }));
    expect(cookie.writes).toBe(2);
  });

  it('deletes the cookie on clear, and writes the same token again after it', async () => {
    const cookie = new FakeCookie();
    const token = fakeIssuedToken(new Date());
    const store = encryptedCredentialStore(key(1), cookie);
    await store.save(token);

    await store.clear();
    expect(cookie.value).toBeUndefined();

    await store.save(token);
    expect(await store.load()).toEqual(token);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encryptedCredentialStore(new Uint8Array(16), new FakeCookie())).toThrow(/32-byte key/);
  });

  it('lets a Session refresh through it, writing the cookie once', async () => {
    const clock = new FakeClock();
    const cookie = new FakeCookie();
    await encryptedCredentialStore(key(1), cookie).save(fakeIssuedToken(clock.now()));
    clock.advance(60 * 60 * 1000);
    const transport = new FakeTransport()
      .handle(getSelf, () => ({ user: undefined }))
      .handle(exchange, () => ({
        token: fakeIssuedToken(clock.now(), { token: 'access-2', refreshToken: 'refresh-2' }),
      }));
    const writes = cookie.writes;
    const store = encryptedCredentialStore(key(1), cookie);
    const session = new Session({
      transport,
      store,
      clock,
      coordinator: new InMemoryExchangeCoordinator({ clock }),
    });

    await session.call(getSelf, {});
    await session.call(getSelf, {});

    expect(cookie.writes).toBe(writes + 1);
    expect((await encryptedCredentialStore(key(1), cookie).load())?.refreshToken).toBe('refresh-2');
  });
});

function sessionWith(held: IssuedToken | undefined, transport = new FakeTransport()) {
  const clock = new FakeClock();
  return new Session({
    transport,
    store: new MemoryCredentialStore(held),
    clock,
    coordinator: new InMemoryExchangeCoordinator({ clock }),
  });
}

class Redirected extends Error {}

const redirect = (): never => {
  throw new Redirected();
};

describe('redirectOnNotSignedIn', () => {
  it('answers what the call answered', async () => {
    const session = sessionWith(fakeIssuedToken(new Date()));

    expect(await redirectOnNotSignedIn(session, () => Promise.resolve('ok'), redirect)).toBe('ok');
  });

  it('redirects when there is no login', async () => {
    const session = sessionWith(undefined);

    await expect(redirectOnNotSignedIn(session, () => session.call(getSelf, {}), redirect)).rejects.toBeInstanceOf(
      Redirected,
    );
  });

  it('redirects when the server refuses the refresh and the session ends', async () => {
    const transport = new FakeTransport()
      .handle(getSelf, () => {
        throw new StatusError(Code.UNAUTHENTICATED, 'expired');
      })
      .handle(exchange, () => {
        throw new StatusError(Code.UNAUTHENTICATED, 'refused');
      });
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()), transport);

    await expect(redirectOnNotSignedIn(session, () => session.call(getSelf, {}), redirect)).rejects.toBeInstanceOf(
      Redirected,
    );
    expect(session.state).toBe('anonymous');
  });

  it('rethrows a server error as it was', async () => {
    const transport = new FakeTransport().handle(getSelf, () => {
      throw new StatusError(Code.INTERNAL, 'boom');
    });
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()), transport);

    await expect(redirectOnNotSignedIn(session, () => session.call(getSelf, {}), redirect)).rejects.toBeInstanceOf(
      PlatformError,
    );
  });

  it('rethrows a refusal that leaves the login standing', async () => {
    const transport = new FakeTransport().handle(getSelf, () => {
      throw new StatusError(Code.PERMISSION_DENIED, 'not yours');
    });
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()), transport);

    await expect(redirectOnNotSignedIn(session, () => session.call(getSelf, {}), redirect)).rejects.toMatchObject({
      code: Code.PERMISSION_DENIED,
    });
    expect(session.state).toBe('authenticated');
  });

  it('rethrows a refusal of an anonymous call', async () => {
    const transport = new FakeTransport().handle(getSelf, () => {
      throw new StatusError(Code.PERMISSION_DENIED, 'no');
    });
    const session = sessionWith(undefined, transport);

    await expect(
      redirectOnNotSignedIn(session, () => session.callAnonymous(getSelf, {}), redirect),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  it('rethrows a NotSignedInError only through onNotSignedIn', async () => {
    const session = sessionWith(undefined);
    let called = false;

    await expect(
      redirectOnNotSignedIn(
        session,
        () => Promise.reject(new NotSignedInError()),
        () => {
          called = true;
          throw new Redirected();
        },
      ),
    ).rejects.toBeInstanceOf(Redirected);
    expect(called).toBe(true);
  });
});

const options = { isPublic: (p: string) => p === '/login' || p.startsWith('/public/'), loginPath: '/login' };

function pageLoad(path: string, init: RequestInit = {}) {
  return new Request(`https://app.example.com${path}`, { headers: { accept: 'text/html' }, ...init });
}

describe('resolveOrRedirect', () => {
  it('resolves a public path with no login', async () => {
    const session = sessionWith(undefined);

    const response = await resolveOrRedirect(
      session,
      pageLoad('/public/a'),
      () => Promise.resolve(new Response('ok')),
      options,
    );

    expect(await response.text()).toBe('ok');
  });

  it('sends a private path with no login to sign in, without resolving it', async () => {
    const session = sessionWith(undefined);
    let resolved = false;

    const response = await resolveOrRedirect(
      session,
      pageLoad('/recipes'),
      () => {
        resolved = true;
        return Promise.resolve(new Response('ok'));
      },
      options,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
    expect(resolved).toBe(false);
  });

  it('resolves a private path with a login', async () => {
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()));

    const response = await resolveOrRedirect(
      session,
      pageLoad('/recipes'),
      () => Promise.resolve(new Response('ok')),
      options,
    );

    expect(await response.text()).toBe('ok');
  });

  it('sends a page load that ended the login to sign in, keeping the cookies it set', async () => {
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()));
    const resolve = async () => {
      await session.clear();
      const headers = new Headers();
      headers.append('set-cookie', 'session=; Max-Age=0');
      headers.append('set-cookie', 'other=1');
      return new Response('signed out', { headers });
    };

    const response = await resolveOrRedirect(session, pageLoad('/recipes'), resolve, options);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.getSetCookie()).toEqual(['session=; Max-Age=0', 'other=1']);
  });

  it.each([
    ['a form post', pageLoad('/recipes', { method: 'POST' })],
    ['a data request', new Request('https://app.example.com/recipes/__data.json')],
  ])('answers %s that ended the login as it chose to', async (_name, request) => {
    const session = sessionWith(fakeIssuedToken(new FakeClock().now()));
    const resolve = async () => {
      await session.clear();
      return new Response('as chosen');
    };

    const response = await resolveOrRedirect(session, request, resolve, options);

    expect(await response.text()).toBe('as chosen');
  });
});
