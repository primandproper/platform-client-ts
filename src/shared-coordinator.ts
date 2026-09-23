import { type ExchangeAttempt, type ExchangeCoordinator, hashToken, settledGraceMs } from './coordinator';
import { PlatformError, type Reason } from './errors';
import { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import { type Code, StatusError } from './transport';

/**
 * CoordinationStore is the key-value store a SharedExchangeCoordinator coordinates through, which every instance of a
 * deployment shares. The consumer writes it over whatever they already run (Redis, Valkey, a database table), so this
 * package takes no dependency on one. An entry past its `ttlMs` must read as absent.
 */
export interface CoordinationStore {
  /** setIfAbsent writes `value` under `key` for `ttlMs` only if nothing is there, and reports whether it did. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/**
 * defaultClaimTtlMs is how long a claimant holds a refresh token before another instance may take the exchange over. It
 * covers the exchange deadline's 30s default twice, since R10's keyed retry is a second attempt under the same claim.
 */
export const defaultClaimTtlMs = 90_000;

const pollInitialMs = 25;
const pollMaxMs = 1_000;
const recordPrefix = 'platform-client:exchange:';
const outcomeInfo = new TextEncoder().encode('platform-client exchange outcome v1');

export interface SharedExchangeCoordinatorConfig {
  store: CoordinationStore;
  /** claimTtlMs is how long a claim holds before it may be taken over. Keep it comfortably above the exchange deadline. */
  claimTtlMs?: number;
}

/**
 * SharedExchangeCoordinator coordinates the Sessions of every instance sharing its store, so that a deployment of more
 * than one process still presents each refresh token once. Per refresh token it keeps three records, each under a hash
 * of the token:
 *
 * - the claim, which the one instance that runs the exchange holds for `claimTtlMs`;
 * - the idempotency key, minted by the first claimant and outliving its claim, so that a takeover sends the same key;
 * - the outcome, published by the claimant for the grace window, sealed under a key only the spent refresh token
 *   derives, so that read access to the store yields nothing usable.
 *
 * Everyone else polls for the outcome. A claim that expires with no outcome means the claimant died mid-exchange, and
 * the next caller takes the exchange over under the same key: an R10 retry, which `Session` decides whether to send.
 */
export class SharedExchangeCoordinator implements ExchangeCoordinator {
  private readonly store: CoordinationStore;
  private readonly claimTtlMs: number;
  /** inFlight collapses this instance's own callers onto one, so that the store sees an instance once per token. */
  private readonly inFlight = new Map<string, Promise<IssuedToken>>();

  constructor(config: SharedExchangeCoordinatorConfig) {
    this.store = config.store;
    this.claimTtlMs = config.claimTtlMs ?? defaultClaimTtlMs;
  }

  async run(refreshToken: string, exchange: (attempt: ExchangeAttempt) => Promise<IssuedToken>): Promise<IssuedToken> {
    const id = await hashToken(refreshToken);
    const existing = this.inFlight.get(id);
    if (existing) {
      return existing;
    }
    const outcome = this.coordinate(refreshToken, id, exchange).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, outcome);
    return outcome;
  }

  private async coordinate(
    refreshToken: string,
    id: string,
    exchange: (attempt: ExchangeAttempt) => Promise<IssuedToken>,
  ): Promise<IssuedToken> {
    const records = recordsFor(id);
    let delayMs = pollInitialMs;
    for (;;) {
      const published = await this.store.get(records.outcome);
      if (published !== undefined) {
        return settle(await openOutcome(published, refreshToken, id));
      }
      if (await this.store.setIfAbsent(records.claim, 'claimed', this.claimTtlMs)) {
        return this.exchangeUnderClaim(refreshToken, id, exchange);
      }
      await sleep(delayMs * (0.5 + Math.random() / 2));
      delayMs = Math.min(delayMs * 2, pollMaxMs);
    }
  }

  private async exchangeUnderClaim(
    refreshToken: string,
    id: string,
    exchange: (attempt: ExchangeAttempt) => Promise<IssuedToken>,
  ): Promise<IssuedToken> {
    const records = recordsFor(id);
    // The key outlives the claim by the grace window, so that a crashed claimant's key is still there for a takeover
    // for as long as its outcome would have been. Finding one already there is what makes this a takeover.
    const keyTtlMs = this.claimTtlMs + settledGraceMs;
    const minted = globalThis.crypto.randomUUID();
    const first = await this.store.setIfAbsent(records.key, minted, keyTtlMs);
    const idempotencyKey = first ? minted : ((await this.store.get(records.key)) ?? minted);
    if (!first) {
      await this.store.set(records.key, idempotencyKey, keyTtlMs);
    }

    let outcome: Outcome;
    try {
      outcome = { kind: 'successor', token: await exchange({ idempotencyKey, takeover: !first }) };
    } catch (err) {
      await this.publish(refreshToken, id, idempotencyKey, toFailure(err));
      throw err;
    }
    await this.publish(refreshToken, id, idempotencyKey, outcome);
    return outcome.token;
  }

  /**
   * publish writes the outcome for the grace window, then cuts the key and the claim down to expire just after it, in
   * that order: once the outcome is gone the key goes before the claim does, so a later caller starts afresh rather than
   * mistaking a finished exchange for a crashed one.
   *
   * A failure to publish is not the claimant's caller's problem, since the successor it holds is the only live one.
   * Other instances see the claim expire and take over under the same key.
   */
  private async publish(refreshToken: string, id: string, idempotencyKey: string, outcome: Outcome): Promise<void> {
    const records = recordsFor(id);
    try {
      await this.store.set(records.outcome, await sealOutcome(outcome, refreshToken, id), settledGraceMs);
      await this.store.set(records.key, idempotencyKey, settledGraceMs);
      await this.store.set(records.claim, 'settled', settledGraceMs);
    } catch {
      // Deliberately swallowed; see above.
    }
  }
}

/**
 * Outcome is what a claimant publishes: the successor, or enough of the failure to rebuild it for every other caller as
 * the same class, since `Session` branches on which class and code it gets (R5, R7).
 */
export type Outcome =
  | { kind: 'successor'; token: IssuedToken }
  | { kind: 'refusal'; code: Code; serverMessage: string; reason: Reason | undefined }
  | { kind: 'status'; code: Code; message: string; statusDetails: string | undefined }
  | { kind: 'failure'; message: string };

type SerializedOutcome = Exclude<Outcome, { kind: 'successor' }> | { kind: 'successor'; token: unknown };

function toFailure(err: unknown): Outcome {
  if (err instanceof PlatformError) {
    return { kind: 'refusal', code: err.code, serverMessage: err.serverMessage, reason: err.reason };
  }
  if (err instanceof StatusError) {
    const statusDetails = err.statusDetails ? toBase64(err.statusDetails) : undefined;
    return { kind: 'status', code: err.code, message: err.message, statusDetails };
  }
  return { kind: 'failure', message: err instanceof Error ? err.message : String(err) };
}

function settle(outcome: Outcome): IssuedToken {
  switch (outcome.kind) {
    case 'successor':
      return outcome.token;
    case 'refusal':
      throw new PlatformError(outcome.code, outcome.serverMessage, outcome.reason);
    case 'status':
      throw new StatusError(
        outcome.code,
        outcome.message,
        outcome.statusDetails ? fromBase64(outcome.statusDetails) : undefined,
      );
    case 'failure':
      throw new Error(outcome.message);
  }
}

/**
 * sealOutcome encrypts an outcome with AES-GCM under a key HKDF derives from the spent refresh token, bound to the
 * record it is written under. Only a caller that already held the spent token can read the successor.
 */
export async function sealOutcome(outcome: Outcome, refreshToken: string, id: string): Promise<string> {
  const serialized: SerializedOutcome =
    outcome.kind === 'successor' ? { kind: 'successor', token: IssuedToken.toJSON(outcome.token) } : outcome;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
    await outcomeKey(refreshToken),
    new TextEncoder().encode(JSON.stringify(serialized)),
  );
  return JSON.stringify({ iv: toBase64(iv), sealed: toBase64(new Uint8Array(sealed)) });
}

/** openOutcome is sealOutcome's inverse. It rejects when `refreshToken` is not the one the outcome was sealed under. */
export async function openOutcome(record: string, refreshToken: string, id: string): Promise<Outcome> {
  const { iv, sealed } = JSON.parse(record) as { iv: string; sealed: string };
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new TextEncoder().encode(id) },
    await outcomeKey(refreshToken),
    fromBase64(sealed),
  );
  const serialized = JSON.parse(new TextDecoder().decode(opened)) as SerializedOutcome;
  return serialized.kind === 'successor'
    ? { kind: 'successor', token: IssuedToken.fromJSON(serialized.token) }
    : serialized;
}

async function outcomeKey(refreshToken: string) {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(refreshToken),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: outcomeInfo },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function recordsFor(id: string) {
  return {
    claim: `${recordPrefix}${id}:claim`,
    key: `${recordPrefix}${id}:key`,
    outcome: `${recordPrefix}${id}:outcome`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}
