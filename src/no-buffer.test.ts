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
});
