import type { webcrypto } from 'node:crypto';

import { PlatformError } from './errors';
import { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import type { CredentialStore } from './seams';
import { NotSignedInError, type Session } from './session';
import { Code } from './transport';

const keyLength = 32;
const ivLength = 12;
const credentialInfo = new TextEncoder().encode('platform-client credential v1');

/**
 * SealedCookie is one cookie of the request a store is built for. Its name, path, `SameSite` and domain are the app's,
 * so they live behind this rather than in the store.
 */
export interface SealedCookie {
  get(): string | undefined;
  /** set writes the cookie to expire at `expires`, or with the browser session when the token carries no expiry. */
  set(value: string, expires: Date | undefined): void;
  delete(): void;
}

/**
 * encryptedCredentialStore is a CredentialStore for a backend-for-frontend, which holds the session in a cookie the
 * browser carries but cannot read: the token is sealed with AES-256-GCM under `key`, a 32-byte server secret.
 *
 * The key must be the same across every instance and every deploy, since a cookie sealed under another key will not
 * open. One that does not open, from a rotated key or anything else, reads as no session at all: a rotated key signs
 * everyone out rather than failing every request.
 *
 * The cookie expires with the refresh token, not the access token, which the session refreshes long before the login
 * ends. It is written only when the token changes, so that a request that refreshed nothing sets no cookie.
 */
export function encryptedCredentialStore(key: Uint8Array, cookie: SealedCookie): CredentialStore {
  if (key.length !== keyLength) {
    throw new Error(`encryptedCredentialStore needs a ${String(keyLength)}-byte key, got ${String(key.length)} bytes`);
  }
  const imported = globalThis.crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  // current is the token the cookie holds as of this request, as JSON, so that saving it again writes nothing.
  let current: string | undefined;

  return {
    async load() {
      const sealed = cookie.get();
      if (!sealed) {
        return undefined;
      }
      let opened: string;
      try {
        opened = await open(sealed, await imported);
      } catch {
        return undefined;
      }
      current = opened;
      return IssuedToken.fromJSON(JSON.parse(opened));
    },
    async save(token) {
      const serialized = JSON.stringify(IssuedToken.toJSON(token));
      if (serialized === current) {
        return;
      }
      cookie.set(await seal(serialized, await imported), token.refreshTokenExpiresAt ?? token.expiresAt);
      current = serialized;
    },
    clear() {
      cookie.delete();
      current = undefined;
      return Promise.resolve();
    },
  };
}

async function seal(plaintext: string, key: webcrypto.CryptoKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(ivLength));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: credentialInfo },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(ivLength + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), ivLength);
  return toBase64Url(out);
}

/** open is seal's inverse, and also checks that what it opened is JSON, so that load never throws past its catch. */
async function open(sealed: string, key: webcrypto.CryptoKey): Promise<string> {
  const bytes = fromBase64Url(sealed);
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, ivLength), additionalData: credentialInfo },
    key,
    bytes.subarray(ivLength),
  );
  const plaintext = new TextDecoder().decode(opened);
  JSON.parse(plaintext);
  return plaintext;
}

/**
 * redirectOnNotSignedIn runs `fn` and calls `onNotSignedIn`, which throws the framework's redirect, when it fails
 * because the login is over: there was none, it lapsed, or the server refused it and `session` has ended it. Every
 * other failure is rethrown as it was, so that a server error is not a sign-in page.
 */
export async function redirectOnNotSignedIn<T>(
  session: Session,
  fn: () => Promise<T>,
  onNotSignedIn: () => never,
): Promise<T> {
  // A refused refresh (R7) or a second UNAUTHENTICATED (R3) ends the session and rejects with the server's refusal,
  // which an anonymous call refused the same way does too; only the first ended a login.
  const seen = { ended: false };
  const stop = session.onStateChange((state) => {
    seen.ended ||= state === 'anonymous';
  });
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotSignedInError || (seen.ended && isRefusal(err))) {
      onNotSignedIn();
    }
    throw err;
  } finally {
    stop();
  }
}

function isRefusal(err: unknown): boolean {
  return err instanceof PlatformError && (err.code === Code.UNAUTHENTICATED || err.code === Code.PERMISSION_DENIED);
}

export interface ResolveOrRedirectOptions {
  /** isPublic reports whether a path is served with no login, such as the sign-in page itself. */
  isPublic(pathname: string): boolean;
  /** loginPath is where a request with no login is sent. */
  loginPath: string;
}

/**
 * resolveOrRedirect is a request hook's sign-in gate. A public path is resolved as it is. Any other is resolved only
 * once `session` holds a login, and sent to `loginPath` when it holds none; whether that login still works is settled by
 * the first call the page makes, which refreshes it if it has to.
 *
 * A page load that ended the login while it ran (a refresh the server refused, say) is sent to `loginPath` as well,
 * keeping the cookies the response set, since a page that caught its own error would otherwise render signed out. Form
 * posts, data requests and API calls answer as they chose to, and the next page load goes to sign in.
 *
 * It takes and returns the Fetch API's Request and Response, so that it carries no framework with it. In SvelteKit:
 *
 * ```ts
 * export const handle: Handle = ({ event, resolve }) =>
 *   resolveOrRedirect(event.locals.session, event.request, () => resolve(event), { isPublic, loginPath: '/login' });
 * ```
 */
export async function resolveOrRedirect(
  session: Session,
  request: Request,
  resolve: () => Promise<Response>,
  options: ResolveOrRedirectOptions,
): Promise<Response> {
  if (options.isPublic(new URL(request.url).pathname)) {
    return resolve();
  }
  if (!(await session.held())) {
    return toLogin(options.loginPath, []);
  }
  const resolved = await resolve();
  if (isPageLoad(request) && session.state === 'anonymous') {
    return toLogin(options.loginPath, resolved.headers.getSetCookie());
  }
  return resolved;
}

function isPageLoad(request: Request): boolean {
  return request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
}

function toLogin(loginPath: string, cookies: string[]): Response {
  const headers = new Headers({ location: loginPath });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}
