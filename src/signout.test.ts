import { describe, expect, it } from 'vitest';

import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { NotSignedInError, Session } from './session';
import { signOut, signOutEverywhere } from './signout';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore } from './testing';
import { Code, StatusError } from './transport';
import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';

const signOutRpc = SignInServiceService.signOut;
const everywhere = SignInServiceService.signOutEverywhere;
const exchange = SignInServiceService.exchangeRefreshToken;

function setup(held?: (now: Date) => IssuedToken) {
  const clock = new FakeClock();
  const store = new MemoryCredentialStore(held ? held(clock.now()) : undefined);
  const transport = new FakeTransport();
  const session = new Session({ transport, store, clock, metadata: { 'x-tenant': 'acme' } });
  return { clock, store, transport, session };
}

describe('signOut', () => {
  it('sends the refresh token, and clears only after', async () => {
    const { store, transport, session } = setup((now) => fakeIssuedToken(now));
    let storedDuringCall: IssuedToken | undefined;
    transport.handle(signOutRpc, async () => {
      storedDuringCall = await store.load();
      return {};
    });

    await signOut(session);

    expect(transport.callsTo(signOutRpc)[0]?.request).toEqual({ refreshToken: 'refresh-1' });
    expect(transport.callsTo(signOutRpc)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
    expect(transport.callsTo(signOutRpc)[0]?.options.deadline).toBeInstanceOf(Date);
    expect(storedDuringCall?.refreshToken).toBe('refresh-1');
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it('works on a session whose access token lapsed long ago, without refreshing it first', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(signOutRpc, () => ({}));

    clock.advance(12 * 60 * 60 * 1000);
    await signOut(session);

    expect(transport.callsTo(signOutRpc)).toHaveLength(1);
    expect(transport.callsTo(exchange)).toEqual([]);
  });

  it('clears and resolves when the server refuses the token', async () => {
    const { store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(signOutRpc, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    });

    await expect(signOut(session)).resolves.toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });

  it('clears and resolves when the call cannot be delivered', async () => {
    const { store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(signOutRpc, () => {
      throw new Error('socket hang up');
    });

    await expect(signOut(session)).resolves.toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });

  it('makes no call when there is nothing to sign out', async () => {
    const { transport, session } = setup();

    await signOut(session);

    expect(transport.calls).toEqual([]);
  });

  it('makes no call for a session with no refresh token, and still clears it', async () => {
    const { store, transport, session } = setup((now) =>
      fakeIssuedToken(now, { refreshToken: '', refreshTokenExpiresAt: undefined }),
    );

    await signOut(session);

    expect(transport.calls).toEqual([]);
    expect(await store.load()).toBeUndefined();
  });

  it('sends the successor when a refresh was in flight', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({
      token: fakeIssuedToken(clock.now(), { token: 'access-2', refreshToken: 'refresh-2' }),
    }));
    transport.handle(SignInServiceService.getSelf, () => ({ user: undefined }));
    transport.handle(signOutRpc, () => ({}));

    clock.advance(60 * 60 * 1000);
    const calling = session.call(SignInServiceService.getSelf, {});
    await signOut(session);
    await calling;

    expect(transport.callsTo(signOutRpc)[0]?.request).toEqual({ refreshToken: 'refresh-2' });
  });
});

describe('signOutEverywhere', () => {
  it('is an authenticated call, and clears after it', async () => {
    const { store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(everywhere, () => ({}));

    await signOutEverywhere(session);

    expect(transport.callsTo(everywhere)[0]?.options.metadata).toEqual({
      'authorization': 'Bearer access-1',
      'x-tenant': 'acme',
    });
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it('rejects and keeps the session when it fails, so it can be pressed again', async () => {
    const { store, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(everywhere, () => {
      throw new StatusError(Code.UNAVAILABLE, 'unavailable');
    });

    await expect(signOutEverywhere(session)).rejects.toMatchObject({ code: Code.UNAVAILABLE });
    expect((await store.load())?.token).toBe('access-1');
  });

  it('rejects when there is no session', async () => {
    const { session } = setup();

    await expect(signOutEverywhere(session)).rejects.toBeInstanceOf(NotSignedInError);
  });
});
