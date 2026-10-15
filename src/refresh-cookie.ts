import { IssuedToken } from './generated/primandproper/platform/signin/v1/signin';
import type { CredentialStore } from './seams';

/**
 * HintStorage is where a refresh-cookie store keeps what it may: Web Storage's shape, and an asynchronous one such as
 * React Native's AsyncStorage fits it too.
 */
export interface HintStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface RefreshCookieCredentialStoreConfig {
  /** hints defaults to `localStorage`, which every tab of the origin shares. */
  hints?: HintStorage;
  /** key names the hint in `hints`. */
  key?: string;
}

const defaultHintKey = 'primandproper-platform-client:refresh-token-expires-at';

/**
 * refreshCookieCredentialStore is the CredentialStore for a browser talking to a platform-go server over gRPC-web from
 * v15.2.0, which keeps the refresh token in an httpOnly cookie page code cannot read and answers every sign-in with the
 * body's `refresh_token` empty.
 *
 * The access token lives in memory only, so a reload starts with none. What persists is `refresh_token_expires_at`, a
 * hint that a cookie should still exist, which is not a credential: after a reload `load` answers a session holding
 * nothing but that expiry, and `Session`'s first call exchanges the cookie for an access token. A cookie that has since
 * expired, been rotated by another device or revoked is refused, and the session lands signed out.
 *
 * Losing the hint, because the storage refused a write or was cleared, costs only that resume: the next reload is
 * signed out, and a sign-in writes it again. So a failing `hints` never fails a sign-in or a sign-out.
 */
export function refreshCookieCredentialStore(config: RefreshCookieCredentialStoreConfig = {}): CredentialStore {
  const hints = config.hints ?? (globalThis as { localStorage?: HintStorage }).localStorage;
  if (!hints) {
    throw new Error('refreshCookieCredentialStore needs hints: there is no localStorage here');
  }
  const key = config.key ?? defaultHintKey;
  let current: IssuedToken | undefined;

  return {
    refreshTokenInCookie: true,
    async load() {
      if (current) {
        return current;
      }
      let hint: string | null;
      try {
        hint = await hints.getItem(key);
      } catch {
        return undefined;
      }
      const expiresAt = hint ? new Date(hint) : undefined;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        return undefined;
      }
      return IssuedToken.fromPartial({ refreshTokenExpiresAt: expiresAt });
    },
    async save(token) {
      current = token;
      try {
        // A token carrying its own refresh token came from a server that set no cookie, so there is nothing to resume.
        if (!token.refreshToken && token.refreshTokenExpiresAt) {
          await hints.setItem(key, token.refreshTokenExpiresAt.toISOString());
        } else {
          await hints.removeItem(key);
        }
      } catch {
        // See above: the hint is a convenience.
      }
    },
    async clear() {
      current = undefined;
      try {
        await hints.removeItem(key);
      } catch {
        // A hint left behind sends one exchange the server refuses, and the session lands signed out.
      }
    },
  };
}

/**
 * ExchangeLock serializes every RPC that spends a refresh-token cookie across everything sharing that cookie. Two tabs
 * presenting one cookie at once are reuse, and the server ends the login (R1). Holding the lock until the response, and
 * the `Set-Cookie` in it, has arrived means the next holder presents the successor's cookie instead, and gets a
 * successor of its own.
 */
export interface ExchangeLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

interface LockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

const lockName = 'primandproper-platform-client:refresh-token-cookie';

/** processExchangeLock serializes a JavaScript context's own exchanges, for one with no Web Locks API. */
const processExchangeLock: ExchangeLock = (() => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
})();

/**
 * defaultExchangeLock is the Web Locks API where there is one, which every tab and worker of the origin shares, and the
 * context's own lock otherwise. Without Web Locks (React Native, say) two contexts sharing a cookie jar can still race.
 */
export function defaultExchangeLock(): ExchangeLock {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) {
    return processExchangeLock;
  }
  return { run: (fn) => locks.request(lockName, fn) };
}
