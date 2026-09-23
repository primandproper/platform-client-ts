import { PlatformError } from './errors';
import { PasswordResetServiceService } from './generated/primandproper/platform/passwordreset/v1/passwordreset';
import type { Session } from './session';
import { type CallOptions, Code } from './transport';

/**
 * DeadLink is a reset link that cannot be spent: expired, already used, or never a link. The three are told apart only
 * by `message`, which is written to be shown, and they share one remedy, so there is nothing to branch on: show the
 * message and offer to send a new link.
 */
export interface DeadLink {
  kind: 'dead_link';
  message: string;
}

export type VerifyResult = { kind: 'live'; expiresAt: Date | undefined } | DeadLink;

export type CompleteResult = { kind: 'reset' } | DeadLink;

/**
 * requestPasswordReset mails a reset link to `emailAddress` if somebody holds it. It resolves the same way whether
 * they do or not, and a caller must show the same screen either way (R15): "check your inbox" on one and "no account
 * with that address" on the other rebuilds the account enumerator the server's silence and timing floor exist to
 * prevent.
 */
export async function requestPasswordReset(
  session: Session,
  emailAddress: string,
  options?: CallOptions,
): Promise<void> {
  await session.callAnonymous(PasswordResetServiceService.requestPasswordReset, { emailAddress }, options);
}

/**
 * verifyPasswordResetToken is the page load behind a reset link, made before rendering the form so that somebody who
 * followed a dead link is told now rather than after choosing a password (R16). It holds nothing open: the answer that
 * decides anything is `completePasswordReset`'s. It says when the link expires and nothing else, deliberately not whose
 * it is, so there is no address to prefill.
 */
export async function verifyPasswordResetToken(
  session: Session,
  token: string,
  options?: CallOptions,
): Promise<VerifyResult> {
  try {
    const response = await session.callAnonymous(
      PasswordResetServiceService.verifyPasswordResetToken,
      { token },
      options,
    );
    return { kind: 'live', expiresAt: response.expiresAt };
  } catch (err) {
    return deadLinkOrThrow(err);
  }
}

/**
 * completePasswordReset spends the link and sets the new password. It signs nobody in and does not end the account's
 * other sessions: the next call is a sign-in with the password just chosen. Somebody resetting because they think
 * another person is in their account should sign in and then `signOutEverywhere`, which is the one sequence that ends
 * the other sessions.
 *
 * Password policy is the consumer's, applied before this call; the service refuses only an empty password, and does so
 * without spending the link.
 */
export async function completePasswordReset(
  session: Session,
  token: string,
  newPassword: string,
  options?: CallOptions,
): Promise<CompleteResult> {
  try {
    await session.callAnonymous(PasswordResetServiceService.completePasswordReset, { token, newPassword }, options);
    return { kind: 'reset' };
  } catch (err) {
    return deadLinkOrThrow(err);
  }
}

function deadLinkOrThrow(err: unknown): DeadLink {
  if (err instanceof PlatformError && err.code === Code.FAILED_PRECONDITION) {
    return { kind: 'dead_link', message: err.serverMessage };
  }
  throw err;
}
