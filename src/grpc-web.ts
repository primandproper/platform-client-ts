import { Code, StatusError, type Transport } from './transport';

export interface GrpcWebTransportConfig {
  /** baseUrl is where the gRPC-web handler is mounted. A method's path is appended to it. */
  baseUrl: string;
  /** fetch defaults to the global one. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** credentials passes through to `fetch`. `include` is what sends a cookie to another origin. */
  credentials?: RequestInit['credentials'];
}

const contentType = 'application/grpc-web+proto';
const statusDetailsKey = 'grpc-status-details-bin';
const frameHeaderLength = 5;
const trailerFlag = 0x80;
const compressedFlag = 0x01;
const maxTimerMs = 2 ** 31 - 1;

/**
 * GrpcWebTransportError is a call that ended without a status: the request never got an answer, or what answered was
 * not a gRPC-web server. Nothing says the request did not arrive, so it is ambiguous as any other transport failure is.
 */
export class GrpcWebTransportError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'GrpcWebTransportError';
  }
}

/**
 * createGrpcWebTransport is the Transport for a browser or React Native app: gRPC-web over `fetch`, unary and binary
 * only. It needs nothing but `fetch`, `AbortController`, `TextDecoder` and `atob`, so it loads from the root.
 */
export function createGrpcWebTransport(config: GrpcWebTransportConfig): Transport {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  // Wrapped rather than stored, because a browser's fetch throws when it is called with anything but the window as `this`.
  const send = config.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));

  return {
    async unary(method, request, options) {
      const headers: Record<string, string> = {
        ...options?.metadata,
        'content-type': contentType,
        'x-grpc-web': '1',
      };

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (options?.deadline) {
        const remaining = options.deadline.getTime() - Date.now();
        if (remaining <= 0) {
          throw new StatusError(Code.DEADLINE_EXCEEDED, 'deadline exceeded before the call was sent');
        }
        headers['grpc-timeout'] = encodeTimeout(remaining);
        // A longer delay overflows setTimeout, which then fires at once. The server still holds the call to grpc-timeout.
        if (remaining <= maxTimerMs) {
          timer = setTimeout(() => {
            controller.abort();
          }, remaining);
        }
      }

      const init: RequestInit = {
        method: 'POST',
        headers,
        body: frame(method.requestType.encode(request).finish()),
        signal: controller.signal,
      };
      if (config.credentials !== undefined) {
        init.credentials = config.credentials;
      }

      let message: Uint8Array;
      try {
        message = await call(send, `${baseUrl}${method.path}`, init);
      } catch (err) {
        if (controller.signal.aborted) {
          throw new StatusError(Code.DEADLINE_EXCEEDED, 'deadline exceeded');
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      return method.responseType.decode(message);
    },
  };
}

async function call(send: NonNullable<GrpcWebTransportConfig['fetch']>, url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await send(url, init);
  } catch (err) {
    throw new GrpcWebTransportError(`${url}: request failed`, { cause: err });
  }

  // Trailers-only: the server answered with a status and no message, and put the status in the headers. An OK there
  // carries no message for a unary call, so it falls through to the body and fails as OK with no trailer frame would.
  const headerStatus = readStatus((key) => response.headers.get(key));
  if (headerStatus && headerStatus.code !== Code.OK) {
    throw headerStatus;
  }
  if (response.status !== 200) {
    throw new GrpcWebTransportError(`${url}: answered HTTP ${String(response.status)} with no gRPC status`);
  }
  const answeredType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/grpc-web(\+proto)?(;|$)/.test(answeredType)) {
    throw new GrpcWebTransportError(`${url}: answered ${answeredType || 'no content type'}, not gRPC-web`);
  }

  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    throw new GrpcWebTransportError(`${url}: reading the response failed`, { cause: err });
  }

  const { message, trailers } = readFrames(url, body);
  if (!trailers) {
    throw new GrpcWebTransportError(`${url}: response ended without a trailer frame`);
  }
  const status = readStatus((key) => trailers.get(key));
  if (!status) {
    throw new GrpcWebTransportError(`${url}: trailer frame carried no grpc-status`);
  }
  if (status.code !== Code.OK) {
    throw status;
  }
  if (!message) {
    throw new GrpcWebTransportError(`${url}: answered OK with no response`);
  }
  return message;
}

function frame(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(frameHeaderLength + message.length);
  new DataView(framed.buffer).setUint32(1, message.length);
  framed.set(message, frameHeaderLength);
  return framed;
}

function readFrames(url: string, body: Uint8Array): { message?: Uint8Array; trailers?: Map<string, string> } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let message: Uint8Array | undefined;
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < frameHeaderLength) {
      throw new GrpcWebTransportError(`${url}: response ended inside a frame header`);
    }
    const flags = view.getUint8(offset);
    const length = view.getUint32(offset + 1);
    const start = offset + frameHeaderLength;
    if (body.length - start < length) {
      throw new GrpcWebTransportError(`${url}: response ended inside a frame`);
    }
    const payload = body.subarray(start, start + length);
    offset = start + length;

    if (flags & trailerFlag) {
      return message ? { message, trailers: parseTrailers(payload) } : { trailers: parseTrailers(payload) };
    }
    if (flags & compressedFlag) {
      throw new GrpcWebTransportError(`${url}: answered a compressed message, which this transport never asks for`);
    }
    if (message) {
      throw new GrpcWebTransportError(`${url}: answered a unary call with more than one message`);
    }
    message = payload;
  }
  return message ? { message } : {};
}

// A Map rather than Headers, which in Node reaches for Buffer.
function parseTrailers(payload: Uint8Array): Map<string, string> {
  const trailers = new Map<string, string>();
  for (const line of new TextDecoder().decode(payload).split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      trailers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return trailers;
}

function readStatus(get: (key: string) => string | null | undefined): StatusError | undefined {
  const raw = get('grpc-status');
  if (raw == null) {
    return undefined;
  }
  // A code outside the set this client knows is still the server's answer, so it passes through as sent.
  const code = Number.parseInt(raw, 10);
  const details = get(statusDetailsKey);
  return new StatusError(
    (Number.isNaN(code) ? Code.UNKNOWN : code) as Code,
    decodeMessage(get('grpc-message') ?? ''),
    details ? decodeBase64(details) : undefined,
  );
}

/** decodeMessage undoes the percent-encoding the spec puts on `grpc-message`, keeping the raw text if it is malformed. */
function decodeMessage(message: string): string {
  try {
    return decodeURIComponent(message);
  } catch {
    return message;
  }
}

/** decodeBase64 reads a binary header. Details that do not decode are dropped, as PlatformError drops ones that do not parse. */
function decodeBase64(value: string): Uint8Array | undefined {
  let binary: string;
  try {
    // atob's forgiving decode accepts the unpadded form gRPC sends binary metadata in.
    binary = atob(value);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** encodeTimeout writes `grpc-timeout`, whose value is at most eight digits, in the finest unit that fits. */
function encodeTimeout(ms: number): string {
  const limit = 99_999_999;
  const whole = Math.ceil(ms);
  if (whole <= limit) {
    return `${String(whole)}m`;
  }
  const seconds = Math.ceil(whole / 1000);
  if (seconds <= limit) {
    return `${String(seconds)}S`;
  }
  return `${String(Math.min(Math.ceil(seconds / 3600), limit))}H`;
}
