import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Status } from './generated/google/rpc/status';
import {
  type GetAuthStatusRequest,
  type GetAuthStatusResponse,
  SignInServiceDefinition,
} from './generated/primandproper/platform/signin/v1/signin';
import { createGrpcJsTransport, type GrpcJsTransport } from './grpc-js';
import { Code, methodsOf, StatusError } from './transport';

const SignInService = methodsOf(SignInServiceDefinition);

describe('createGrpcJsTransport', () => {
  let server: grpc.Server;
  let transport: GrpcJsTransport;
  let received: grpc.Metadata | undefined;
  let answer: 'ok' | 'refuse' | 'hang' = 'ok';
  const statusDetails = Buffer.from(Status.encode({ code: Code.UNAUTHENTICATED, message: 'no', details: [] }).finish());

  beforeAll(async () => {
    server = new grpc.Server();
    // The generated code no longer carries grpc-js's server shape, so the test server builds it from the same method.
    const { path, requestType, responseType } = SignInService.getAuthStatus;
    const definition: grpc.ServiceDefinition = {
      getAuthStatus: {
        path,
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: GetAuthStatusRequest) => Buffer.from(requestType.encode(value).finish()),
        requestDeserialize: (bytes: Buffer) => requestType.decode(bytes),
        responseSerialize: (value: GetAuthStatusResponse) => Buffer.from(responseType.encode(value).finish()),
        responseDeserialize: (bytes: Buffer) => responseType.decode(bytes),
      },
    };
    server.addService(definition, {
      getAuthStatus: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        received = call.metadata;
        if (answer === 'refuse') {
          const trailer = new grpc.Metadata();
          trailer.set('grpc-status-details-bin', statusDetails);
          callback({ code: grpc.status.UNAUTHENTICATED, details: 'invalid credentials', metadata: trailer });
        } else if (answer === 'ok') {
          callback(null, { authenticated: false, status: undefined });
        }
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
        if (err) {
          reject(err);
        } else {
          resolve(p);
        }
      });
    });
    transport = createGrpcJsTransport({
      address: `127.0.0.1:${String(port)}`,
      credentials: grpc.credentials.createInsecure(),
    });
  });

  afterAll(() => {
    transport.close();
    server.forceShutdown();
  });

  it('sends metadata and decodes the response', async () => {
    answer = 'ok';

    const response = await transport.unary(
      SignInService.getAuthStatus,
      {},
      { metadata: { 'authorization': 'Bearer abc', 'x-tenant': 'acme' } },
    );

    expect(response).toEqual({ authenticated: false, status: undefined });
    expect(received?.get('authorization')).toEqual(['Bearer abc']);
    expect(received?.get('x-tenant')).toEqual(['acme']);
  });

  it('rejects a refusal with its code, message and status details', async () => {
    answer = 'refuse';

    const err = await transport.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.UNAUTHENTICATED, message: 'invalid credentials' });
    expect(Buffer.from((err as StatusError).statusDetails ?? [])).toEqual(statusDetails);
  });

  it('rejects a missed deadline as DEADLINE_EXCEEDED', async () => {
    answer = 'hang';

    const err = await transport
      .unary(SignInService.getAuthStatus, {}, { deadline: new Date(Date.now() + 50) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.DEADLINE_EXCEEDED, statusDetails: undefined });
  });

  it('rejects an unreachable server as UNAVAILABLE', async () => {
    const nowhere = createGrpcJsTransport({ address: '127.0.0.1:1', credentials: grpc.credentials.createInsecure() });

    const err = await nowhere.unary(SignInService.getAuthStatus, {}).catch((e: unknown) => e);
    nowhere.close();

    expect(err).toBeInstanceOf(StatusError);
    expect(err).toMatchObject({ code: Code.UNAVAILABLE });
  });
});
