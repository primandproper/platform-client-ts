import { PlatformError, SignInReason } from './errors';
import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import type { DeadLink } from './passwordreset';
import type { Session } from './session';
import { type CallOptions, Code } from './transport';

// Register has no helper: it is one anonymous call that mints no session, so a sign-up screen calls
// `SignInServiceService.register` through `callAnonymous`, and branches on REGISTRATION_REFUSED and REGISTRATION_CLOSED.
// What follows it, and is anonymous, is here.

export type VerifyEmailResult = { kind: 'verified' } | DeadLink;

/**
 * PasswordAlreadySet is an attach refused because the account already has a password. The remedy is the password
 * reset flow, not this one: attaching exists for somebody who registered without a password.
 */
export interface PasswordAlreadySet {
  kind: 'password_already_set';
  message: string;
}

export type AttachPasswordResult = { kind: 'attached' } | DeadLink | PasswordAlreadySet;

/**
 * verifyEmailAddress answers a mailed verification link: it proves the address and finishes the registration. The
 * link's token is the whole of its authority. Expired, already answered and never issued are one answer, a dead link,
 * and there is no verification token in any response to read one back from: it only ever travels to the person it is
 * about.
 */
export async function verifyEmailAddress(
  session: Session,
  token: string,
  options?: CallOptions,
): Promise<VerifyEmailResult> {
  try {
    await session.callAnonymous(SignInServiceService.verifyEmailAddress, { token }, options);
    return { kind: 'verified' };
  } catch (err) {
    return deadLinkOrThrow(err);
  }
}

/**
 * attachPassword gives a password to somebody who registered without one, answering the link that was mailed to them.
 * It is not a password reset and must not be offered as one: for an account that already holds a password it is
 * refused, which comes back as `password_already_set`.
 */
export async function attachPassword(
  session: Session,
  token: string,
  newPassword: string,
  options?: CallOptions,
): Promise<AttachPasswordResult> {
  try {
    await session.callAnonymous(SignInServiceService.attachPassword, { token, newPassword }, options);
    return { kind: 'attached' };
  } catch (err) {
    if (err instanceof PlatformError && err.is(SignInReason.PASSWORD_ALREADY_SET)) {
      return { kind: 'password_already_set', message: err.serverMessage };
    }
    return deadLinkOrThrow(err);
  }
}

/**
 * requestMagicLink mails a sign-in link to `emailAddress` if somebody holds it. It resolves the same way whether they do
 * or not, and a caller must show the same screen either way: "we sent it" on one and "no such account" on the other
 * rebuilds the enumerator the server's padded timing exists to prevent. The link is answered with `redeemMagicLink`.
 */
export async function requestMagicLink(session: Session, emailAddress: string, options?: CallOptions): Promise<void> {
  await session.callAnonymous(SignInServiceService.requestMagicLink, { emailAddress }, options);
}

function deadLinkOrThrow(err: unknown): DeadLink {
  // A verification token that is expired, spent or wrong answers exactly as a wrong password does.
  if (err instanceof PlatformError && err.code === Code.UNAUTHENTICATED) {
    return { kind: 'dead_link', message: err.serverMessage };
  }
  throw err;
}
