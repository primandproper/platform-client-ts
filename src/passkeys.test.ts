import { describe, expect, it } from 'vitest';

import { PasskeyReason, passkeyReasonDomain, PlatformError } from './errors';
import { PasskeysServiceService } from './generated/primandproper/platform/passkeys/v1/passkeys';
import { beginPasskeySignIn, passkeySignIn } from './passkeys';
import { Session } from './session';
import { FakeClock, fakeIssuedToken, FakeTransport, MemoryCredentialStore, refusal } from './testing';
import { Code } from './transport';

const beginLogin = PasskeysServiceService.beginLogin;
const finishLogin = PasskeysServiceService.finishLogin;
const assertion = new TextEncoder().encode('{"id":"credential"}');

function setup() {
  const clock = new FakeClock();
  const store = new MemoryCredentialStore();
  const transport = new FakeTransport();
  return { clock, store, transport, session: new Session({ transport, store, clock }) };
}

describe('beginPasskeySignIn', () => {
  it('answers the options for the browser, discoverable when no username is given', async () => {
    const { transport, session } = setup();
    const options = new TextEncoder().encode('{"challenge":"c"}');
    transport.handle(beginLogin, () => ({ options }));

    expect(await beginPasskeySignIn(session)).toEqual(options);
    expect(transport.callsTo(beginLogin)[0]?.request).toEqual({ username: '' });
  });
});

describe('passkeySignIn', () => {
  it('adopts the session a passkey mints, refresh token and all (R18)', async () => {
    const { clock, store, transport, session } = setup();
    transport.handle(finishLogin, () => ({ token: fakeIssuedToken(clock.now()) }));

    const result = await passkeySignIn(session, { username: 'jeff', response: assertion });

    expect(result).toMatchObject({ kind: 'signed_in', token: { token: 'access-1' } });
    expect(transport.callsTo(finishLogin)[0]?.request).toEqual({
      username: 'jeff',
      response: assertion,
      activeAccountId: '',
      totpCode: '',
    });
    expect((await store.load())?.refreshToken).toBe('refresh-1');
    expect(session.state).toBe('authenticated');
  });

  it('asks for a second factor on a key tap alone, with no resend to reuse the spent assertion (R19)', async () => {
    const { session, transport } = setup();
    transport.handle(finishLogin, () => {
      throw refusal(Code.UNAUTHENTICATED, 'a second-factor code is required', 'SECOND_FACTOR_REQUIRED');
    });

    expect(await passkeySignIn(session, { response: assertion })).toEqual({ kind: 'second_factor_required' });
    expect(session.state).toBe('anonymous');
  });

  it('surfaces a cloned-looking key by its passkey reason', async () => {
    const { session, transport } = setup();
    transport.handle(finishLogin, () => {
      throw refusal(
        Code.PERMISSION_DENIED,
        'sign count regressed',
        'PASSKEY_SIGN_COUNT_REGRESSED',
        passkeyReasonDomain,
      );
    });

    const err = await passkeySignIn(session, { response: assertion }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).reason).toMatchObject({ known: true, domain: passkeyReasonDomain });
    expect((err as PlatformError).is(PasskeyReason.PASSKEY_SIGN_COUNT_REGRESSED)).toBe(true);
  });
});
