import { ErrorInfo } from './generated/google/rpc/error_details';
import { Status } from './generated/google/rpc/status';
import { Code, StatusError } from './transport';

export const signInReasonDomain = 'signin.platform-go.primandproper.github.com';

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
  USER_UNVERIFIED: 'USER_UNVERIFIED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_TERMINATED: 'USER_TERMINATED',
  NOT_AN_ADMINISTRATOR: 'NOT_AN_ADMINISTRATOR',
  ADMIN_SIGNIN_UNAVAILABLE: 'ADMIN_SIGNIN_UNAVAILABLE',
  NO_PASSWORD_CREDENTIAL: 'NO_PASSWORD_CREDENTIAL',
  PASSWORD_ALREADY_SET: 'PASSWORD_ALREADY_SET',
  NO_CREDENTIAL_NAMED: 'NO_CREDENTIAL_NAMED',
} as const;

export type SignInReason = (typeof SignInReason)[keyof typeof SignInReason];

const signInReasons: ReadonlySet<string> = new Set(Object.values(SignInReason));

/**
 * Reason is the structured refusal a status carried. `known` is false for a reason this client has no name for, which
 * a newer server may send: it is still readable, and it does not throw.
 */
export type Reason =
  | { known: true; domain: typeof signInReasonDomain; reason: SignInReason; metadata: Record<string, string> }
  | { known: false; domain: string; reason: string; metadata: Record<string, string> };

const codeNames: Record<Code, string> = Object.fromEntries(
  Object.entries(Code).map(([name, value]) => [value, name]),
) as Record<Code, string>;

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

  /** is reports whether this refusal carries the named sign-in reason. */
  is(reason: SignInReason): boolean {
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

const ambiguousCodes: ReadonlySet<Code> = new Set([
  Code.DEADLINE_EXCEEDED,
  Code.UNAVAILABLE,
  Code.CANCELLED,
  Code.INTERNAL,
  Code.UNKNOWN,
]);

/**
 * isAmbiguous reports whether a failed call may have committed before it failed: R10's table. A failure with no status
 * at all is ambiguous, since nothing says the request did not arrive.
 */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof PlatformError || err instanceof StatusError) {
    return ambiguousCodes.has(err.code);
  }
  return true;
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
    if (info.domain === signInReasonDomain && signInReasons.has(info.reason)) {
      return { known: true, domain: signInReasonDomain, reason: info.reason as SignInReason, metadata: info.metadata };
    }
    return { known: false, domain: info.domain, reason: info.reason, metadata: info.metadata };
  }
  return undefined;
}

function describe(code: Code, serverMessage: string, reason: Reason | undefined): string {
  const name = codeNames[code] ?? `code ${code}`;
  const suffix = reason ? ` [${reason.domain}/${reason.reason}]` : '';
  if (code === Code.UNKNOWN) {
    return (
      `UNKNOWN: ${serverMessage}${suffix} (the server mapped this refusal to no code; ` +
      'a deployment that has not called errormappers.Register answers its own refusals this way)'
    );
  }
  return `${name}: ${serverMessage}${suffix}`;
}
