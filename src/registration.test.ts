import { describe, expect, it } from 'vitest';

import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { attachPassword, requestMagicLink, verifyEmailAddress } from './registration';
import { Session } from './session';
import { FakeTransport, MemoryCredentialStore, refusal } from './testing';
import { Code, StatusError } from './transport';

const verify = SignInServiceService.verifyEmailAddress;
const attach = SignInServiceService.attachPassword;
const magicLink = SignInServiceService.requestMagicLink;

function setup() {
  const transport = new FakeTransport();
  const store = new MemoryCredentialStore();
  const session = new Session({ transport, store, metadata: { 'x-tenant': 'acme' } });
  return { transport, store, session };
}

describe('verifyEmailAddress', () => {
  it('verifies with the link token alone, anonymously', async () => {
    const { transport, session } = setup();
    transport.handle(verify, () => ({}));

    expect(await verifyEmailAddress(session, 'link')).toEqual({ kind: 'verified' });
    expect(transport.callsTo(verify)[0]?.request).toEqual({ token: 'link' });
    expect(transport.callsTo(verify)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('answers a dead link as one, whatever made it dead', async () => {
    const { transport, session } = setup();
    transport.handle(verify, () => {
      throw refusal(Code.UNAUTHENTICATED, 'invalid credentials', 'INVALID_CREDENTIALS');
    });

    expect(await verifyEmailAddress(session, 'link')).toEqual({ kind: 'dead_link', message: 'invalid credentials' });
  });

  it('rejects anything that is not a dead link', async () => {
    const { transport, session } = setup();
    transport.handle(verify, () => {
      throw new StatusError(Code.UNAVAILABLE, 'unavailable');
    });

    await expect(verifyEmailAddress(session, 'link')).rejects.toMatchObject({ code: Code.UNAVAILABLE });
  });
});

describe('attachPassword', () => {
  it('attaches a password with the link token', async () => {
    const { transport, store, session } = setup();
    transport.handle(attach, () => ({}));

    expect(await attachPassword(session, 'link', 'correct horse')).toEqual({ kind: 'attached' });
    expect(transport.callsTo(attach)[0]?.request).toEqual({ token: 'link', newPassword: 'correct horse' });
    expect(await store.load()).toBeUndefined();
  });

  it('answers an account that already has a password with the reason, not as a dead link', async () => {
    const { transport, session } = setup();
    transport.handle(attach, () => {
      throw refusal(Code.FAILED_PRECONDITION, 'a password is already set', 'PASSWORD_ALREADY_SET');
    });

    expect(await attachPassword(session, 'link', 'x')).toEqual({
      kind: 'password_already_set',
      message: 'a password is already set',
    });
  });

  it('answers a dead link as one', async () => {
    const { transport, session } = setup();
    transport.handle(attach, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'invalid credentials');
    });

    expect(await attachPassword(session, 'link', 'x')).toEqual({ kind: 'dead_link', message: 'invalid credentials' });
  });

  it('rejects a FAILED_PRECONDITION that carries no reason rather than guessing from its message', async () => {
    const { transport, session } = setup();
    transport.handle(attach, () => {
      throw new StatusError(Code.FAILED_PRECONDITION, 'a password is already set');
    });

    await expect(attachPassword(session, 'link', 'x')).rejects.toMatchObject({ code: Code.FAILED_PRECONDITION });
  });
});

describe('requestMagicLink', () => {
  it('gives a caller the same outcome for an address somebody holds and one nobody does', async () => {
    const { transport, session } = setup();
    const mailed: string[] = [];
    transport.handle(magicLink, (req) => {
      if (req.emailAddress === 'held@example.com') {
        mailed.push(req.emailAddress);
      }
      return {};
    });

    await expect(requestMagicLink(session, 'held@example.com')).resolves.toBeUndefined();
    await expect(requestMagicLink(session, 'nobody@example.com')).resolves.toBeUndefined();

    expect(mailed).toEqual(['held@example.com']);
    expect(transport.callsTo(magicLink)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });
});
