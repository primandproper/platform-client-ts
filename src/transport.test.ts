import { describe, expect, it } from 'vitest';

import { SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import type { CallOptions, Transport } from './transport';
import { withConstantMetadata } from './transport';

function recordingTransport(): { transport: Transport; calls: CallOptions[] } {
  const calls: CallOptions[] = [];
  const transport: Transport = {
    unary: async (_method, _request, options) => {
      calls.push(options ?? {});
      return undefined as never;
    },
  };
  return { transport, calls };
}

describe('withConstantMetadata', () => {
  it('sends the entries on a call that carries no metadata of its own', async () => {
    const { transport, calls } = recordingTransport();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(SignInServiceService.getAuthStatus, {});

    expect(calls).toEqual([{ metadata: { 'x-tenant': 'acme' } }]);
  });

  it('merges the entries with a call that carries its own', async () => {
    const { transport, calls } = recordingTransport();
    const deadline = new Date();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(
      SignInServiceService.getAuthStatus,
      {},
      { metadata: { authorization: 'Bearer abc' }, deadline },
    );

    expect(calls).toEqual([{ metadata: { 'authorization': 'Bearer abc', 'x-tenant': 'acme' }, deadline }]);
  });

  it('is not replaced by a per-call entry of the same name', async () => {
    const { transport, calls } = recordingTransport();

    await withConstantMetadata(transport, { 'x-tenant': 'acme' }).unary(
      SignInServiceService.getAuthStatus,
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
    await withTenant.unary(SignInServiceService.getAuthStatus, {});

    expect(calls[0]?.metadata).toEqual({ 'x-tenant': 'acme' });
  });
});
