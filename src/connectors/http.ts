/** The fetch shape connectors use, so tests can pass a stub instead of the network. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ConnectorError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}

/** JSON request with a clear error that never includes secrets or full response bodies. */
export async function requestJson<T>(fetchFn: Fetch, url: string, init: RequestInit, what: string): Promise<T | null> {
  const res = await fetchFn(url, init);
  if (res.status === 204) return null;
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ConnectorError(`${what} failed with HTTP ${res.status}: ${detail}`, res.status);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

/**
 * OAuth access token from a long-lived refresh token, cached until shortly
 * before it expires. Used by Gmail and Zoho.
 */
export class RefreshingToken {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly fetchFn: Fetch;
  private readonly tokenUrl: string;
  private readonly params: Record<string, string>;
  private readonly what: string;

  constructor(fetchFn: Fetch, tokenUrl: string, params: Record<string, string>, what: string) {
    this.fetchFn = fetchFn;
    this.tokenUrl = tokenUrl;
    this.params = params;
    this.what = what;
  }

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const body = new URLSearchParams({ ...this.params, grant_type: "refresh_token" });
    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) {
      throw new ConnectorError(`${this.what} sign-in failed (${data.error ?? `HTTP ${res.status}`}). Reconnect the account.`, res.status);
    }
    this.token = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

/** Reads a secret by the environment variable name a pack gives. */
export function secret(env: Record<string, string | undefined>, ref: string, what: string): string {
  const value = env[ref];
  if (!value) throw new ConnectorError(`${what} needs the environment variable ${ref}, which is not set`);
  return value;
}
