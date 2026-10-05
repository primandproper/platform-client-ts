import { ErrorInfo } from './generated/google/rpc/error_details';
import { Status } from './generated/google/rpc/status';
import { Code, StatusError } from './transport';

export const signInReasonDomain = 'signin.platform-go.primandproper.github.com';

export const passkeyReasonDomain = 'passkeys.platform-go.primandproper.github.com';

export const passwordResetReasonDomain = 'passwordreset.platform-go.primandproper.github.com';

const errorInfoTypeUrl = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * SignInReason is R11's table: every sign-in refusal a client may be told about, by its stable identifier. A refusal
 * absent from it carries no reason at all, which is how R7 survives: a reused, expired or revoked refresh token answers
 * INVALID_CREDENTIALS exactly as a wrong password does.
 */
export const SignInReason = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SECOND_FACTOR_REQUIRED: 'SECOND_FACTOR_REQUIRED',
  SECOND_FACTOR_NOT_ENROLLED: 'SECOND_FACTOR_NOT_ENROLLED',
  MULTI_FACTOR_REQUIRED: 'MULTI_FACTOR_REQUIRED',
  USER_UNVERIFIED: 'USER_UNVERIFIED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_TERMINATED: 'USER_TERMINATED',
  NOT_AN_ADMINISTRATOR: 'NOT_AN_ADMINISTRATOR',
  ADMIN_SIGNIN_UNAVAILABLE: 'ADMIN_SIGNIN_UNAVAILABLE',
  IMPERSONATION_UNAVAILABLE: 'IMPERSONATION_UNAVAILABLE',
  NO_PASSWORD_CREDENTIAL: 'NO_PASSWORD_CREDENTIAL',
  PASSWORD_ALREADY_SET: 'PASSWORD_ALREADY_SET',
  EMAIL_ADDRESS_ALREADY_VERIFIED: 'EMAIL_ADDRESS_ALREADY_VERIFIED',
  NO_CREDENTIAL_NAMED: 'NO_CREDENTIAL_NAMED',
  PASSWORD_REFUSED: 'PASSWORD_REFUSED',
  REGISTRATION_REFUSED: 'REGISTRATION_REFUSED',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  SIGN_IN_NOT_IDENTIFIED: 'SIGN_IN_NOT_IDENTIFIED',
  REAUTHENTICATION_REQUIRED: 'REAUTHENTICATION_REQUIRED',
} as const;

export type SignInReason = (typeof SignInReason)[keyof typeof SignInReason];

/**
 * PasskeyReason is the passkey service's table, in a domain of its own: the refusals a person in front of a passkey
 * prompt or a settings page acts on. Its names are disjoint from every other table's.
 */
export const PasskeyReason = {
  PASSKEY_LOGIN_FAILED: 'PASSKEY_LOGIN_FAILED',
  PASSKEY_SIGN_COUNT_REGRESSED: 'PASSKEY_SIGN_COUNT_REGRESSED',
  PASSKEY_NOT_FOUND: 'PASSKEY_NOT_FOUND',
  PASSKEY_ALREADY_REGISTERED: 'PASSKEY_ALREADY_REGISTERED',
  LAST_PASSKEY: 'LAST_PASSKEY',
} as const;

export type PasskeyReason = (typeof PasskeyReason)[keyof typeof PasskeyReason];

/**
 * PasswordResetReason is the reset service's table, in a domain of its own. The three about the link all answer
 * FAILED_PRECONDITION, and `completePasswordReset` and `verifyPasswordResetToken` already read them as a dead link; the
 * one a caller branches on is REPLACEMENT_PASSWORD_REFUSED, which leaves the link live and asks for another password.
 */
export const PasswordResetReason = {
  RESET_TOKEN_NOT_FOUND: 'RESET_TOKEN_NOT_FOUND',
  RESET_TOKEN_EXPIRED: 'RESET_TOKEN_EXPIRED',
  RESET_TOKEN_REDEEMED: 'RESET_TOKEN_REDEEMED',
  REPLACEMENT_PASSWORD_REFUSED: 'REPLACEMENT_PASSWORD_REFUSED',
} as const;

export type PasswordResetReason = (typeof PasswordResetReason)[keyof typeof PasswordResetReason];

const knownReasons = new Map<string, ReadonlySet<string>>([
  [signInReasonDomain, new Set<string>(Object.values(SignInReason))],
  [passkeyReasonDomain, new Set<string>(Object.values(PasskeyReason))],
  [passwordResetReasonDomain, new Set<string>(Object.values(PasswordResetReason))],
]);

/**
 * Reason is the structured refusal a status carried. `known` is false for a reason this client has no name for, which
 * a newer server may send: it is still readable, and it does not throw.
 */
export type Reason =
  | { known: true; domain: typeof signInReasonDomain; reason: SignInReason; metadata: Record<string, string> }
  | { known: true; domain: typeof passkeyReasonDomain; reason: PasskeyReason; metadata: Record<string, string> }
  | {
      known: true;
      domain: typeof passwordResetReasonDomain;
      reason: PasswordResetReason;
      metadata: Record<string, string>;
    }
  | { known: false; domain: string; reason: string; metadata: Record<string, string> };

