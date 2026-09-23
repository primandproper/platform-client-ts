import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import type { Session } from './session';

/**
 * signOutDeadline bounds the one SignOut attempt. It is short because nothing waits on the answer: the local session is
 * cleared either way.
 */
const signOutDeadlineMs = 5_000;

/**
 * signOut ends this login on the server and then here, in that order: the refresh token is the only thing that can end
 * the login, and clearing first would throw it away (R17). `SignOut` needs no caller, so it works on a session whose
 * access token lapsed a week ago, which is exactly when somebody presses the button.
 *
 * It never rejects. Every refusal a presented token can draw means the login is already over, and a SignOut that could
 * not be delivered cannot be made more true by telling the user. What neither stops is an access token already issued,
 * which lapses within one access-token lifetime.
 */
export async function signOut(session: Session): Promise<void> {
  const held = await session.held().catch(() => undefined);
  try {
    if (held?.refreshToken) {
      await session.callAnonymous(
        SignInServiceService.signOut,
        { refreshToken: held.refreshToken },
        { deadline: new Date(Date.now() + signOutDeadlineMs) },
      );
    }
  } catch {
    // Unknown, spent, revoked and expired all answer success on the server; anything else here is a failure to deliver
    // it, and the local session is cleared regardless.
  } finally {
    await session.clear().catch(() => undefined);
  }
}

/**
 * signOutEverywhere ends every login this person holds on every device, this one included, and then clears the session
 * here. It is the door for a password its owner thinks somebody else has seen, so unlike `signOut` a failure rejects
 * and leaves the session in place: reporting "signed out everywhere" when it was not would be the lie R17 is about, and
 * keeping the session lets the user press it again.
 */
export async function signOutEverywhere(session: Session): Promise<void> {
  await session.call(SignInServiceService.signOutEverywhere, {});
  await session.clear();
}
