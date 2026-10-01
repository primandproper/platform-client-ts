import { describe, expect, it } from 'vitest';

import {
  isAmbiguous,
  PasskeyReason,
  PasswordResetReason,
  passwordResetReasonDomain,
  PlatformError,
  SignInReason,
  signInReasonDomain,
  toPlatformError,
} from './errors';
import { DebugInfo, ErrorInfo } from './generated/google/rpc/error_details';
import { Status } from './generated/google/rpc/status';
import type { Any } from './generated/google/protobuf/any';
import { Code, StatusError } from './transport';

function errorInfo(domain: string, reason: string, metadata: Record<string, string> = {}): Any {
  return {
    typeUrl: 'type.googleapis.com/google.rpc.ErrorInfo',
    value: ErrorInfo.encode({ domain, reason, metadata }).finish(),
  };
}

function statusDetails(code: Code, message: string, details: Any[]): Uint8Array {
  return Status.encode({ code, message, details }).finish();
}

describe('PlatformError.fromStatus', () => {
  it('reads a sign-in reason from the ErrorInfo detail', () => {
    const err = PlatformError.fromStatus(
      new StatusError(
        Code.UNAUTHENTICATED,
        'a second-factor code is required',
        statusDetails(Code.UNAUTHENTICATED, 'a second-factor code is required', [
          errorInfo(signInReasonDomain, 'SECOND_FACTOR_REQUIRED'),
        ]),
      ),
    );

    expect(err.code).toBe(Code.UNAUTHENTICATED);
    expect(err.serverMessage).toBe('a second-factor code is required');
    expect(err.reason).toEqual({
      known: true,
      domain: signInReasonDomain,
      reason: SignInReason.SECOND_FACTOR_REQUIRED,
      metadata: {},
    });
    expect(err.is(SignInReason.SECOND_FACTOR_REQUIRED)).toBe(true);
    expect(err.is(SignInReason.INVALID_CREDENTIALS)).toBe(false);
  });

  it('finds the ErrorInfo among other details', () => {
    const debug: Any = {
      typeUrl: 'type.googleapis.com/google.rpc.DebugInfo',
      value: DebugInfo.encode({ stackEntries: ['x'], detail: 'y' }).finish(),
    };

    const err = PlatformError.fromStatus(
      new StatusError(
        Code.PERMISSION_DENIED,
        'suspended',
        statusDetails(Code.PERMISSION_DENIED, 'suspended', [debug, errorInfo(signInReasonDomain, 'USER_SUSPENDED')]),
      ),
    );

    expect(err.is(SignInReason.USER_SUSPENDED)).toBe(true);
  });

  it('keeps a sign-in reason this client does not know, without throwing', () => {
    const err = PlatformError.fromStatus(
      new StatusError(
        Code.FAILED_PRECONDITION,
        'new',
        statusDetails(Code.FAILED_PRECONDITION, 'new', [errorInfo(signInReasonDomain, 'SOMETHING_NEW', { k: 'v' })]),
      ),
    );

    expect(err.reason).toEqual({
      known: false,
      domain: signInReasonDomain,
      reason: 'SOMETHING_NEW',
      metadata: { k: 'v' },
    });
  });

  it('does not treat a known name from another domain as a sign-in reason', () => {
    const err = PlatformError.fromStatus(
      new StatusError(
        Code.UNAUTHENTICATED,
        'x',
        statusDetails(Code.UNAUTHENTICATED, 'x', [errorInfo('example.com', 'INVALID_CREDENTIALS')]),
      ),
    );

    expect(err.reason?.known).toBe(false);
    expect(err.is(SignInReason.INVALID_CREDENTIALS)).toBe(false);
  });

  it('has no reason when the status carried no details', () => {
    const err = PlatformError.fromStatus(
      new StatusError(Code.PERMISSION_DENIED, 'account status does not admit sign-in'),
    );

    expect(err.reason).toBeUndefined();
    expect(err.code).toBe(Code.PERMISSION_DENIED);
  });

  it('has no reason when the details do not decode', () => {
    const err = PlatformError.fromStatus(
      new StatusError(Code.UNAUTHENTICATED, 'x', new Uint8Array([0xff, 0xff, 0xff])),
    );

    expect(err.reason).toBeUndefined();
  });

  it('says in its message what an UNKNOWN code probably means', () => {
    const err = PlatformError.fromStatus(new StatusError(Code.UNKNOWN, 'invalid credentials'));

    expect(err.serverMessage).toBe('invalid credentials');
    expect(err.message).toContain('errormappers.Register');
  });

  it('names the code and reason in its message', () => {
    const err = PlatformError.fromStatus(
      new StatusError(
        Code.UNAUTHENTICATED,
        'invalid credentials',
        statusDetails(Code.UNAUTHENTICATED, 'invalid credentials', [
          errorInfo(signInReasonDomain, 'INVALID_CREDENTIALS'),
        ]),
      ),
    );

    expect(err.message).toBe(`UNAUTHENTICATED: invalid credentials [${signInReasonDomain}/INVALID_CREDENTIALS]`);
  });
});

describe('toPlatformError', () => {
  it('converts a StatusError', () => {
    expect(toPlatformError(new StatusError(Code.NOT_FOUND, 'x'))).toBeInstanceOf(PlatformError);
  });

  it('returns a failure with no status as it was', () => {
    const failure = new Error('socket hang up');

    expect(toPlatformError(failure)).toBe(failure);
  });
});

describe('isAmbiguous', () => {
  it.each([
    [Code.DEADLINE_EXCEEDED, true],
    [Code.UNAVAILABLE, true],
    [Code.CANCELLED, true],
    [Code.INTERNAL, true],
    [Code.UNKNOWN, true],
    [Code.UNAUTHENTICATED, false],
    [Code.PERMISSION_DENIED, false],
    [Code.INVALID_ARGUMENT, false],
    [Code.FAILED_PRECONDITION, false],
  ])('code %i is ambiguous: %s', (code, ambiguous) => {
    expect(isAmbiguous(new StatusError(code, 'x'))).toBe(ambiguous);
    expect(isAmbiguous(new PlatformError(code, 'x'))).toBe(ambiguous);
  });

  it('treats a failure with no status as ambiguous', () => {
    expect(isAmbiguous(new Error('socket hang up'))).toBe(true);
  });
});

describe('reason tables', () => {
  it('share no name, since is() matches a name without its domain', () => {
    const names = [SignInReason, PasskeyReason, PasswordResetReason].flatMap((t) => Object.values(t));
    expect(new Set(names).size).toBe(names.length);
  });

  it('reads a reset refusal as known in its own domain', () => {
    const err = PlatformError.fromStatus(
      new StatusError(
        Code.INVALID_ARGUMENT,
        'too short',
        statusDetails(Code.INVALID_ARGUMENT, 'too short', [
          errorInfo(passwordResetReasonDomain, 'REPLACEMENT_PASSWORD_REFUSED'),
        ]),
      ),
    );

    expect(err.reason).toMatchObject({ known: true, domain: passwordResetReasonDomain });
    expect(err.is(PasswordResetReason.REPLACEMENT_PASSWORD_REFUSED)).toBe(true);
  });
});
