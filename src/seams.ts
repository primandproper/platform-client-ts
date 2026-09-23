import type { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';

/**
 * Metadata is what travels beside a request: the tenant's constant entries (R12) and whatever the Authorizer
 * produces. Keys are lowercase, as gRPC requires.
 */
export type Metadata = Readonly<Record<string, string>>;

/**
 * CredentialStore holds the session a sign-in minted. The refresh token inside it is "the one worth stealing", so an
 * implementation belongs in whatever the platform's most protected store is, and nowhere a log, a crash report or a
 * URL can reach. There is deliberately no default: one that cannot meet that bar should not be written.
 */
export interface CredentialStore {
  load(): Promise<IssuedToken | undefined>;
  save(token: IssuedToken): Promise<void>;
  clear(): Promise<void>;
}

/** Clock is a seam so that expiry skew and refresh timing can be tested without waiting for real time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Authorizer turns an access token into the metadata that carries it. Nothing in platform-go fixes how a token reaches
 * a server, since a service resolves its caller through a PrincipalExtractor the consumer writes, so a deployment that
 * chose something else supplies its own.
 */
export interface Authorizer {
  credentials(token: string): Metadata;
}

/** bearerAuthorizer is the contract's default: the `authorization` entry, valued `Bearer <token>`. */
export const bearerAuthorizer: Authorizer = {
  credentials: (token) => ({ authorization: `Bearer ${token}` }),
};
