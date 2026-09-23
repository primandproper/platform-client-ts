import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import { type Clock, systemClock } from './seams';

/**
 * settledGraceMs is how long a coordinator keeps an exchange's outcome after it settles. It covers the stale cookie: a
 * request that left the browser before the response carrying the successor arrived, still holding the spent token.
 */
export const settledGraceMs = 60_000;

/** ExchangeAttempt is what a coordinator hands the one caller that actually exchanges a refresh token. */
export interface ExchangeAttempt {
  /** idempotencyKey is minted once per token by the coordinator, and is the same on a takeover (R4, R10). */
  idempotencyKey: string;
  /**
   * takeover is true when an earlier attempt for this token started and never reported back, so the token may already
   * be spent. `Session` sends it only as an R10 retry; with R10 off, it abandons the refresh token instead (R5).
   */
  takeover: boolean;
}

/**
 * ExchangeCoordinator deduplicates refresh-token exchanges across every `Session` that shares it. A backend-for-frontend
 * builds a `Session` per request, so one browser's concurrent requests are several Sessions holding the same refresh
 * token, and without a shared coordinator each of them would present it: reuse, and the login revoked (R1).
 *
 * A coordinator knows nothing about the contract. What an exchange's outcome means (R5, R6, R7, R10) is `Session`'s.
 */
export interface ExchangeCoordinator {
  /**
   * run makes sure `exchange` runs at most once per refresh token across everything sharing this coordinator, and
   * gives every caller for that token the same outcome: the successor, or the refusal. A settled outcome is kept for a
   * grace window, so a caller that arrives with an already-spent token after the exchange finished still gets it.
   */
  run(refreshToken: string, exchange: (attempt: ExchangeAttempt) => Promise<IssuedToken>): Promise<IssuedToken>;
}

export interface InMemoryExchangeCoordinatorConfig {
  clock?: Clock;
}

interface Entry {
  outcome: Promise<IssuedToken>;
  settledAt: number | undefined;
}

/**
 * InMemoryExchangeCoordinator coordinates the Sessions of one process. It keys its entries by a hash of the refresh
 * token, never the token itself, so a heap dump holds nothing exchangeable. A deployment of more than one process needs
 * a coordinator they all share instead.
 */
export class InMemoryExchangeCoordinator implements ExchangeCoordinator {
  private readonly clock: Clock;
  private readonly entries = new Map<string, Entry>();

  constructor(config: InMemoryExchangeCoordinatorConfig = {}) {
    this.clock = config.clock ?? systemClock;
  }

  async run(refreshToken: string, exchange: (attempt: ExchangeAttempt) => Promise<IssuedToken>): Promise<IssuedToken> {
    const id = await hashToken(refreshToken);
    // Nothing below awaits until the entry is in the map, so two callers cannot both miss it.
    this.sweep();
    const existing = this.entries.get(id);
    if (existing) {
      return existing.outcome;
    }

    const attempt: ExchangeAttempt = { idempotencyKey: globalThis.crypto.randomUUID(), takeover: false };
    const entry: Entry = { outcome: (async () => exchange(attempt))(), settledAt: undefined };
    const settle = () => {
      entry.settledAt = this.clock.now().getTime();
    };
    entry.outcome.then(settle, settle);
    this.entries.set(id, entry);
    return entry.outcome;
  }

  private sweep(): void {
    const cutoff = this.clock.now().getTime() - settledGraceMs;
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) {
        this.entries.delete(id);
      }
    }
  }
}

async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
