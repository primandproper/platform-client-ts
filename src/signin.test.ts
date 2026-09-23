import { describe, expect, it } from 'vitest';

import { PlatformError, SignInReason } from './errors';
import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { Session } from './session';
import { adminSignIn, redeemMagicLink, signIn } from './signin';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore, refusal } from './testing';
import { Code, StatusError } from './transport';

const login = SignInServiceService.loginForToken;
const adminLogin = SignInServiceService.adminLoginForToken;
const magicLink = SignInServiceService.redeemMagicLink;

function setup() {
  const clock = new FakeClock();
  const store = new MemoryCredentialStore();
  const transport = new FakeTransport();
  const session = new Session({ transport, store, clock });
  return { clock, store, transport, session };
}

describe('signIn', () => {
  it('signs in with a username and adopts the session', async () => {
    const { clock, store, transport, session } = setup();
    transport.handle(login, () => ({ token: fakeIssuedToken(clock.now()) }));

    const result = await signIn(session, { handle: { username: 'jeff' }, password: 'hunter2' });

    expect(result).toMatchObject({ kind: 'signed_in', token: { token: 'access-1' } });
    expect(transport.callsTo(login)[0]?.request).toEqual({
      credentials: { username: 'jeff', emailAddress: '', password: 'hunter2', totpCode: '', activeAccountId: '' },
    });
    expect((await store.load())?.token).toBe('access-1');
    expect(session.state).toBe('authenticated');
  });

  it('sends an email handle, a code and an account when it has them', async () => {
    const { clock, transport, session } = setup();
    transport.handle(login, () => ({ token: fakeIssuedToken(clock.now()) }));

    await signIn(session, {
      handle: { emailAddress: 'j@example.com' },
      password: 'hunter2',
      totpCode: '123456',
      activeAccountId: 'account-2',
    });

    expect(transport.callsTo(login)[0]?.request).toEqual({
      credentials: {
        username: '',
        emailAddress: 'j@example.com',
        password: 'hunter2',
        totpCode: '123456',
        activeAccountId: 'account-2',
      },
    });
  });

  it('asks for a second factor and resends the same credentials with it', async () => {
    const { clock, transport, session } = setup();
    transport.handle(login, (req) => {
      if (!req.credentials?.totpCode) {
        throw refusal(Code.UNAUTHENTICATED, 'a second-factor code is required', 'SECOND_FACTOR_REQUIRED');
      }
      return { token: fakeIssuedToken(clock.now()) };
    });

    const first = await signIn(session, { handle: { username: 'jeff' }, password: 'hunter2', activeAccountId: 'a' });
    expect(first.kind).toBe('second_factor_required');
    expect(session.state).toBe('anonymous');

    const second = first.kind === 'second_factor_required' ? await first.resend('654321') : first;

    expect(second.kind).toBe('signed_in');
    expect(transport.callsTo(login)[1]?.request).toEqual({
      credentials: {
        username: 'jeff',
        emailAddress: '',
        password: 'hunter2',
        totpCode: '654321',
        activeAccountId: 'a',
      },
    });
    expect(session.state).toBe('authenticated');
  });

  it('asks again when the resent code is refused for the same reason', async () => {
    const { transport, session } = setup();
    transport.handle(login, () => {
      throw refusal(Code.UNAUTHENTICATED, 'a second-factor code is required', 'SECOND_FACTOR_REQUIRED');
    });

    const first = await signIn(session, { handle: { username: 'jeff' }, password: 'hunter2' });
    const second = first.kind === 'second_factor_required' ? await first.resend('000000') : first;

    expect(second.kind).toBe('second_factor_required');
  });

  it('rejects any other refusal with its reason to branch on', async () => {
    const { transport, session } = setup();
    transport.handle(login, () => {
      throw refusal(Code.PERMISSION_DENIED, 'your account is suspended until Friday', 'USER_SUSPENDED');
    });

    const err = await signIn(session, { handle: { username: 'jeff' }, password: 'x' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).is(SignInReason.USER_SUSPENDED)).toBe(true);
    expect((err as PlatformError).serverMessage).toBe('your account is suspended until Friday');
    expect(session.state).toBe('anonymous');
  });

  it('rejects an unreasoned UNAUTHENTICATED from an older server rather than guessing a second factor', async () => {
    const { transport, session } = setup();
    transport.handle(login, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'a second-factor code is required');
    });

    const err = await signIn(session, { handle: { username: 'jeff' }, password: 'x' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).code).toBe(Code.UNAUTHENTICATED);
    expect((err as PlatformError).reason).toBeUndefined();
  });
});

describe('adminSignIn', () => {
  it('goes through the administrative door', async () => {
    const { clock, transport, session } = setup();
    transport.handle(adminLogin, () => ({ token: fakeIssuedToken(clock.now(), { administrative: true }) }));

    const result = await adminSignIn(session, { handle: { username: 'root' }, password: 'x' });

    expect(result).toMatchObject({ kind: 'signed_in', token: { administrative: true } });
    expect(transport.callsTo(login)).toEqual([]);
  });

  it('asks for a second factor through the same door', async () => {
    const { clock, transport, session } = setup();
    transport.handle(adminLogin, (req) => {
      if (!req.credentials?.totpCode) {
        throw refusal(Code.UNAUTHENTICATED, 'code', 'SECOND_FACTOR_REQUIRED');
      }
      return { token: fakeIssuedToken(clock.now()) };
    });

    const first = await adminSignIn(session, { handle: { username: 'root' }, password: 'x' });
    const second = first.kind === 'second_factor_required' ? await first.resend('1') : first;

    expect(second.kind).toBe('signed_in');
    expect(transport.callsTo(adminLogin)).toHaveLength(2);
  });
});

describe('redeemMagicLink', () => {
  it('signs in with the link token', async () => {
    const { clock, transport, session } = setup();
    transport.handle(magicLink, () => ({ token: fakeIssuedToken(clock.now()) }));

    const result = await redeemMagicLink(session, { token: 'link' });

    expect(result.kind).toBe('signed_in');
    expect(transport.callsTo(magicLink)[0]?.request).toEqual({ token: 'link', totpCode: '', activeAccountId: '' });
  });

  it('resends the same link token with a second factor', async () => {
    const { clock, transport, session } = setup();
    transport.handle(magicLink, (req) => {
      if (!req.totpCode) {
        throw refusal(Code.UNAUTHENTICATED, 'code', 'SECOND_FACTOR_REQUIRED');
      }
      return { token: fakeIssuedToken(clock.now()) };
    });

    const first = await redeemMagicLink(session, { token: 'link', activeAccountId: 'a' });
    const second = first.kind === 'second_factor_required' ? await first.resend('42') : first;

    expect(second.kind).toBe('signed_in');
    expect(transport.callsTo(magicLink)[1]?.request).toEqual({ token: 'link', totpCode: '42', activeAccountId: 'a' });
  });
});
