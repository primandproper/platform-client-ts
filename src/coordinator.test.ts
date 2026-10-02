import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { describeExchangeCoordinator } from './coordinator.conformance';
import { InMemoryExchangeCoordinator } from './coordinator';
import { fakeIssuedToken } from './testing';

describeExchangeCoordinator('InMemoryExchangeCoordinator', (clock) => new InMemoryExchangeCoordinator({ clock }));

describe('InMemoryExchangeCoordinator', () => {
  it('holds a hash of the refresh token, never the token', async () => {
    const coordinator = new InMemoryExchangeCoordinator();

    await coordinator.run('refresh-secret', () =>
      Promise.resolve(fakeIssuedToken(new Date(), { refreshToken: 'refresh-2' })),
    );

    expect(inspect(coordinator, { depth: 10 })).not.toContain('refresh-secret');
  });
});
