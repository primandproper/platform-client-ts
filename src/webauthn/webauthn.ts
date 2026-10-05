// The passkeys service speaks WebAuthn JSON, and `navigator.credentials` speaks ArrayBuffers. These functions are the
// bridge: the options a Begin call answers, decoded into what `navigator.credentials.get` and `create` take, and the
// credential they resolve with, encoded into the JSON a browser's `toJSON()` produces for the Finish call. Every binary
// field is base64url in both directions, never base64: read padded or unpadded, written unpadded.
//
// It is the browser half of platform-client-swift's PasskeyBridge and matches it case for case, down to the bytes it
// writes. It imports nothing, so a browser bundle that takes it takes no transport with it.

/** PasskeyBridgeError is options or a credential the bridge cannot carry across. */
export class PasskeyBridgeError extends Error {
  override name = 'PasskeyBridgeError';
}

/**
 * parseAssertionOptions reads `beginPasskeySignIn`'s options into what `navigator.credentials.get` takes as its
 * `publicKey`. It reads them either as the server sends them, under `publicKey`, or bare. `allowCredentials` is empty
 * for a discoverable login.
 */
export function parseAssertionOptions(bytes: Uint8Array): PublicKeyCredentialRequestOptions {
  const options = readOptions(bytes, 'request');
  const rpId = optionalString(options, 'rpId');
  if (!rpId) {
    throw new PasskeyBridgeError('the passkey request options name no rpId');
  }
  const parsed: PublicKeyCredentialRequestOptions = {
    challenge: binary(options, 'challenge'),
    rpId,
    allowCredentials: descriptors(options, 'allowCredentials'),
  };
  const userVerification = optionalString(options, 'userVerification');
  if (userVerification) {
    parsed.userVerification = userVerification as UserVerificationRequirement;
  }
  const timeout = optionalNumber(options, 'timeout');
  if (timeout !== undefined) {
    parsed.timeout = timeout;
  }
  return parsed;
}

/**
 * parseRegistrationOptions reads `beginPasskeyRegistration`'s options into what `navigator.credentials.create` takes as
 * its `publicKey`. It reads them either as the server sends them, under `publicKey`, or bare. `user.id` is the caller's
 * WebAuthn user handle, and `excludeCredentials` their existing passkeys, which an authenticator already holding one of
 * declines to register again.
 */
export function parseRegistrationOptions(bytes: Uint8Array): PublicKeyCredentialCreationOptions {
  const options = readOptions(bytes, 'creation');
  const rp = object(options, 'rp');
  const rpId = string(rp, 'id', 'rp.id');
  if (!rpId) {
    throw new PasskeyBridgeError('the passkey creation options name no rp.id');
  }
  const user = object(options, 'user');
  const params = options['pubKeyCredParams'];
  if (!Array.isArray(params)) {
    throw new PasskeyBridgeError('the passkey creation options have no pubKeyCredParams');
  }
  const parsed: PublicKeyCredentialCreationOptions = {
    rp: { id: rpId, name: string(rp, 'name', 'rp.name') },
    user: {
      id: binary(user, 'id', 'user.id'),
      name: string(user, 'name', 'user.name'),
      displayName: string(user, 'displayName', 'user.displayName'),
    },
    challenge: binary(options, 'challenge'),
    pubKeyCredParams: params.map((param: unknown, i) => {
      if (!isObject(param) || typeof param['alg'] !== 'number') {
        throw new PasskeyBridgeError(`the passkey creation options' pubKeyCredParams[${String(i)}] has no alg`);
      }
      return { type: 'public-key', alg: param['alg'] };
    }),
    excludeCredentials: descriptors(options, 'excludeCredentials'),
  };
  const selection = options['authenticatorSelection'];
  if (isObject(selection)) {
    parsed.authenticatorSelection = selection;
  }
  const attestation = optionalString(options, 'attestation');
  if (attestation) {
    parsed.attestation = attestation as AttestationConveyancePreference;
  }
  const timeout = optionalNumber(options, 'timeout');
  if (timeout !== undefined) {
    parsed.timeout = timeout;
  }
  return parsed;
}

/**
 * serializeAssertion writes the credential `navigator.credentials.get` resolved with as a browser's `toJSON()` renders
 * it, which is what `PasskeySignIn.response` carries. A credential with no user handle, which a non-discoverable one may
 * return, is written without one rather than with an empty one: an empty handle is a different user to the server.
 */
export function serializeAssertion(cred: PublicKeyCredential): Uint8Array {
  const response = cred.response;
  if (!isAssertionResponse(response)) {
    throw new PasskeyBridgeError('the credential is not an assertion: its response carries no signature');
  }
  const userHandle = response.userHandle?.byteLength ? encode(response.userHandle) : undefined;
  return credentialJSON(cred, {
    authenticatorData: encode(response.authenticatorData),
    clientDataJSON: encode(response.clientDataJSON),
    signature: encode(response.signature),
    ...(userHandle === undefined ? {} : { userHandle }),
  });
}

