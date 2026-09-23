import { describe, expect, it } from 'vitest';

import { type ExchangeAttempt, type ExchangeCoordinator, settledGraceMs } from './coordinator';
import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import { FakeClock, fakeIssuedToken } from './testing';
import { Code, StatusError } from './transport';

/**
 * describeExchangeCoordinator is the contract every ExchangeCoordinator passes. It is what makes one coordinator
 * interchangeable with another rather than merely similar, since `Session` must not be able to tell them apart.
 *
 * `make` builds a fresh coordinator whose sense of time is `clock`.
 */
export function describeExchangeCoordinator(name: string, make: (clock: FakeClock) => ExchangeCoordinator): void {
  describe(`${name} (ExchangeCoordinator conformance)`, () => {
    function setup() {
      const clock = new FakeClock();
      const coordinator = make(clock);
      const attempts: ExchangeAttempt[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const gated =
        (outcome: () => IssuedToken) =>
        async (attempt: ExchangeAttempt): Promise<IssuedToken> => {
          attempts.push(attempt);
          await gate;
          return outcome();
        };
      return { clock, coordinator, attempts, release, gated };
    }

    const successor = (clock: FakeClock) =>
      fakeIssuedToken(clock.now(), { token: 'access-2', refreshToken: 'refresh-2', tokenId: 'jti-2' });

    it('runs one exchange for concurrent callers, and gives each the same successor', async () => {
      const { clock, coordinator, attempts, release, gated } = setup();
      const exchange = gated(() => successor(clock));

      const runs = Array.from({ length: 5 }, () => coordinator.run('refresh-1', exchange));
      await settleMicrotasks();
      release();
      const results = await Promise.all(runs);

      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.takeover).toBe(false);
      expect(results.map((r) => r.refreshToken)).toEqual(Array(5).fill('refresh-2'));
    });

    it('gives a late caller inside the grace window the same successor without a second exchange', async () => {
      const { clock, coordinator, attempts, release, gated } = setup();
      release();
      await coordinator.run(
        'refresh-1',
        gated(() => successor(clock)),
      );

      clock.advance(settledGraceMs - 1_000);
      const late = await coordinator.run(
        'refresh-1',
        gated(() => fakeIssuedToken(clock.now(), { token: 'access-3' })),
      );

      expect(attempts).toHaveLength(1);
      expect(late.token).toBe('access-2');
    });

    it('gives every waiter the refusal, and a late caller too', async () => {
      const { coordinator, attempts, release, gated } = setup();
      const exchange = gated(() => {
        throw new StatusError(Code.UNAUTHENTICATED, 'refresh token reused');
      });

      const runs = Array.from({ length: 5 }, () => coordinator.run('refresh-1', exchange).catch((e: unknown) => e));
      await settleMicrotasks();
      release();
      const results = await Promise.all(runs);
      const late = await coordinator.run('refresh-1', exchange).catch((e: unknown) => e);

      expect(attempts).toHaveLength(1);
      for (const err of [...results, late]) {
        expect(err).toMatchObject({ code: Code.UNAUTHENTICATED, message: 'refresh token reused' });
      }
    });

    it('runs a fresh exchange for a caller once the grace window has passed', async () => {
      const { clock, coordinator, attempts, release, gated } = setup();
      release();
      await coordinator.run(
        'refresh-1',
        gated(() => successor(clock)),
      );

      clock.advance(settledGraceMs);
      const fresh = await coordinator.run(
        'refresh-1',
        gated(() => fakeIssuedToken(clock.now(), { token: 'access-3' })),
      );

      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.takeover).toBe(false);
      expect(fresh.token).toBe('access-3');
    });

    it('keeps exchanges for different tokens apart, each under its own key', async () => {
      const { clock, coordinator, attempts, release, gated } = setup();
      release();

      const [a, b] = await Promise.all([
        coordinator.run(
          'refresh-a',
          gated(() => fakeIssuedToken(clock.now(), { token: 'access-a' })),
        ),
        coordinator.run(
          'refresh-b',
          gated(() => fakeIssuedToken(clock.now(), { token: 'access-b' })),
        ),
      ]);

      expect([a.token, b.token]).toEqual(['access-a', 'access-b']);
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        // It travels as the idempotency-key header, which the contract bounds to printable ASCII.
        expect(attempt.idempotencyKey).toMatch(/^[\x21-\x7e]{1,255}$/);
      }
      expect(attempts[0]!.idempotencyKey).not.toBe(attempts[1]!.idempotencyKey);
    });

    it('does not run an exchange whose outcome it already holds, even when that exchange threw synchronously', async () => {
      const { coordinator } = setup();
      let calls = 0;
      const exchange = (): Promise<IssuedToken> => {
        calls++;
        throw new StatusError(Code.UNAVAILABLE, 'connection reset');
      };

      await expect(coordinator.run('refresh-1', exchange)).rejects.toMatchObject({ code: Code.UNAVAILABLE });
      await expect(coordinator.run('refresh-1', exchange)).rejects.toMatchObject({ code: Code.UNAVAILABLE });

      expect(calls).toBe(1);
    });
  });
}

/** settleMicrotasks lets every caller reach the coordinator before the exchange is released. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
