import { describe, expect, it } from 'vitest';

import { bearerAuthorizer } from './seams';
import { FakeClock, MemoryCredentialStore } from './testing';

describe('bearerAuthorizer', () => {
  it('carries the token as a bearer authorization entry', () => {
    expect(bearerAuthorizer.credentials('abc')).toEqual({ authorization: 'Bearer abc' });
  });
});

describe('MemoryCredentialStore', () => {
  it('loads what it saved until it is cleared', async () => {
    const store = new MemoryCredentialStore();
    const token = {
      token: 'a',
      tokenId: 'j',
      expiresAt: undefined,
      refreshToken: 'r',
      refreshTokenExpiresAt: undefined,
      activeAccountId: '',
      administrative: false,
      familyId: 'f',
    };

    expect(await store.load()).toBeUndefined();
    await store.save(token);
    expect(await store.load()).toEqual(token);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});

describe('FakeClock', () => {
  it('moves only when told to', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

    clock.advance(30_000);

    expect(clock.now()).toEqual(new Date('2026-01-01T00:00:30Z'));
  });
});
