// In-memory stand-ins for next/headers and next/navigation (wired in tests/setup.ts).
// A test "is" a browser: `browser.cookies` is its cookie jar, `browser.headers` its request headers.

export const browser = {
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  /** Options of the last cookie the server set (flags check). */
  lastCookieOptions: undefined as Record<string, unknown> | undefined,
  reset() {
    this.cookies.clear();
    this.headers.clear();
    this.lastCookieOptions = undefined;
  },
};

export async function cookies() {
  return {
    get: (name: string) => (browser.cookies.has(name) ? { name, value: browser.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      browser.cookies.set(name, value);
      browser.lastCookieOptions = options;
    },
    delete: (name: string) => void browser.cookies.delete(name),
  };
}

export async function headers() {
  return { get: (name: string) => browser.headers.get(name.toLowerCase()) ?? null };
}

/** What redirect() throws in tests; `to` is the target path. */
export class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect to ${to}`);
  }
}

export function redirect(to: string): never {
  throw new Redirected(to);
}
