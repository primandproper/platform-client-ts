import { describe, expect, it } from 'vitest';

import {
  parseAssertionOptions,
  parseRegistrationOptions,
  PasskeyBridgeError,
  serializeAssertion,
  serializeRegistration,
} from './webauthn';

// The fixtures are platform-client-swift's PasskeyBridgeTests', so the two bridges are pinned to the same bytes. Their
// binary fields are chosen to need base64url's own alphabet: 0xfb 0xff 0x01 is "+/8B" in base64 and "-_8B" in
// base64url, so reading or writing base64 instead fails them.
const challenge = new Uint8Array([0xfb, 0xff, 0x01]);
const credentialId = new Uint8Array([0xfa, 0xfe]);
const userHandle = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const json = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (source: BufferSource | undefined) => new Uint8Array(source as ArrayBuffer);
const buffer = (data: Uint8Array | string) => (typeof data === 'string' ? json(data) : data).slice().buffer;

/** requestOptions is BeginLogin's options as go-webauthn renders a CredentialAssertion. */
const requestOptions = json(
  JSON.stringify({
    publicKey: {
      challenge: '-_8B',
      timeout: 300000,
      rpId: 'example.com',
      allowCredentials: [{ type: 'public-key', id: '-v4', transports: ['internal'] }],
      userVerification: 'preferred',
    },
  }),
);

/** creationOptions is BeginRegistration's options as go-webauthn renders a CredentialCreation. */
const creationOptions = json(
  JSON.stringify({
    publicKey: {
      rp: { name: 'Example', id: 'example.com' },
      user: { name: 'jeff', displayName: 'Jeff', id: 'AQIDBA' },
      challenge: '-_8B',
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 300000,
      excludeCredentials: [{ type: 'public-key', id: '-v4' }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      attestation: 'none',
    },
  }),
);

function assertion(response: Partial<AuthenticatorAssertionResponse>, attachment: string | null = null) {
  return {
    rawId: buffer(credentialId),
    authenticatorAttachment: attachment,
    response: { clientDataJSON: new ArrayBuffer(0), authenticatorData: new ArrayBuffer(0), ...response },
  } as unknown as PublicKeyCredential;
}

function registration(response: Partial<AuthenticatorAttestationResponse>, attachment: string | null = null) {
  return {
    rawId: buffer(credentialId),
    authenticatorAttachment: attachment,
    response: { clientDataJSON: new ArrayBuffer(0), ...response },
  } as unknown as PublicKeyCredential;
}

describe('parseAssertionOptions', () => {
  it('reads the options as the server sends them, under publicKey', () => {
    const options = parseAssertionOptions(requestOptions);

    expect(bytes(options.challenge)).toEqual(challenge);
    expect(options.rpId).toBe('example.com');
    expect(options.allowCredentials).toHaveLength(1);
    expect(options.allowCredentials?.[0]).toMatchObject({ type: 'public-key', transports: ['internal'] });
    expect(bytes(options.allowCredentials?.[0]?.id)).toEqual(credentialId);
    expect(options.userVerification).toBe('preferred');
    expect(options.timeout).toBe(300000);
  });

  it('reads bare options with no allowCredentials as a discoverable login', () => {
    const options = parseAssertionOptions(json('{"challenge":"-_8B","rpId":"example.com"}'));

    expect(bytes(options.challenge)).toEqual(challenge);
    expect(options.allowCredentials).toEqual([]);
    expect(options).not.toHaveProperty('userVerification');
    expect(options).not.toHaveProperty('timeout');
  });

  it('reads padded base64url as well as unpadded', () => {
    expect(bytes(parseAssertionOptions(json('{"challenge":"-v4=","rpId":"example.com"}')).challenge)).toEqual(
      credentialId,
    );
    expect(bytes(parseAssertionOptions(json('{"challenge":"-v4","rpId":"example.com"}')).challenge)).toEqual(
      credentialId,
    );
  });

  it('refuses base64 that is not base64url', () => {
    expect(() => parseAssertionOptions(json('{"challenge":"+/8B","rpId":"example.com"}'))).toThrow(PasskeyBridgeError);
  });

  it('refuses a challenge no base64url decodes to', () => {
    expect(() => parseAssertionOptions(json('{"challenge":"-_8B-","rpId":"example.com"}'))).toThrow(
      'challenge is not base64url',
    );
  });

  it('refuses options that name no relying party', () => {
    expect(() => parseAssertionOptions(json('{"publicKey":{"challenge":"-_8B"}}'))).toThrow('name no rpId');
  });

  it('reports a malformed envelope rather than reading past it', () => {
    expect(() => parseAssertionOptions(json('{"publicKey":{"rpId":"example.com"}}'))).toThrow('have no challenge');
    expect(() => parseAssertionOptions(json('{"publicKey":"nope"}'))).toThrow('publicKey is not a JSON object');
  });

  it('refuses what is not a JSON object', () => {
    expect(() => parseAssertionOptions(json('nope'))).toThrow('are not JSON');
    expect(() => parseAssertionOptions(json('[]'))).toThrow('are not a JSON object');
  });

  it('refuses an allowCredentials that is not a list of credentials', () => {
    const options = (allow: string) => json(`{"challenge":"-_8B","rpId":"example.com","allowCredentials":${allow}}`);

    expect(() => parseAssertionOptions(options('{}'))).toThrow('allowCredentials is not a list');
    expect(() => parseAssertionOptions(options('[1]'))).toThrow('allowCredentials[0] is not a credential');
    expect(() => parseAssertionOptions(options('[{}]'))).toThrow('allowCredentials[0].id');
  });
});

describe('parseRegistrationOptions', () => {
  it('reads the options as the server sends them, under publicKey', () => {
    const options = parseRegistrationOptions(creationOptions);

    expect(bytes(options.challenge)).toEqual(challenge);
    expect(options.rp).toEqual({ id: 'example.com', name: 'Example' });
    expect(bytes(options.user.id)).toEqual(userHandle);
    expect(options.user).toMatchObject({ name: 'jeff', displayName: 'Jeff' });
    expect(options.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(options.excludeCredentials).toHaveLength(1);
    expect(bytes(options.excludeCredentials?.[0]?.id)).toEqual(credentialId);
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'preferred',
    });
    expect(options.attestation).toBe('none');
    expect(options.timeout).toBe(300000);
  });

  it('reads bare options with nothing to exclude', () => {
    const options = parseRegistrationOptions(
      json(
        JSON.stringify({
          rp: { name: 'Example', id: 'example.com' },
          user: { name: 'jeff', displayName: 'Jeff', id: 'AQIDBA==' },
          challenge: '-_8B',
          pubKeyCredParams: [],
        }),
      ),
    );

    expect(bytes(options.user.id)).toEqual(userHandle);
    expect(options.excludeCredentials).toEqual([]);
    expect(options).not.toHaveProperty('authenticatorSelection');
    expect(options).not.toHaveProperty('attestation');
    expect(options).not.toHaveProperty('timeout');
  });

  it('refuses options that name no relying party', () => {
    const options = JSON.parse(text(creationOptions)) as { publicKey: { rp: { id: string } } };
    options.publicKey.rp.id = '';

    expect(() => parseRegistrationOptions(json(JSON.stringify(options)))).toThrow('name no rp.id');
  });

  it('refuses options missing what the browser requires', () => {
    interface Options {
      user?: { name?: string; id: string };
      pubKeyCredParams?: unknown;
    }
    const without = (mutate: (o: Options) => void) => {
      const options = JSON.parse(text(creationOptions)) as { publicKey: Options };
      mutate(options.publicKey);
      return json(JSON.stringify(options));
    };

    expect(() => parseRegistrationOptions(without((o) => delete o.user))).toThrow('have no user');
    expect(() => parseRegistrationOptions(without((o) => delete o.user!.name))).toThrow('have no user.name');
    expect(() => parseRegistrationOptions(without((o) => (o.user!.id = '+/8B')))).toThrow('user.id is not base64url');
    expect(() => parseRegistrationOptions(without((o) => delete o.pubKeyCredParams))).toThrow(
      'have no pubKeyCredParams',
    );
    expect(() => parseRegistrationOptions(without((o) => (o.pubKeyCredParams = [{}])))).toThrow(
      'pubKeyCredParams[0] has no alg',
    );
  });
});

