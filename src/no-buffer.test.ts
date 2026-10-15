import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A browser and React Native have no Buffer, so nothing between the package root and the wire may reach for one.
describe('without Buffer', () => {
  const buffer = globalThis.Buffer;

  beforeAll(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, 'Buffer');
  });

  afterAll(() => {
    globalThis.Buffer = buffer;
  });

  it('imports the package root', async () => {
    await expect(import('./index')).resolves.toHaveProperty('methodsOf');
  });

  it('encodes and decodes through a generated service module', async () => {
    const { methodsOf } = await import('./transport');
    const { SignInServiceDefinition } = await import('./generated/primandproper/platform/signin/v1/signin');
    const { requestType } = methodsOf(SignInServiceDefinition).exchangeRefreshToken;

    expect(typeof globalThis.Buffer).toBe('undefined');
    expect(requestType.decode(requestType.encode({ refreshToken: 'refresh-1' }).finish())).toEqual({
      refreshToken: 'refresh-1',
    });
  });

  it('carries a call over gRPC-web', async () => {
    const { createGrpcWebTransport } = await import('./grpc-web');
    const { methodsOf } = await import('./transport');
    const { GetAuthStatusResponse, SignInServiceDefinition } = await import(
      './generated/primandproper/platform/signin/v1/signin'
    );
    const message = GetAuthStatusResponse.encode({ authenticated: true, status: undefined }).finish();
    const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
    const body = new Uint8Array(10 + message.length + trailer.length);
    const view = new DataView(body.buffer);
    view.setUint32(1, message.length);
    body.set(message, 5);
    body[5 + message.length] = 0x80;
    view.setUint32(6 + message.length, trailer.length);
    body.set(trailer, 10 + message.length);
    // Node's own Response and Headers reach for Buffer, which a browser's do not, so the fake is only what the transport
    // reads.
    const response = {
      status: 200,
      headers: { get: (key: string) => (key === 'content-type' ? 'application/grpc-web+proto' : null) },
      arrayBuffer: () => Promise.resolve(body.buffer),
    };
    const transport = createGrpcWebTransport({
      baseUrl: 'https://api.example.com',
      fetch: () => Promise.resolve(response as unknown as Response),
    });

    expect(typeof globalThis.Buffer).toBe('undefined');
    await expect(transport.unary(methodsOf(SignInServiceDefinition).getAuthStatus, {})).resolves.toEqual({
      authenticated: true,
      status: undefined,
    });
  });
});
