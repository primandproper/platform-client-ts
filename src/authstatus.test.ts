import { describe, expect, it } from 'vitest';

import { getAuthStatus } from './authstatus';
import {
  type AuthStatus,
  type IssuedToken,
  SignInServiceService,
} from './generated/primandproper/platform/signin/v1/signin';
import { Session } from './session';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore } from './testing';

const rpc = SignInServiceService.getAuthStatus;
const exchange = SignInServiceService.exchangeRefreshToken;

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    user: undefined,
    activeAccountId: 'account-1',
    accountIds: ['account-1', 'account-2'],
    hasPassword: true,
    twoFactorEnrolled: false,
    requiresPasswordChange: false,
    emailAddressVerified: true,
    ...overrides,
  };
}

function setup(held?: (now: Date) => IssuedToken, answer: AuthStatus = status()) {
  const clock = new FakeClock();
  const store = new MemoryCredentialStore(held ? held(clock.now()) : undefined);
  const transport = new FakeTransport().handle(rpc, (_req, options) =>
    options.metadata?.['authorization']
      ? { authenticated: true, status: answer }
      : { authenticated: false, status: undefined },
  );
  const session = new Session({ transport, store, clock, metadata: { 'x-tenant': 'acme' } });
  return { clock, transport, session };
}

describe('getAuthStatus', () => {
  it('asks anonymously when no session is held, and is answered no', async () => {
    const { transport, session } = setup();

    expect(await getAuthStatus(session)).toEqual({ authenticated: false });
    expect(transport.callsTo(rpc)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('carries the credential when a session is held', async () => {
    const { transport, session } = setup((now) => fakeIssuedToken(now));

    const result = await getAuthStatus(session);

    expect(result).toEqual({ authenticated: true, status: status(), requiredActions: [], canChangePassword: true });
    expect(transport.callsTo(rpc)[0]?.options.metadata?.['authorization']).toBe('Bearer access-1');
  });

  it('refreshes a held session inside the skew before asking', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));
    transport.handle(exchange, () => ({ token: fakeIssuedToken(clock.now(), { token: 'access-2' }) }));

    clock.advance(60 * 60 * 1000);
    await getAuthStatus(session);

    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect(transport.callsTo(rpc)[0]?.options.metadata?.['authorization']).toBe('Bearer access-2');
  });

  it('asks anonymously when the held session turns out to have ended', async () => {
    const { clock, transport, session } = setup((now) => fakeIssuedToken(now));

    clock.advance(24 * 60 * 60 * 1000);
    const result = await getAuthStatus(session);

    expect(result).toEqual({ authenticated: false });
    expect(transport.callsTo(rpc)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
    expect(session.state).toBe('anonymous');
  });

  it.each([
    ['nothing', {}, []],
    ['a forced password change', { requiresPasswordChange: true }, ['change_password']],
    ['an unverified address', { emailAddressVerified: false }, ['verify_email']],
    [
      'both, password first',
      { requiresPasswordChange: true, emailAddressVerified: false },
      ['change_password', 'verify_email'],
    ],
  ])('routes on %s', async (_name, overrides, expected) => {
    const { session } = setup((now) => fakeIssuedToken(now), status(overrides));

    const result = await getAuthStatus(session);

    expect(result.authenticated && result.requiredActions).toEqual(expected);
  });

  it('does not offer a password change to somebody who has no password', async () => {
    const { session } = setup((now) => fakeIssuedToken(now), status({ hasPassword: false }));

    const result = await getAuthStatus(session);

    expect(result.authenticated && result.canChangePassword).toBe(false);
  });

  it('asks the server every time rather than caching the answer', async () => {
    const { transport, session } = setup((now) => fakeIssuedToken(now));

    await getAuthStatus(session);
    await getAuthStatus(session);

    expect(transport.callsTo(rpc)).toHaveLength(2);
  });
});
