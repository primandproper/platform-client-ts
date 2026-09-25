import { describe, expect, it } from 'vitest';

import { PlatformError } from './errors';
import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { FakeTransport } from './testing';
import { TokenCaller } from './token-caller';
import { Code, StatusError } from './transport';

const getSelf = SignInServiceService.getSelf;

function setup() {
  const transport = new FakeTransport().handle(getSelf, () => ({ user: undefined }) as never);
  const caller = new TokenCaller({ transport, metadata: { 'x-tenant': 'acme' } });
  return { transport, caller };
}

describe('TokenCaller', () => {
  it('sends the token it is given with the tenant entries', async () => {
    const { transport, caller } = setup();

    await caller.call(getSelf, 'access-1', {});

    expect(transport.callsTo(getSelf)[0]?.options.metadata).toEqual({
      'authorization': 'Bearer access-1',
      'x-tenant': 'acme',
    });
  });

  it('sends the tenant entries on an anonymous call too, and no credential', async () => {
    const { transport, caller } = setup();

    await caller.callAnonymous(getSelf, {});

    expect(transport.callsTo(getSelf)[0]?.options.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('carries the token however its Authorizer says to', async () => {
    const transport = new FakeTransport().handle(getSelf, () => ({ user: undefined }) as never);
    const caller = new TokenCaller({ transport, authorizer: { credentials: (token) => ({ 'x-api-token': token }) } });

    await caller.call(getSelf, 'access-1', {}, { metadata: { 'idempotency-key': 'key-1' } });

    expect(transport.callsTo(getSelf)[0]?.options.metadata).toEqual({
      'idempotency-key': 'key-1',
      'x-api-token': 'access-1',
    });
  });

  it('surfaces UNAUTHENTICATED to the caller, without refreshing or retrying', async () => {
    const { transport, caller } = setup();
    transport.handle(getSelf, () => {
      throw new StatusError(Code.UNAUTHENTICATED, 'token expired');
    });

    const err = await caller.call(getSelf, 'access-1', {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).code).toBe(Code.UNAUTHENTICATED);
    expect((err as PlatformError).serverMessage).toBe('token expired');
    expect(transport.calls).toHaveLength(1);
  });

  it('passes a failure that carried no status through as it was', async () => {
    const { transport, caller } = setup();
    const failure = new Error('connection reset');
    transport.handle(getSelf, () => {
      throw failure;
    });

    await expect(caller.call(getSelf, 'access-1', {})).rejects.toBe(failure);
  });
});
