import { toPlatformError } from './errors';
import { type Authorizer, bearerAuthorizer, type Metadata } from './seams';
import { type CallOptions, type Transport, type UnaryMethod, withConstantMetadata } from './transport';

export interface TokenCallerConfig {
  transport: Transport;
  authorizer?: Authorizer;
  /**
   * metadata is sent on every call, anonymous and authenticated alike: where a deployment carries the tenant in
   * metadata, this is where it goes (R12).
   */
  metadata?: Metadata;
}

/**
 * TokenCaller makes calls with a token the caller already holds. It is for a consumer whose login lives somewhere else
 * (its own sign-in, say, while it moves onto platform's) and that wants the stubs before it wants a Session.
 *
 * It holds no state, so R1–R7 do not apply to it: it never refreshes, never retries, and never ends anything. A call
 * answered UNAUTHENTICATED rejects with that PlatformError, and what to do about it is the caller's to decide. Anything
 * that needs refreshing is a Session, which makes its own calls through one of these, so the two cannot differ over how
 * metadata is assembled.
 */
export class TokenCaller {
  private readonly transport: Transport;
  private readonly authorizer: Authorizer;

  constructor(config: TokenCallerConfig) {
    this.transport = config.metadata ? withConstantMetadata(config.transport, config.metadata) : config.transport;
    this.authorizer = config.authorizer ?? bearerAuthorizer;
  }

  /** callAnonymous makes a call that carries no credential. */
  async callAnonymous<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options?: CallOptions): Promise<Res> {
    try {
      return await this.transport.unary(method, request, options);
    } catch (err) {
      throw toPlatformError(err);
    }
  }

  /** call makes a call carrying `token`, in whatever metadata the Authorizer puts it. */
  call<Req, Res>(method: UnaryMethod<Req, Res>, token: string, request: Req, options?: CallOptions): Promise<Res> {
    const metadata = { ...options?.metadata, ...this.authorizer.credentials(token) };
    return this.callAnonymous(method, request, { ...options, metadata });
  }
}
