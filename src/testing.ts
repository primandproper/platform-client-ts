import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import type { Clock, CredentialStore } from './seams';

/**
 * MemoryCredentialStore holds a session in memory. It is for tests: a store that forgets on restart loses the successor
 * R6 says to persist before anything else, so it is not a production default.
 */
export class MemoryCredentialStore implements CredentialStore {
  private token: IssuedToken | undefined;

  constructor(token?: IssuedToken) {
    this.token = token;
  }

  async load(): Promise<IssuedToken | undefined> {
    return this.token;
  }

  async save(token: IssuedToken): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = undefined;
  }
}

/** FakeClock is a Clock that moves only when told to. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-01-01T00:00:00Z')) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(to: Date): void {
    this.current = new Date(to);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
