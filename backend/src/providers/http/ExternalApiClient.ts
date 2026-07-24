/**
 * A reusable HTTP client for talking to external APIs (Tesla Fleet, and any
 * manufacturer or third party added later).
 *
 * Each vehicle provider is a Strategy behind the VehicleProviderInterface, resolved by
 * the registry (a Factory), and reached only through the connection service (a Facade).
 * What each provider still needed was a consistent way to make the actual outbound
 * calls — base URL, auth header, timeout, retry, JSON handling, error shaping. That is
 * this client. A provider configures one of these once and calls get/post/… instead of
 * hand-writing fetch, so the transport concerns live in one place rather than being
 * re-implemented per manufacturer.
 *
 * It is the outbound counterpart to the frontend's apiClient, which does the same for
 * calls into our own backend.
 */

export interface ExternalApiClientConfig {
  /** Base URL every request is resolved against, e.g. https://fleet-api.prd.na.vn.cloud.tesla.com */
  baseUrl: string;
  /** Headers sent on every request. Per-request headers override these. */
  defaultHeaders?: Record<string, string>;
  /** Abort a request that takes longer than this. Default 10s. */
  timeoutMs?: number;
  /** How many times to retry a retryable failure before giving up. Default 2. */
  maxRetries?: number;
  /** Status codes worth retrying (transient). Default 429, 500, 502, 503, 504. */
  retryableStatuses?: number[];
  /**
   * Supplies the bearer token for the Authorization header, if the API needs one.
   * Called per request, so a provider can hand back a freshly refreshed token.
   */
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Called once when a request returns 401, before a single retry. A provider uses this
   * to refresh an expired token; if it succeeds, getAuthToken then returns the new one.
   */
  onUnauthorized?: () => Promise<void>;
  /** Injectable fetch, so the client is testable without a network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  /** Query parameters. Undefined/null values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON-serialisable body. Sets Content-Type: application/json automatically. */
  body?: unknown;
  /** Headers for this request only, merged over the defaults. */
  headers?: Record<string, string>;
  /** Caller-supplied cancellation, combined with the client's own timeout. */
  signal?: AbortSignal;
}

/** Thrown when an external API returns a non-2xx response. Carries the detail for logging. */
export class ExternalApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly method: string,
    /** Parsed JSON body if the response was JSON, otherwise the raw text. */
    readonly body: unknown
  ) {
    super(`${method} ${url} failed with ${status}`);
    this.name = "ExternalApiError";
  }
}

/** Thrown when a request exceeds the configured timeout or is aborted. */
export class ExternalApiTimeoutError extends Error {
  constructor(readonly url: string, readonly method: string, readonly timeoutMs: number) {
    super(`${method} ${url} timed out after ${timeoutMs}ms`);
    this.name = "ExternalApiTimeoutError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ExternalApiClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryableStatuses: Set<number>;
  private readonly getAuthToken?: ExternalApiClientConfig["getAuthToken"];
  private readonly onUnauthorized?: ExternalApiClientConfig["onUnauthorized"];
  private readonly fetchImpl: typeof fetch;

  constructor(config: ExternalApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryableStatuses = new Set(config.retryableStatuses ?? [429, 500, 502, 503, 504]);
    this.getAuthToken = config.getAuthToken;
    this.onUnauthorized = config.onUnauthorized;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("ExternalApiClient: no fetch implementation available");
    }
  }

  get<T>(path: string, opts?: Omit<RequestOptions, "body">) {
    return this.request<T>("GET", path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("POST", path, { ...opts, body });
  }
  patch<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  put<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  delete<T>(path: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, opts);
  }

  /**
   * Makes one request, transparently handling auth, timeout, retries and JSON.
   *
   * Retries transient failures (network errors and retryable statuses) with exponential
   * backoff, honouring a Retry-After header when present. A 401 triggers a single token
   * refresh via onUnauthorized, then one more attempt.
   */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    let refreshedOnce = false;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchOnce(method, url, opts);
      } catch (err) {
        // Network/timeout: retry if we have attempts left, otherwise surface it.
        if (err instanceof ExternalApiTimeoutError) throw err;
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }

      if (response.ok) {
        return this.parseBody<T>(response);
      }

      // Expired token: refresh once, then retry immediately without counting an attempt.
      if (response.status === 401 && this.onUnauthorized && !refreshedOnce) {
        refreshedOnce = true;
        await this.onUnauthorized();
        continue;
      }

      // Transient status: back off and retry.
      if (this.retryableStatuses.has(response.status) && attempt < this.maxRetries) {
        await sleep(this.retryDelay(response, attempt));
        continue;
      }

      throw new ExternalApiError(response.status, url, method, await this.safeBody(response));
    }
  }

  private async fetchOnce(method: string, url: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(opts.headers ?? {}) };

    const token = this.getAuthToken ? await this.getAuthToken() : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }

    // The request aborts on our timeout or on the caller's own signal, whichever fires first.
    const timer = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, timer.signal]) : timer.signal;

    // Race the fetch against a hard timeout. The abort cancels the real request when
    // fetch honours the signal (all real implementations do); the race guarantees the
    // timeout resolves even if a given fetch does not.
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timer.abort();
        reject(new ExternalApiTimeoutError(url, method, this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([this.fetchImpl(url, { method, headers, body, signal }), timeoutPromise]);
    } catch (err) {
      if (err instanceof ExternalApiTimeoutError) throw err;
      if (timer.signal.aborted) throw new ExternalApiTimeoutError(url, method, this.timeoutMs);
      throw err; // genuine network error — let request() decide whether to retry
    } finally {
      clearTimeout(timeout!);
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = path.startsWith("http")
      ? path
      : `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  }

  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const text = await response.text();
    if (!text) return undefined as T;
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      return JSON.parse(text) as T;
    }
    return text as unknown as T;
  }

  private async safeBody(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return undefined;
    }
  }

  /** Exponential backoff with jitter: ~250ms, ~500ms, ~1s … capped. */
  private backoff(attempt: number): number {
    return Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 100);
  }

  /** Prefer the server's Retry-After (seconds) on a 429, otherwise normal backoff. */
  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    return this.backoff(attempt);
  }
}

/** Aborts when any of the given signals aborts. (AbortSignal.any is not on every runtime yet.) */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
