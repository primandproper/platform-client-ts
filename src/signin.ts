import { PlatformError, SignInReason } from './errors';
import {
  type Credentials,
  type IssuedToken,
  SignInServiceService,
} from './generated/primandproper/platform/signin/v1/signin';
import type { Session, TokenResponse } from './session';
import type { CallOptions, UnaryMethod } from './transport';

/** Handle names who is signing in: a username or an email address, never both and never neither. */
export type Handle = { username: string } | { emailAddress: string };

export interface PasswordSignIn {
  handle: Handle;
  password: string;
  /**
   * totpCode is sent whenever there is one. It is required from a user with a proven second factor and ignored for
   * everybody else, so sending it when the user typed one is always correct.
   */
  totpCode?: string;
  /**
   * activeAccountId is which account the token is for; unset means the user's default. Moving a signed-in user to
   * another account is `Session.switchAccount`, which keeps the login; `SetDefaultAccount` only changes where the next
   * unnamed sign-in lands.
   */
  activeAccountId?: string;
}

export interface MagicLinkSignIn {
  /** token is the one the mailed link carried. */
  token: string;
  totpCode?: string;
  activeAccountId?: string;
}

/**
 * SignInResult is a sign-in that either minted a session or needs a second-factor code first. `resend` repeats the same
 * sign-in with the code, so the caller never asks the user to retype a password.
 *
 * Every other refusal rejects with a PlatformError to branch on by reason or code (R11, R13). Against a server older
 * than v14.1.0 a refusal carries no reason, so a second-factor prompt is indistinguishable from a wrong password and
 * arrives as a plain UNAUTHENTICATED rejection; a sign-in form with an optional code field, sent whenever filled, needs
 * no branch at all.
 */
export type SignInResult =
  | { kind: 'signed_in'; token: IssuedToken }
  | { kind: 'second_factor_required'; resend(totpCode: string): Promise<SignInResult> };

/** signIn signs in with a password through `LoginForToken`. */
export function signIn(session: Session, request: PasswordSignIn, options?: CallOptions): Promise<SignInResult> {
  return passwordDoor(session, SignInServiceService.loginForToken, request, options);
}

/** adminSignIn signs in through the administrative door, `AdminLoginForToken`. */
export function adminSignIn(session: Session, request: PasswordSignIn, options?: CallOptions): Promise<SignInResult> {
  return passwordDoor(session, SignInServiceService.adminLoginForToken, request, options);
}

/** redeemMagicLink signs in with the token a mailed link carried. */
export function redeemMagicLink(
  session: Session,
  request: MagicLinkSignIn,
  options?: CallOptions,
): Promise<SignInResult> {
  return attempt(
    session,
    SignInServiceService.redeemMagicLink,
    {
      token: request.token,
      totpCode: request.totpCode ?? '',
      activeAccountId: request.activeAccountId ?? '',
    },
    (totpCode) => redeemMagicLink(session, { ...request, totpCode }, options),
    options,
  );
}

function passwordDoor(
  session: Session,
  door: UnaryMethod<{ credentials: Credentials | undefined }, TokenResponse>,
  request: PasswordSignIn,
  options?: CallOptions,
): Promise<SignInResult> {
  const credentials: Credentials = {
    username: 'username' in request.handle ? request.handle.username : '',
    emailAddress: 'emailAddress' in request.handle ? request.handle.emailAddress : '',
    password: request.password,
    totpCode: request.totpCode ?? '',
    activeAccountId: request.activeAccountId ?? '',
  };
  return attempt(
    session,
    door,
    { credentials },
    (totpCode) => passwordDoor(session, door, { ...request, totpCode }, options),
    options,
  );
}

async function attempt<Req>(
  session: Session,
  door: UnaryMethod<Req, TokenResponse>,
  request: Req,
  resend: (totpCode: string) => Promise<SignInResult>,
  options?: CallOptions,
): Promise<SignInResult> {
  try {
    return { kind: 'signed_in', token: await session.signIn(door, request, options) };
  } catch (err) {
    if (err instanceof PlatformError && err.is(SignInReason.SECOND_FACTOR_REQUIRED)) {
      return { kind: 'second_factor_required', resend };
    }
    throw err;
  }
}
