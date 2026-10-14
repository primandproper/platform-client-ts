import type { Metadata } from './seams';

/** MessageCodec is the half of a ts-proto message's functions that puts it on the wire and takes it off again. */
export interface MessageCodec<T> {
  encode(message: T): { finish(): Uint8Array };
  decode(input: Uint8Array): T;
}

/**
 * UnaryMethod is one unary RPC a Transport can carry: its path and its messages' codecs, over `Uint8Array` so that
 * nothing about it needs Node. `methodsOf` builds them from any service ts-proto generates with
 * `outputServices=generic-definitions`, platform's and a product's own alike.
 */
export interface UnaryMethod<Req, Res> {
  readonly path: string;
  readonly requestType: MessageCodec<Req>;
  readonly responseType: MessageCodec<Res>;
}

/** ServiceDefinition is the part of a ts-proto `generic-definitions` service that `methodsOf` reads. */
export interface ServiceDefinition {
  readonly fullName: string;
  readonly methods: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly requestType: object;
        readonly requestStream: boolean;
        readonly responseType: object;
        readonly responseStream: boolean;
      }
    >
  >;
}

/** UnaryMethods is a service's unary methods, by the key ts-proto gives each. Streaming methods have no entry. */
export type UnaryMethods<Methods> = {
  readonly [K in keyof Methods as Methods[K] extends { requestStream: false; responseStream: false }
    ? K
    : never]: Methods[K] extends { requestType: MessageCodec<infer Req>; responseType: MessageCodec<infer Res> }
    ? UnaryMethod<Req, Res>
    : never;
};

/**
 * methodsOf is a service's unary methods, ready for a Transport. ts-proto's definitions name a method but leave its path
 * to the service it belongs to, so this is where the two meet: `methodsOf(RecipesServiceDefinition).getRecipe` dials
 * `/<package>.RecipesService/GetRecipe`.
 */
export function methodsOf<S extends ServiceDefinition>(service: S): UnaryMethods<S['methods']> {
  const methods: Record<string, UnaryMethod<unknown, unknown>> = {};
  for (const [key, method] of Object.entries(service.methods)) {
    if (!method.requestStream && !method.responseStream) {
      methods[key] = {
        path: `/${service.fullName}/${method.name}`,
        requestType: method.requestType as MessageCodec<unknown>,
        responseType: method.responseType as MessageCodec<unknown>,
      };
    }
  }
  return methods as UnaryMethods<S['methods']>;
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
