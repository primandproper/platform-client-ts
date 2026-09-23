import { describe, expect, it, vi } from 'vitest';

import { type ExchangeAttempt, hashToken } from './coordinator';
import { describeExchangeCoordinator } from './coordinator.conformance';
import { PlatformError, SignInReason } from './errors';
import { type IssuedToken, SignInServiceService } from './generated/primandproper/platform/signin/v1/signin';
import { Session } from './session';
import {
  type CoordinationStore,
  defaultClaimTtlMs,
  openOutcome,
  SharedExchangeCoordinator,
} from './shared-coordinator';
import {
  FakeClock,
  fakeIssuedToken,
  FakeTransport,
  MemoryCoordinationStore,
  MemoryCredentialStore,
  refusal,
} from './testing';
import { Code } from './transport';

describeExchangeCoordinator(
  'SharedExchangeCoordinator',
  (clock) => new SharedExchangeCoordinator({ store: new MemoryCoordinationStore(clock) }),
);

describe('SharedExchangeCoordinator', () => {
  /** instances stands in for a deployment scaled out: `n` coordinators, one per process, sharing one store. */
  function instances(n: number) {
    const clock = new FakeClock();
    const store = new MemoryCoordinationStore(clock);
    const coordinators = Array.from({ length: n }, () => new SharedExchangeCoordinator({ store }));
    return { clock, store, coordinators };
  }

  const successor = (clock: FakeClock) =>
    fakeIssuedToken(clock.now(), { token: 'access-2', refreshToken: 'refresh-2', tokenId: 'jti-2' });

  it('makes one exchange for concurrent callers across instances, and gives each the successor', async () => {
    const { clock, coordinators } = instances(3);
    const attempts: ExchangeAttempt[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const exchange = async (attempt: ExchangeAttempt): Promise<IssuedToken> => {
      attempts.push(attempt);
      await gate;
      return successor(clock);
    };

    const runs = coordinators.flatMap((c) => Array.from({ length: 3 }, () => c.run('refresh-1', exchange)));
    await settleMicrotasks();
    release();
    const results = await Promise.all(runs);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.takeover).toBe(false);
    expect(results.map((r) => r.token)).toEqual(Array(9).fill('access-2'));
    expect(results[8]!.expiresAt).toEqual(results[0]!.expiresAt);
  });

  it('gives another instance the refusal as the same PlatformError, reason and all', async () => {
    const { coordinators } = instances(2);
    const refused = PlatformError.fromStatus(refusal(Code.PERMISSION_DENIED, 'suspended', SignInReason.USER_SUSPENDED));

    await expect(
      coordinators[0]!.run('refresh-1', async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    const late = await coordinators[1]!
      .run('refresh-1', async () => fakeIssuedToken(new Date()))
      .catch((e: unknown) => e);

    expect(late).toBeInstanceOf(PlatformError);
    expect(late).toMatchObject({ code: Code.PERMISSION_DENIED, serverMessage: 'suspended', message: refused.message });
    expect((late as PlatformError).is(SignInReason.USER_SUSPENDED)).toBe(true);
  });

  it('gives another instance a failure with no status as a plain Error, so it stays ambiguous', async () => {
    const { coordinators } = instances(2);

    await expect(
      coordinators[0]!.run('refresh-1', async () => {
        throw new Error('answered OK with no token');
      }),
    ).rejects.toThrow('answered OK with no token');
    const late = await coordinators[1]!
      .run('refresh-1', async () => fakeIssuedToken(new Date()))
      .catch((e: unknown) => e);

    expect(late).not.toBeInstanceOf(PlatformError);
    expect(late).toMatchObject({ message: 'answered OK with no token' });
  });

  it('takes over a claim that expired with no outcome, under the same idempotency key', async () => {
    const { clock, coordinators } = instances(2);
    const attempts: ExchangeAttempt[] = [];

    // The claimant never reports back: the process died mid-exchange.
    void coordinators[0]!.run('refresh-1', (attempt) => {
      attempts.push(attempt);
      return new Promise<never>(() => {});
    });
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    const waiting = coordinators[1]!.run('refresh-1', async (attempt) => {
      attempts.push(attempt);
      return successor(clock);
    });
    await settleMicrotasks();
    expect(attempts).toHaveLength(1);

    clock.advance(defaultClaimTtlMs);
    const result = await waiting;

    expect(result.token).toBe('access-2');
    expect(attempts.map((a) => a.takeover)).toEqual([false, true]);
    expect(attempts[1]!.idempotencyKey).toBe(attempts[0]!.idempotencyKey);
  });

  it('seals the outcome so that the store holds nothing usable without the spent refresh token', async () => {
    const { clock, store, coordinators } = instances(1);

    await coordinators[0]!.run('refresh-1', async () => successor(clock));

    const raw = JSON.stringify([...store.entries]);
    for (const secret of ['refresh-1', 'refresh-2', 'access-2']) {
      expect(raw).not.toContain(secret);
    }
    const id = await hashToken('refresh-1');
    const [, record] = [...store.entries].find(([key]) => key.endsWith(`${id}:outcome`))!;
    await expect(openOutcome(record.value, 'refresh-1', id)).resolves.toMatchObject({
      kind: 'successor',
      token: { token: 'access-2', refreshToken: 'refresh-2' },
    });
    await expect(openOutcome(record.value, 'refresh-other', id)).rejects.toThrow();
  });

  it('still hands the claimant its successor when the store fails to publish it', async () => {
    const clock = new FakeClock();
    const working = new MemoryCoordinationStore(clock);
    const store: CoordinationStore = {
      setIfAbsent: (key, value, ttlMs) => working.setIfAbsent(key, value, ttlMs),
      get: (key) => working.get(key),
      set: async (key, value, ttlMs) => {
        if (key.endsWith(':outcome')) {
          throw new Error('connection reset');
        }
        return working.set(key, value, ttlMs);
      },
    };

    const result = await new SharedExchangeCoordinator({ store }).run('refresh-1', async () => successor(clock));

    expect(result.token).toBe('access-2');
  });
});

describe('Session over SharedExchangeCoordinator', () => {
  const getSelf = SignInServiceService.getSelf;
  const exchange = SignInServiceService.exchangeRefreshToken;

  it('never sends the refresh token a second time after a claimant crashed, with R10 off (R5)', async () => {
    const clock = new FakeClock();
    const shared = new MemoryCoordinationStore(clock);
    const transport = new FakeTransport()
      .handle(getSelf, () => ({ user: undefined }) as never)
      // The first instance's exchange never comes back: it died with the token possibly spent.
      .handle(exchange, () => new Promise<never>(() => {}));
    const cookie = fakeIssuedToken(clock.now());
    const instance = () => {
      const store = new MemoryCredentialStore(cookie);
      const coordinator = new SharedExchangeCoordinator({ store: shared });
      return { store, session: new Session({ transport, store, clock, coordinator }) };
    };

    clock.advance(60 * 60 * 1000 - 10_000);
    void instance().session.call(getSelf, {});
    await vi.waitFor(() => expect(transport.callsTo(exchange)).toHaveLength(1));
    const second = instance();
    const call = second.session.call(getSelf, {});
    await settleMicrotasks();
    clock.advance(defaultClaimTtlMs);

    await expect(call).rejects.toThrow('never reported back');
    expect(transport.callsTo(exchange)).toHaveLength(1);
    expect((await second.store.load())?.refreshToken).toBe('');
  });
});

/** settleMicrotasks lets every caller reach the coordinator before the test moves on. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
