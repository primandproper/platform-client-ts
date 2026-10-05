import { PlatformError, SignInReason } from './errors';
import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import { type Passkey, PasskeysServiceService } from './generated/primandproper/platform/passkeys/v1/passkeys';
import type { Session } from './session';
import type { CallOptions } from './transport';

export interface PasskeySignIn {
  /** username is the one `beginPasskeySignIn` was sent, empty for a discoverable login. */
  username?: string;
  /** response is the JSON of the credential `navigator.credentials.get` resolved with: `serializeAssertion`. */
  response: Uint8Array;
  /** totpCode is sent whenever there is one, as for a password sign-in. */
  totpCode?: string;
  /** activeAccountId is which account the token is for; unset means the user's default. */
  activeAccountId?: string;
}

/**
 * PasskeySignInResult is a passkey sign-in that either minted a session or needs a second-factor code first (R19). There
 * is no `resend`, unlike a password sign-in: the assertion's challenge is spent, so the code goes with a fresh one, from
 * `beginPasskeySignIn` and the key again.
 */
export type PasskeySignInResult = { kind: 'signed_in'; token: IssuedToken } | { kind: 'second_factor_required' };

/**
 * beginPasskeySignIn starts a passkey sign-in, answering the options to hand `navigator.credentials.get` (as the JSON
 * `parseAssertionOptions` reads). An empty `username` is the discoverable login. It answers the same
 * for a username nobody holds as for one somebody does, so show the same prompt either way.
 */
export async function beginPasskeySignIn(session: Session, username = '', options?: CallOptions): Promise<Uint8Array> {
  const response = await session.callAnonymous(PasskeysServiceService.beginLogin, { username }, options);
  return response.options;
}

/**
 * passkeySignIn finishes a passkey sign-in and adopts the session it mints. That session is the one a password sign-in
 * mints, refresh token and all (R18), so it is held, refreshed and signed out of exactly as that one is.
 *
 * A key tapped with no user verification is one factor (R19): a person holding a proven second factor is answered
 * `second_factor_required`. Every other refusal rejects with a PlatformError, `PASSKEY_LOGIN_FAILED` for any login that
 * proved nobody and `PASSKEY_SIGN_COUNT_REGRESSED` for a key that looks cloned, which is the end of it rather than a
 * reason to try again.
 */
export async function passkeySignIn(
  session: Session,
  request: PasskeySignIn,
  options?: CallOptions,
): Promise<PasskeySignInResult> {
  try {
    const token = await session.signIn(
      PasskeysServiceService.finishLogin,
      {
        username: request.username ?? '',
        response: request.response,
        activeAccountId: request.activeAccountId ?? '',
        totpCode: request.totpCode ?? '',
      },
      options,
    );
    return { kind: 'signed_in', token };
  } catch (err) {
    if (err instanceof PlatformError && err.is(SignInReason.SECOND_FACTOR_REQUIRED)) {
      return { kind: 'second_factor_required' };
    }
    throw err;
  }
}

export interface PasskeyRegistration {
  /** friendlyName is what the person calls this authenticator, as a settings page lists it. */
  friendlyName: string;
  /** response is the JSON of the credential `navigator.credentials.create` resolved with: `serializeRegistration`. */
  response: Uint8Array;
}

/**
 * beginPasskeyRegistration starts enrolling a passkey on the signed-in user's account, answering the options to hand
 * `navigator.credentials.create` (as the JSON `parseRegistrationOptions` reads). They exclude the user's existing
 * passkeys, so an authenticator already holding one declines to register a second.
 */
export async function beginPasskeyRegistration(session: Session, options?: CallOptions): Promise<Uint8Array> {
  const response = await session.call(PasskeysServiceService.beginRegistration, {}, options);
  return response.options;
}

/**
 * finishPasskeyRegistration enrolls the passkey the browser created, answering it as the account now lists it. It mints
 * no session: the user is already signed in, and stays signed in as they were.
 */
export async function finishPasskeyRegistration(
  session: Session,
  attestation: PasskeyRegistration,
  options?: CallOptions,
): Promise<Passkey> {
  const response = await session.call(
    PasskeysServiceService.finishRegistration,
    { friendlyName: attestation.friendlyName, response: attestation.response },
    options,
  );
  if (!response.passkey) {
    throw new Error(`${PasskeysServiceService.finishRegistration.path} answered OK with no passkey`);
  }
  return response.passkey;
}
