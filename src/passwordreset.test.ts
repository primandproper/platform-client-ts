import { describe, expect, it } from 'vitest';

import { PlatformError } from './errors';
import { PasswordResetServiceService } from './generated/primandproper/platform/passwordreset/v1/passwordreset';
import { completePasswordReset, requestPasswordReset, verifyPasswordResetToken } from './passwordreset';
import { Session } from './session';
import { FakeTransport, MemoryCredentialStore } from './testing';
import { Code, StatusError } from './transport';

const request = PasswordResetServiceService.requestPasswordReset;
const verify = PasswordResetServiceService.verifyPasswordResetToken;
const complete = PasswordResetServiceService.completePasswordReset;

function setup() {
  const transport = new FakeTransport();
  const store = new MemoryCredentialStore();
  const session = new Session({ transport, store, metadata: { 'x-tenant': 'acme' } });
  return { transport, store, session };
}

describe('requestPasswordReset', () => {
  it('gives a caller the same outcome for an address somebody holds and one nobody does (R15)', async () => {
    const { transport, session } = setup();
    const held = new Set(['held@example.com']);
    const mailed: string[] = [];
    transport.handle(request, (req) => {
      if (held.has(req.emailAddress)) {
        mailed.push(req.emailAddress);
      }
      return {};
    });

    const forHeld = await requestPasswordReset(session, 'held@example.com');
    const forNobody = await requestPasswordReset(session, 'nobody@example.com');

    expect(mailed).toEqual(['held@example.com']);
    expect(forHeld).toStrictEqual(forNobody);
    expect(forHeld).toBeUndefined();
  });

  it('is anonymous, and carries the tenant', async () => {
    const { transport, session } = setup();
    transport.handle(request, () => ({}));

    await requestPasswordReset(session, 'a@example.com');

    expect(transport.callsTo(request)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('rejects a failure to deliver the request', async () => {
    const { transport, session } = setup();
    transport.handle(request, () => {
      throw new StatusError(Code.UNAVAILABLE, 'unavailable');
    });

    await expect(requestPasswordReset(session, 'a@example.com')).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('verifyPasswordResetToken', () => {
  it('answers a live link with when it expires', async () => {
    const { transport, session } = setup();
    const expiresAt = new Date('2026-01-01T00:20:00Z');
    transport.handle(verify, () => ({ expiresAt }));

    expect(await verifyPasswordResetToken(session, 'link')).toEqual({ kind: 'live', expiresAt });
    expect(transport.callsTo(verify)[0]?.request).toEqual({ token: 'link' });
  });

  it.each(['this link has expired', 'this link has already been used', 'this is not a reset link'])(
    'answers "%s" as a dead link carrying the message',
    async (message) => {
      const { transport, session } = setup();
      transport.handle(verify, () => {
        throw new StatusError(Code.FAILED_PRECONDITION, message);
      });

      expect(await verifyPasswordResetToken(session, 'link')).toEqual({ kind: 'dead_link', message });
    },
  );

  it('rejects anything that is not a dead link', async () => {
    const { transport, session } = setup();
    transport.handle(verify, () => {
      throw new StatusError(Code.UNAVAILABLE, 'unavailable');
    });

    await expect(verifyPasswordResetToken(session, 'link')).rejects.toMatchObject({ code: Code.UNAVAILABLE });
  });
});

describe('completePasswordReset', () => {
  it('sets the password and signs nobody in', async () => {
    const { transport, store, session } = setup();
    transport.handle(complete, () => ({}));

    expect(await completePasswordReset(session, 'link', 'correct horse')).toEqual({ kind: 'reset' });
    expect(transport.callsTo(complete)[0]?.request).toEqual({ token: 'link', newPassword: 'correct horse' });
    expect(await store.load()).toBeUndefined();
    expect(session.state).toBe('anonymous');
  });

  it('answers a link spent in the meantime as a dead link', async () => {
    const { transport, session } = setup();
    transport.handle(complete, () => {
      throw new StatusError(Code.FAILED_PRECONDITION, 'this link has already been used');
    });

    expect(await completePasswordReset(session, 'link', 'x')).toEqual({
      kind: 'dead_link',
      message: 'this link has already been used',
    });
  });

  it('rejects an empty password as the refusal it is, not a dead link', async () => {
    const { transport, session } = setup();
    transport.handle(complete, () => {
      throw new StatusError(Code.INVALID_ARGUMENT, 'a password is required');
    });

    await expect(completePasswordReset(session, 'link', '')).rejects.toMatchObject({ code: Code.INVALID_ARGUMENT });
  });
});