/**
 * serializeRegistration writes the credential `navigator.credentials.create` resolved with as a browser's `toJSON()`
 * renders it, which is what `finishPasskeyRegistration` sends. The transports the authenticator reports go with it, so
 * the server can offer them back on every sign-in.
 */
export function serializeRegistration(cred: PublicKeyCredential): Uint8Array {
  const response = cred.response;
  if (!isAttestationResponse(response)) {
    throw new PasskeyBridgeError('the credential is not a registration: its response carries no attestation object');
  }
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
  return credentialJSON(cred, {
    attestationObject: encode(response.attestationObject),
    clientDataJSON: encode(response.clientDataJSON),
    ...(transports.length === 0 ? {} : { transports }),
  });
}

type JSONObject = Record<string, unknown>;

function isObject(value: unknown): value is JSONObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssertionResponse(response: AuthenticatorResponse): response is AuthenticatorAssertionResponse {
  return 'signature' in response;
}

function isAttestationResponse(response: AuthenticatorResponse): response is AuthenticatorAttestationResponse {
  return 'attestationObject' in response;
}

/**
 * readOptions reads go-webauthn's CredentialAssertion and CredentialCreation, which carry the options under
 * `publicKey`, or the options bare. A `publicKey` that is there but malformed is reported rather than read past.
 */
function readOptions(bytes: Uint8Array, kind: string): JSONObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new PasskeyBridgeError(`the passkey ${kind} options are not JSON`, { cause: err });
  }
  if (!isObject(parsed)) {
    throw new PasskeyBridgeError(`the passkey ${kind} options are not a JSON object`);
  }
  const publicKey = parsed['publicKey'];
  if (publicKey === undefined || publicKey === null) {
    return parsed;
  }
  if (!isObject(publicKey)) {
    throw new PasskeyBridgeError(`the passkey ${kind} options' publicKey is not a JSON object`);
  }
  return publicKey;
}

function object(from: JSONObject, key: string): JSONObject {
  const value = from[key];
  if (!isObject(value)) {
    throw new PasskeyBridgeError(`the passkey options have no ${key}`);
  }
  return value;
}

function string(from: JSONObject, key: string, path = key): string {
  const value = from[key];
  if (typeof value !== 'string') {
    throw new PasskeyBridgeError(`the passkey options have no ${path}`);
  }
  return value;
}

function optionalString(from: JSONObject, key: string): string | undefined {
  const value = from[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(from: JSONObject, key: string): number | undefined {
  const value = from[key];
  return typeof value === 'number' ? value : undefined;
}

function binary(from: JSONObject, key: string, path = key): ArrayBuffer {
  return decode(string(from, key, path), path);
}

/** descriptors reads a credential list, absent meaning none. */
function descriptors(from: JSONObject, key: string): PublicKeyCredentialDescriptor[] {
  const value = from[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PasskeyBridgeError(`the passkey options' ${key} is not a list`);
  }
  return value.map((entry: unknown, i) => {
    const path = `${key}[${String(i)}]`;
    if (!isObject(entry)) {
      throw new PasskeyBridgeError(`the passkey options' ${path} is not a credential`);
    }
    const descriptor: PublicKeyCredentialDescriptor = { type: 'public-key', id: binary(entry, 'id', `${path}.id`) };
    const transports = entry['transports'];
    if (Array.isArray(transports)) {
      descriptor.transports = transports.filter((t): t is AuthenticatorTransport => typeof t === 'string');
    }
    return descriptor;
  });
}

/** credentialJSON is the PublicKeyCredential JSON both ceremonies send, its keys sorted as the Swift bridge sorts them. */
function credentialJSON(cred: PublicKeyCredential, response: Record<string, unknown>): Uint8Array {
  const id = encode(cred.rawId);
  const attachment = cred.authenticatorAttachment;
  return new TextEncoder().encode(
    JSON.stringify({
      ...(attachment === 'platform' || attachment === 'cross-platform' ? { authenticatorAttachment: attachment } : {}),
      clientExtensionResults: {},
      id,
      rawId: id,
      response,
      type: 'public-key',
    }),
  );
}

const base64URL = /^[A-Za-z0-9_-]*=*$/;

/** decode reads base64url, padded or not, and refuses base64's own `+` and `/`. */
function decode(text: string, path: string): ArrayBuffer {
  const unpadded = text.replace(/=+$/, '');
  if (!base64URL.test(text) || unpadded.length % 4 === 1) {
    throw new PasskeyBridgeError(`the passkey options' ${path} is not base64url`);
  }
  const base64 = unpadded.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}

/** encode writes base64url, unpadded, as a browser does. */
function encode(bytes: ArrayBuffer): string {
  let raw = '';
  for (const byte of new Uint8Array(bytes)) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
