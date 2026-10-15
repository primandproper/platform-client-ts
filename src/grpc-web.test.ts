import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAmbiguous, PlatformError, SignInReason, signInReasonDomain } from './errors';
import { ErrorInfo } from './generated/google/rpc/error_details';
import { Status } from './generated/google/rpc/status';
import { GetAuthStatusResponse, SignInServiceDefinition } from './generated/primandproper/platform/signin/v1/signin';
import { createGrpcWebTransport, GrpcWebTransportError } from './grpc-web';
import { Code, methodsOf, StatusError } from './transport';

const SignInService = methodsOf(SignInServiceDefinition);
const path = '/primandproper.platform.signin.v1.SignInService/GetAuthStatus';

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (sent: Sent) => Promise<Response> | Response) {
  const sent: Sent[] = [];
  const fetch = (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve(answer({ url, init }));
  };
  return { fetch, sent };
}

function frame(flags: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, payload.length);
  framed.set(payload, 5);
  return framed;
}

function trailerFrame(trailers: Record<string, string>): Uint8Array<ArrayBuffer> {
  const text = Object.entries(trailers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
  return frame(0x80, new TextEncoder().encode(text));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function grpcWebResponse(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/grpc-web+proto', ...headers } });
}

const okBody = () =>
  concat(
    frame(0, GetAuthStatusResponse.encode({ authenticated: true, status: undefined }).finish()),
    trailerFrame({ 'grpc-status': '0' }),
  );

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('createGrpcWebTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('frames the request, sends metadata as headers and decodes the response', async () => {
    const { fetch, sent } = fakeFetch(() => grpcWebResponse(okBody()));
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com/', fetch, credentials: 'include' });

    const response = await transport.unary(SignInService.getAuthStatus, {}, { metadata: { 'x-tenant': 'acme' } });

    expect(response).toEqual({ authenticated: true, status: undefined });
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe(`https://api.example.com${path}`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-tenant': 'acme',
    });
    expect(init.headers).not.toHaveProperty('grpc-timeout');
    // An empty GetAuthStatusRequest encodes to nothing, so the body is the bare frame header.
    expect(init.body).toEqual(new Uint8Array([0, 0, 0, 0, 0]));
  });

  it('leaves credentials to fetch when none is configured', async () => {
    const { fetch, sent } = fakeFetch(() => grpcWebResponse(okBody()));
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    await transport.unary(SignInService.getAuthStatus, {});

    expect(sent[0]!.init).not.toHaveProperty('credentials');
  });

  it('rejects a non-OK status with its code, decoded message and status details', async () => {
    const details = Status.encode({
      code: Code.UNAUTHENTICATED,
      message: 'no',
      details: [
        {
          typeUrl: 'type.googleapis.com/google.rpc.ErrorInfo',
          value: ErrorInfo.encode({
            reason: SignInReason.INVALID_CREDENTIALS,
            domain: signInReasonDomain,
            metadata: {},
          }).finish(),
        },
      ],
    }).finish();
    const { fetch } = fakeFetch(() =>
      grpcWebResponse(
        trailerFrame({
          'grpc-status': String(Code.UNAUTHENTICATED),
          'grpc-message': 'invalid%20credentials',
          // gRPC sends binary metadata unpadded.
          'grpc-status-details-bin': toBase64(details).replace(/=+$/, ''),
        }),
      ),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.UNAUTHENTICATED, message: 'invalid credentials' });
    expect((err as StatusError).statusDetails).toEqual(details);
    expect(PlatformError.fromStatus(err as StatusError).is(SignInReason.INVALID_CREDENTIALS)).toBe(true);
  });

  it('reads the status from the headers of a trailers-only response', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-type': 'application/grpc-web+proto',
            'grpc-status': String(Code.PERMISSION_DENIED),
            'grpc-message': 'not yours',
          },
        }),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.PERMISSION_DENIED, message: 'not yours', statusDetails: undefined });
  });

  it('rejects a body with no trailer frame as a transport failure', async () => {
    const { fetch } = fakeFetch(() =>
      grpcWebResponse(frame(0, GetAuthStatusResponse.encode({ authenticated: true, status: undefined }).finish())),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GrpcWebTransportError);
    expect(err).not.toBeInstanceOf(StatusError);
    expect(isAmbiguous(err)).toBe(true);
  });

  it('rejects a body cut off inside a frame as a transport failure', async () => {
    const { fetch } = fakeFetch(() => grpcWebResponse(okBody().slice(0, 4)));
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    await expect(transport.unary(SignInService.getAuthStatus, {})).rejects.toBeInstanceOf(GrpcWebTransportError);
  });

  it('rejects a network failure as a transport failure carrying its cause', async () => {
    const cause = new TypeError('Failed to fetch');
    const transport = createGrpcWebTransport({
      baseUrl: 'https://api.example.com',
      fetch: () => Promise.reject(cause),
    });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GrpcWebTransportError);
    expect((err as Error).cause).toBe(cause);
    expect(isAmbiguous(err)).toBe(true);
  });

  it('rejects a non-200 with no gRPC status as a transport failure', async () => {
    const { fetch } = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GrpcWebTransportError);
    expect((err as Error).message).toContain('HTTP 502');
  });

  it('rejects a 200 that is not gRPC-web as a transport failure', async () => {
    const { fetch } = fakeFetch(
      () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    await expect(transport.unary(SignInService.getAuthStatus, {})).rejects.toBeInstanceOf(GrpcWebTransportError);
  });

  it('sends the deadline as grpc-timeout and rejects a missed one as DEADLINE_EXCEEDED', async () => {
    const { fetch, sent } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport
      .unary(SignInService.getAuthStatus, {}, { deadline: new Date(Date.now() + 50) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.DEADLINE_EXCEEDED });
    expect((sent[0]!.init.headers as Record<string, string>)['grpc-timeout']).toMatch(/^\d{1,2}m$/);
  });

  it('rejects a deadline already past without sending', async () => {
    const { fetch, sent } = fakeFetch(() => grpcWebResponse(okBody()));
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport
      .unary(SignInService.getAuthStatus, {}, { deadline: new Date(Date.now() - 1) })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: Code.DEADLINE_EXCEEDED });
    expect(sent).toHaveLength(0);
  });

  it('calls the global fetch when none is configured', async () => {
    const { fetch, sent } = fakeFetch(() => grpcWebResponse(okBody()));
    vi.stubGlobal('fetch', fetch);
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com' });

    await expect(transport.unary(SignInService.getAuthStatus, {})).resolves.toEqual({
      authenticated: true,
      status: undefined,
    });
    expect(sent).toHaveLength(1);
  });

  it('writes a deadline too far off for milliseconds in a coarser unit, and does not abort it early', async () => {
    const { fetch, sent } = fakeFetch(async ({ init }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (init.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return grpcWebResponse(okBody());
    });
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });
    const day = 24 * 60 * 60 * 1000;

    await transport.unary(SignInService.getAuthStatus, {}, { deadline: new Date(Date.now() + 30 * day) });
    await transport.unary(SignInService.getAuthStatus, {}, { deadline: new Date(Date.now() + 5000 * day) });

    const timeouts = sent.map(({ init }) => (init.headers as Record<string, string>)['grpc-timeout']);
    expect(timeouts[0]).toMatch(/^\d{1,8}S$/);
    expect(timeouts[1]).toMatch(/^\d{1,8}H$/);
  });

  it('reads a status outside the known codes, a malformed message and undecodable details as sent', async () => {
    const { fetch } = fakeFetch(() =>
      grpcWebResponse(trailerFrame({ 'grpc-status': 'abc', 'grpc-message': '100%', 'grpc-status-details-bin': '!!!' })),
    );
    const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.UNKNOWN, message: '100%', statusDetails: undefined });
  });

  describe('rejects as a transport failure', () => {
    const message = () => GetAuthStatusResponse.encode({ authenticated: true, status: undefined }).finish();

    it.each([
      ['a trailer frame with no grpc-status', () => concat(frame(0, message()), trailerFrame({ 'grpc-message': 'x' }))],
      ['OK with no message', () => trailerFrame({ 'grpc-status': '0' })],
      ['a body cut off inside a frame payload', () => okBody().slice(0, 7)],
      ['a compressed message', () => concat(frame(1, message()), trailerFrame({ 'grpc-status': '0' }))],
      ['two messages', () => concat(frame(0, message()), frame(0, message()), trailerFrame({ 'grpc-status': '0' }))],
    ])('%s', async (_, body) => {
      const { fetch } = fakeFetch(() => grpcWebResponse(body()));
      const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

      await expect(transport.unary(SignInService.getAuthStatus, {})).rejects.toBeInstanceOf(GrpcWebTransportError);
    });

    it('a 200 with no content type', async () => {
      const { fetch } = fakeFetch(() => new Response(null, { status: 200 }));
      const transport = createGrpcWebTransport({ baseUrl: 'https://api.example.com', fetch });

      await expect(transport.unary(SignInService.getAuthStatus, {})).rejects.toThrow('no content type');
    });

    it('a body that fails to read', async () => {
      const cause = new TypeError('network error');
      const response = grpcWebResponse(okBody());
      vi.spyOn(response, 'arrayBuffer').mockRejectedValue(cause);
      const transport = createGrpcWebTransport({
        baseUrl: 'https://api.example.com',
        fetch: () => Promise.resolve(response),
      });

      const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(GrpcWebTransportError);
      expect((err as Error).cause).toBe(cause);
    });
  });
});
