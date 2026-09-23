import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import type { Clock, CredentialStore } from './seams';
import { type CallOptions, Code, StatusError, type Transport, type UnaryMethod } from './transport';

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

export interface RecordedCall {
  path: string;
  request: unknown;
  options: CallOptions;
}

/**
 * FakeTransport answers each method with a handler a test registers, and records every call it was asked to make. A
 * method with no handler answers UNIMPLEMENTED, as a server would.
 */
export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, (request: unknown, options: CallOptions) => unknown>();

  handle<Req, Res>(
    method: UnaryMethod<Req, Res>,
    handler: (request: Req, options: CallOptions) => Res | Promise<Res>,
  ): this {
    this.handlers.set(method.path, handler as (request: unknown, options: CallOptions) => unknown);
    return this;
  }

  callsTo<Req, Res>(method: UnaryMethod<Req, Res>): RecordedCall[] {
    return this.calls.filter((call) => call.path === method.path);
  }

  async unary<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options: CallOptions = {}): Promise<Res> {
    this.calls.push({ path: method.path, request, options });
    const handler = this.handlers.get(method.path);
    if (!handler) {
      throw new StatusError(Code.UNIMPLEMENTED, `${method.path} has no handler`);
    }
    return (await handler(request, options)) as Res;
  }
}

/** fakeIssuedToken is a session that expires an hour after `now`, with a refresh token good for a day. */
export function fakeIssuedToken(now: Date, overrides: Partial<IssuedToken> = {}): IssuedToken {
  return {
    token: 'access-1',
    tokenId: 'jti-1',
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    refreshToken: 'refresh-1',
    refreshTokenExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    activeAccountId: 'account-1',
    administrative: false,
    familyId: 'family-1',
    ...overrides,
  };
}
