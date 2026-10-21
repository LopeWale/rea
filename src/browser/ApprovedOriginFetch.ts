/** Injectable HTTP client seam shared by browserless web fetches. */
export interface ApprovedFetchHost {
  readonly fetch: typeof fetch;
}

/** A terminal response together with the exact URL that produced it, or the hop that policy refused. */
export type ApprovedFetchOutcome =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly fetchedUrl: string;
    }
  | { readonly kind: "refused"; readonly url: string };

/** Policy and transport for one approved fetch. */
export interface ApprovedFetchOptions {
  /** Approves the initial URL and every redirect target before it is requested. */
  readonly approve: (url: string) => boolean;
  readonly accept: string;
  readonly host: ApprovedFetchHost;
  readonly signal?: AbortSignal | undefined;
}

/** Whether a URL is a credential-free HTTP(S) URL on one of the exact origins. */
export const approvedOriginUrl = (
  value: string,
  allowedOrigins: readonly string[],
): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      allowedOrigins.includes(parsed.origin)
    );
  } catch (cause: unknown) {
    // Non-URL input is never approved.
    void cause;
    return false;
  }
};

/** The origin of a URL for diagnostics, never its path, query, or credentials. */
export const originOf = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch (cause: unknown) {
    void cause;
    return "an unparseable URL";
  }
};

/**
 * Fetch one URL without credentials, following redirects manually so that
 * every hop is checked by the approval predicate. A refused initial URL or
 * redirect target is returned as `refused` with that URL, before any request
 * to it. A redirect that revisits a URL throws; no hop ceiling is imposed
 * beyond loop detection.
 */
export const fetchFollowingApprovedRedirects = async (
  initialUrl: string,
  options: ApprovedFetchOptions,
): Promise<ApprovedFetchOutcome> => {
  let current = initialUrl;
  const visited = new Set<string>();
  for (;;) {
    if (!options.approve(current)) return { kind: "refused", url: current };
    if (visited.has(current)) throw new Error("redirect_loop");
    visited.add(current);
    const response = await options.host.fetch(current, {
      method: "GET",
      headers: { Accept: options.accept },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status < 300 || response.status >= 400)
      return { kind: "response", response, fetchedUrl: current };
    const location = response.headers.get("location");
    if (location === null)
      return { kind: "response", response, fetchedUrl: current };
    await discardBody(response);
    current = new URL(location, current).href;
  }
};

/** Release a body that will not be read; an already-errored stream rejects on cancel and is ignored. */
export const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch (cause: unknown) {
    void cause;
  }
};

/** Body bytes read completely, or abandoned once the retained-size limit was exceeded. */
export type BoundedBody =
  | { readonly state: "complete"; readonly bytes: Buffer }
  | { readonly state: "limit"; readonly bytes_read: number };

/** Read a response body while enforcing an exact retained-byte limit. */
export const readBodyWithinLimit = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBody> => {
  if (response.body === null)
    return { state: "complete", bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { state: "limit", bytes_read: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { state: "complete", bytes: Buffer.concat(chunks) };
};
