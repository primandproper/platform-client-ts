import { describe, expect, it } from 'vitest';

import { MediaRegistryServiceDefinition } from './generated/primandproper/platform/mediaregistry/v1/mediaregistry';
import { SignInServiceDefinition } from './generated/primandproper/platform/signin/v1/signin';
import { type CallOptions, methodsOf, type Transport } from './transport';
import { withConstantMetadata } from './transport';

const SignInService = methodsOf(SignInServiceDefinition);

function recordingTransport(): { transport: Transport; calls: CallOptions[] } {
  const calls: CallOptions[] = [];
  const transport: Transport = {
    unary: (_method, _request, options) => {
      calls.push(options ?? {});
      return Promise.resolve(undefined as never);
    },
  };
  return { transport, calls };
}

describe('withConstantMetadata', () => {
  it('sends the entries on a call that carries no metadata of its own', async () => {
    const { transport, calls } = recordingTransport();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(SignInService.getAuthStatus, {});

    expect(calls).toEqual([{ metadata: { 'x-tenant': 'acme' } }]);
  });

  it('merges the entries with a call that carries its own', async () => {
    const { transport, calls } = recordingTransport();
    const deadline = new Date();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(
      SignInService.getAuthStatus,
      {},
      { metadata: { authorization: 'Bearer abc' }, deadline },
    );

    expect(calls).toEqual([{ metadata: { 'authorization': 'Bearer abc', 'x-tenant': 'acme' }, deadline }]);
  });

  it('is not replaced by a per-call entry of the same name', async () => {
    const { transport, calls } = recordingTransport();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(
      SignInService.getAuthStatus,
      {},
      { metadata: { 'x-tenant': 'globex' } },
    );

    expect(calls[0]?.metadata).toEqual({ 'x-tenant': 'acme' });
  });

  it('is unaffected by later changes to the object it was given', async () => {
    const { transport, calls } = recordingTransport();
    const entries: Record<string, string> = { 'x-tenant': 'acme' };
    const withTenant = withConstantMetadata(transport, entries);

    entries['x-tenant'] = 'globex';
    await withTenant.unary(SignInService.getAuthStatus, {});

    expect(calls[0]?.metadata).toEqual({ 'x-tenant': 'acme' });
  });
});

describe('methodsOf', () => {
  it('dials each method under the full name of its service', () => {
    expect(SignInService.getSelf.path).toBe('/primandproper.platform.signin.v1.SignInService/GetSelf');
  });

  it('carries the messages on and off the wire as Uint8Array', () => {
    const { requestType } = SignInService.exchangeRefreshToken;

    const bytes = requestType.encode({ refreshToken: 'refresh-1' }).finish();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(requestType.decode(bytes)).toEqual({ refreshToken: 'refresh-1' });
  });

  it('leaves out a streaming method, which no Transport carries', () => {
    const media = methodsOf(MediaRegistryServiceDefinition);

    expect(media.recordObject.path).toBe('/primandproper.platform.mediaregistry.v1.MediaRegistryService/RecordObject');
    expect('uploadObject' in media).toBe(false);
  });
});