describe('serializeAssertion', () => {
  it('writes an assertion as a browser’s toJSON does, byte for byte with the Swift bridge', () => {
    const cred = assertion(
      {
        clientDataJSON: buffer('{"type":"webauthn.get"}'),
        authenticatorData: buffer(challenge),
        signature: buffer(new Uint8Array([0xff])),
        userHandle: buffer(userHandle),
      },
      'platform',
    );

    expect(text(serializeAssertion(cred))).toBe(
      '{"authenticatorAttachment":"platform","clientExtensionResults":{},"id":"-v4",' +
        '"rawId":"-v4","response":{"authenticatorData":"-_8B",' +
        '"clientDataJSON":"eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0","signature":"_w",' +
        '"userHandle":"AQIDBA"},"type":"public-key"}',
    );
  });

  it('writes a null user handle, as a non-discoverable credential may return, as no user handle at all', () => {
    const written = text(serializeAssertion(assertion({ signature: new ArrayBuffer(0), userHandle: null })));

    expect(written).not.toContain('userHandle');
    expect(written).not.toContain('authenticatorAttachment');
  });

  it('writes an empty user handle as no user handle at all', () => {
    const written = text(
      serializeAssertion(assertion({ signature: new ArrayBuffer(0), userHandle: new ArrayBuffer(0) })),
    );

    expect(written).not.toContain('userHandle');
  });

  it('refuses a registration', () => {
    expect(() => serializeAssertion(registration({ attestationObject: new ArrayBuffer(0) }))).toThrow(
      'not an assertion',
    );
  });
});

describe('serializeRegistration', () => {
  it('writes a registration as a browser’s toJSON does, byte for byte with the Swift bridge', () => {
    const cred = registration(
      { clientDataJSON: buffer('{"type":"webauthn.create"}'), attestationObject: buffer(challenge) },
      'cross-platform',
    );

    expect(text(serializeRegistration(cred))).toBe(
      '{"authenticatorAttachment":"cross-platform","clientExtensionResults":{},"id":"-v4",' +
        '"rawId":"-v4","response":{"attestationObject":"-_8B",' +
        '"clientDataJSON":"eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0"},"type":"public-key"}',
    );
  });

  it('writes the transports the authenticator reports, so the server can offer them back on sign-in', () => {
    const cred = registration({ attestationObject: new ArrayBuffer(0), getTransports: () => ['hybrid', 'internal'] });

    expect(JSON.parse(text(serializeRegistration(cred)))).toMatchObject({
      response: { transports: ['hybrid', 'internal'] },
    });
  });

  it('writes no attachment the browser did not report as one it knows', () => {
    const cred = registration({ attestationObject: new ArrayBuffer(0), getTransports: () => [] }, 'something-new');

    const written = text(serializeRegistration(cred));

    expect(written).not.toContain('authenticatorAttachment');
    expect(written).not.toContain('transports');
  });

  it('refuses an assertion', () => {
    expect(() => serializeRegistration(assertion({ signature: new ArrayBuffer(0) }))).toThrow('not a registration');
  });
});
