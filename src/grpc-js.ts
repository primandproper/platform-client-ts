import * as grpc from '@grpc/grpc-js';

import { type Code, StatusError, type Transport } from './transport';

export interface GrpcJsTransportConfig {
  /** address is the authority to dial, `host:port`. Where the tenant is a host, this is where it is chosen. */
  address: string;
  /** credentials is the channel's TLS configuration. Where the tenant is a client certificate, it lives here. */
  credentials: grpc.ChannelCredentials;
  channelOptions?: grpc.ChannelOptions;
}

export interface GrpcJsTransport extends Transport {
  close(): void;
}

const statusDetailsKey = 'grpc-status-details-bin';

/** createGrpcJsTransport is the Transport for a Node process, over one `@grpc/grpc-js` channel. */
export function createGrpcJsTransport(config: GrpcJsTransportConfig): GrpcJsTransport {
  const client = new grpc.Client(config.address, config.credentials, config.channelOptions);

  return {
    unary(method, request, options) {
      const metadata = new grpc.Metadata();
      for (const [key, value] of Object.entries(options?.metadata ?? {})) {
        metadata.set(key, value);
      }
      const callOptions: grpc.CallOptions = options?.deadline ? { deadline: options.deadline } : {};

      return new Promise((resolve, reject) => {
        client.makeUnaryRequest(
          method.path,
          method.requestSerialize,
          method.responseDeserialize,
          request,
          metadata,
          callOptions,
          (err, response) => {
            if (err) {
              reject(toStatusError(err));
            } else if (response === undefined) {
              reject(new Error(`${method.path} answered OK with no response`));
            } else {
              resolve(response);
            }
          },
        );
      });
    },
    close: () => client.close(),
  };
}

function toStatusError(err: grpc.ServiceError): Error {
  if (typeof err.code !== 'number') {
    return err;
  }
  const [details] = err.metadata?.get(statusDetailsKey) ?? [];
  return new StatusError(
    err.code as Code,
    err.details,
    details instanceof Buffer ? new Uint8Array(details) : undefined,
  );
}