// Partial because a server can send a code outside the set this client knows.
const codeNames: Partial<Record<Code, string>> = Object.fromEntries(
  Object.entries(Code).map(([name, value]) => [value, name]),
);

/**
 * PlatformError is a refusal a caller can branch on: the code always, and the reason where there is one (R13). Branch on
 * the reason, never on `serverMessage` (R11). `serverMessage` is the server's text as sent and is what to show a user;
 * `message` is written for a log.
 */
export class PlatformError extends Error {
  readonly code: Code;
  readonly serverMessage: string;
  readonly reason: Reason | undefined;

  constructor(code: Code, serverMessage: string, reason?: Reason) {
    super(describe(code, serverMessage, reason));
    this.name = 'PlatformError';
    this.code = code;
    this.serverMessage = serverMessage;
    this.reason = reason;
  }

  /** fromStatus reads a StatusError's details. A detail that does not decode is dropped, as the server drops one that does not marshal. */
  static fromStatus(err: StatusError): PlatformError {
    return new PlatformError(err.code, err.message, err.statusDetails ? readReason(err.statusDetails) : undefined);
  }

  /** is reports whether this refusal carries the named reason, from any of the tables above. */
  is(reason: SignInReason | PasskeyReason | PasswordResetReason): boolean {
    return this.reason?.known === true && this.reason.reason === reason;
  }
}

/**
 * toPlatformError converts what a Transport rejected with. A StatusError becomes a PlatformError; anything else was a
 * transport failure that carried no status, and is returned as it was.
 */
export function toPlatformError(err: unknown): unknown {
  return err instanceof StatusError ? PlatformError.fromStatus(err) : err;
}

/** NotSignedInError is what an authenticated call rejects with when there is no session to make it with. */
export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotSignedInError';
  }
}

/**
 * ExchangeNotSentError is an exchange that failed before the refresh token left this caller: a coordinator that could
 * not reach its store, say. It is not ambiguous, since the server never saw the token, so the session keeps it and tries
 * again on the next call. `cause` is what failed.
 */
export class ExchangeNotSentError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'ExchangeNotSentError';
  }
}

const ambiguousCodes: ReadonlySet<Code> = new Set([
  Code.DEADLINE_EXCEEDED,
  Code.UNAVAILABLE,
  Code.CANCELLED,
  Code.INTERNAL,
  Code.UNKNOWN,
]);

/**
 * isAmbiguous reports whether a failed call may have committed before it failed: R10's table. A failure with no status
 * at all is ambiguous, since nothing says the request did not arrive, unless it is an ExchangeNotSentError, which does.
 */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof PlatformError || err instanceof StatusError) {
    return ambiguousCodes.has(err.code);
  }
  return !(err instanceof ExchangeNotSentError);
}

const transientCodes: ReadonlySet<Code> = new Set([Code.UNAVAILABLE, Code.DEADLINE_EXCEEDED, Code.RESOURCE_EXHAUSTED]);

/**
 * isTransient reports whether a failure is the server being unreachable or overloaded, so the same call may succeed
 * later: what "try again later" and a circuit breaker consult. A failure with no status at all (connection refused, DNS)
 * is transient, unless it is a NotSignedInError, which never reached a server and is a reason to sign in. CANCELLED is
 * not, since the caller cancelled it. INTERNAL and UNKNOWN are not either: they are the server's fault but not its
 * absence, and a breaker that trips on them hides a bug behind a "try later".
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof PlatformError || err instanceof StatusError) {
    return transientCodes.has(err.code);
  }
  return !(err instanceof NotSignedInError);
}

function readReason(bytes: Uint8Array): Reason | undefined {
  let status: Status;
  try {
    status = Status.decode(bytes);
  } catch {
    return undefined;
  }
  for (const detail of status.details) {
    if (detail.typeUrl !== errorInfoTypeUrl) {
      continue;
    }
    let info: ErrorInfo;
    try {
      info = ErrorInfo.decode(detail.value);
    } catch {
      continue;
    }
    if (knownReasons.get(info.domain)?.has(info.reason)) {
      return { known: true, domain: info.domain, reason: info.reason, metadata: info.metadata } as Reason;
    }
    return { known: false, domain: info.domain, reason: info.reason, metadata: info.metadata };
  }
  return undefined;
}

function describe(code: Code, serverMessage: string, reason: Reason | undefined): string {
  const name = codeNames[code] ?? `code ${String(code)}`;
  const suffix = reason ? ` [${reason.domain}/${reason.reason}]` : '';
  if (code === Code.UNKNOWN) {
    return (
      `UNKNOWN: ${serverMessage}${suffix} (the server mapped this refusal to no code; ` +
      'a deployment that has not called errormappers.Register answers its own refusals this way)'
    );
  }
  return `${name}: ${serverMessage}${suffix}`;
}
