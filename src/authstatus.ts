import { type AuthStatus, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import type { Session } from './session';
import type { CallOptions } from './transport';

/**
 * RequiredAction is something the signed-in user has to be sent to do. The service signs such users in anyway, since
 * the alternative is a user who cannot reach the form, so routing them there is the client's job.
 *
 * - `change_password`: an operator forced a password change.
 * - `verify_email`: the address is unproven, so the registration is unfinished; the remedy is the mailed link.
 */
export type RequiredAction = 'change_password' | 'verify_email';

export type AuthStatusResult =
  | { authenticated: false }
  | {
      authenticated: true;
      status: AuthStatus;
      /** requiredActions is what the user must be routed to before anything else, in that order. Empty for most. */
      requiredActions: RequiredAction[];
      /**
       * canChangePassword is false for a passwordless user (a passkey, or federated). A change-password form offered
       * to them cannot work.
       */
      canChangePassword: boolean;
    };

/**
 * getAuthStatus asks whether this session is signed in, and if so who it is and what it owes. It is the one RPC that
 * answers an anonymous caller instead of refusing one, so it is safe to call before knowing whether the credentials
 * are good, and it carries the credential whenever one is held.
 *
 * It is read fresh every time and deliberately not cached: the token carries no user and no permissions so that a
 * revoked role takes effect now rather than at the token's expiry, and caching this answer indefinitely would rebuild
 * the frozen permission set that design avoids.
 *
 * `twoFactorEnrolled` is readable only here, by a signed-in caller, which is why a sign-in refused for a second factor
 * cannot be resolved from this.
 */
export async function getAuthStatus(session: Session, options?: CallOptions): Promise<AuthStatusResult> {
  const response = await session.callOptionallyAuthenticated(SignInServiceService.getAuthStatus, {}, options);
  if (!response.authenticated || !response.status) {
    return { authenticated: false };
  }
  const status = response.status;
  const requiredActions: RequiredAction[] = [];
  if (status.requiresPasswordChange) {
    requiredActions.push('change_password');
  }
  if (!status.emailAddressVerified) {
    requiredActions.push('verify_email');
  }
  return { authenticated: true, status, requiredActions, canChangePassword: status.hasPassword };
}
