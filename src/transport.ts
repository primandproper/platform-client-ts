import type { Metadata } from './seams';

/**
 * UnaryMethod is the shape ts-proto generates for every unary RPC (`SignInServiceService.loginForToken`, and equally a
 * product's own `RecipesServiceService.createRecipe`), so a Transport can carry any service's calls, not only
 * platform's.
 */
export interface UnaryMethod<Req, Res> {
  readonly path: string;
  readonly requestStream: false;
  readonly responseStream: false;
  requestSerialize(value: Req): Buffer;
  responseDeserialize(value: Buffer): Res;
}

export interface CallOptions {
  metadata?: Metadata;
  deadline?: Date;
}

/**
 * Transport issues an RPC. The authority it dials and its TLS configuration are its own, which is how two of the three
 * ways a deployment carries the tenant are already covered here.
 *
 * A call the server answered with a non-OK status rejects with a StatusError. Anything else it rejects with is a
 * transport failure that carried no status.
 */
export interface Transport {
  unary<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options?: CallOptions): Promise<Res>;
}

/** Code is the gRPC status code set. */
export const Code = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export type Code = (typeof Code)[keyof typeof Code];

/**
 * StatusError is a non-OK status as the server sent it, before anything reads it: the code, the message, and the raw
 * `grpc-status-details-bin` trailer if there was one.
 */
export class StatusError extends Error {
  readonly code: Code;
  readonly statusDetails: Uint8Array | undefined;

  constructor(code: Code, message: string, statusDetails?: Uint8Array) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
    this.statusDetails = statusDetails;
  }
}

/**
 * withConstantMetadata sends `entries` on every call the returned Transport carries. This is R12's third shape: a
 * tenant carried in metadata travels identically on anonymous and authenticated calls alike, so it belongs on the
 * connection rather than on a per-call option, and a per-call entry of the same name does not replace it.
 */
export function withConstantMetadata(transport: Transport, entries: Metadata): Transport {
  const constant = { ...entries };
  return {
    unary: (method, request, options) =>
      transport.unary(method, request, { ...options, metadata: { ...options?.metadata, ...constant } }),
  };
}
