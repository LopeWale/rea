import { createHash } from "node:crypto";

import type { CapturedWebScript } from "../../domain/webScriptExport.js";
import type { FetchWebScriptsInput } from "../../domain/webScriptFetch.js";
import { WebScriptFetchError } from "../../domain/webScriptFetchError.js";
import {
  approvedOriginUrl,
  discardBody,
  fetchFollowingApprovedRedirects,
  originOf,
  readBodyWithinLimit,
  type ApprovedFetchHost,
  type ApprovedFetchOutcome,
} from "../ApprovedOriginFetch.js";
import {
  unwrapWebArchiveUrl,
  webArchiveRawUrl,
  type WebArchiveSnapshot,
} from "../WebArchiveUrl.js";
import type { FetchedPageDocument } from "./PublishFetchedWebScripts.js";

/** Source identity recorded for every HTTP-fetched or inline script. */
export type HttpFetchSource = Extract<
  CapturedWebScript["source"],
  { kind: "http-fetch" }
>;

/** Caller selections, archive mode, and transport shared across one fetch. */
export interface FetchContext {
  readonly input: FetchWebScriptsInput;
  readonly snapshot: WebArchiveSnapshot | null;
  readonly allowedOrigins: readonly string[];
  readonly host: ApprovedFetchHost;
  readonly signal: AbortSignal | undefined;
}

/** One script URL discovered but not yet fetched. */
export interface PendingScript {
  readonly logicalUrl: string;
  readonly discoveredBy: HttpFetchSource["discovered_by"];
  readonly referrerUrl: string;
  readonly isModule: boolean | null;
}

/** The retained outcome of one script fetch. */
export interface ScriptOutcome {
  readonly script: CapturedWebScript;
  /** Logical URL that served the bytes, used to resolve its relative imports. */
  readonly resolvedUrl: string;
  readonly budgetExhausted: boolean;
}

const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const SCRIPT_ACCEPT = "application/javascript,text/javascript;q=0.9,*/*;q=0.8";
const NO_RESPONSE = { fetchedUrl: null, status: null, contentType: null };

export const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

// undici reports transport failures as a generic "fetch failed" whose
// `cause` carries the actionable detail (DNS, refused connection, TLS).
const describe = (cause: unknown): string => {
  if (!(cause instanceof Error)) return "unknown error";
  const nested = cause.cause;
  return nested instanceof Error && nested.message !== ""
    ? `${cause.message}: ${nested.message}`
    : cause.message;
};

const isTimeout = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "TimeoutError";

const refusalMessage = (
  context: FetchContext,
  outcome: Extract<ApprovedFetchOutcome, { kind: "refused" }>,
): string => {
  const logical = logicalOf(context, outcome.url);
  const origin = originOf(logical ?? outcome.url);
  return context.snapshot !== null && logical === null
    ? `A redirect left the archive for ${origin}; nothing was fetched from it. Archived snapshots are followed only inside ${context.snapshot.archive_origin}.`
    : `A redirect to ${origin} left the allowed origins; nothing was fetched from it. Add that origin to allowed_origins to follow it.`;
};

/** The archived original URL behind a transport URL, or the URL itself when live. */
export const logicalOf = (
  context: FetchContext,
  transportUrl: string,
): string | null =>
  context.snapshot === null
    ? transportUrl
    : unwrapWebArchiveUrl(transportUrl, context.snapshot);

/** The URL actually requested for a logical URL: raw archive bytes when archived. */
export const transportOf = (
  context: FetchContext,
  logicalUrl: string,
): string =>
  context.snapshot === null
    ? logicalUrl
    : webArchiveRawUrl(context.snapshot, logicalUrl);

const approve = (context: FetchContext, transportUrl: string): boolean => {
  const logical = logicalOf(context, transportUrl);
  return logical !== null && approvedOriginUrl(logical, context.allowedOrigins);
};

const fetchOptions = (context: FetchContext, accept: string) => {
  const timeout = AbortSignal.timeout(context.input.request_timeout_ms);
  return {
    approve: (url: string) => approve(context, url),
    accept,
    host: context.host,
    signal:
      context.signal === undefined
        ? timeout
        : AbortSignal.any([context.signal, timeout]),
  };
};

/** Whether a response media type declares JavaScript. */
export const isJavaScriptMediaType = (contentType: string | null): boolean =>
  contentType !== null && /javascript|ecmascript/iu.test(contentType);

/** Whether a response media type declares an HTML document. */
export const isHtmlMediaType = (contentType: string | null): boolean =>
  contentType !== null && /\btext\/html\b|\bxhtml\b/iu.test(contentType);

/** Fetch the page document, failing with a typed error when it is unusable. */
export const fetchPage = async (
  context: FetchContext,
  logicalPageUrl: string,
): Promise<FetchedPageDocument> => {
  const target = context.input.page_url;
  let fetched;
  try {
    fetched = await fetchFollowingApprovedRedirects(
      transportOf(context, logicalPageUrl),
      fetchOptions(context, HTML_ACCEPT),
    );
  } catch (cause: unknown) {
    if (context.signal?.aborted === true) throw cause;
    throw new WebScriptFetchError(
      "unavailable",
      target,
      isTimeout(cause)
        ? `The page did not finish within request_timeout_ms (${String(context.input.request_timeout_ms)}).`
        : `The page could not be fetched (${describe(cause)}).`,
    );
  }
  if (fetched.kind === "refused")
    throw new WebScriptFetchError(
      "unavailable",
      target,
      refusalMessage(context, fetched),
    );
  const { response, fetchedUrl } = fetched;
  if (!response.ok) {
    await discardBody(response);
    throw new WebScriptFetchError(
      "unavailable",
      target,
      `The page server returned HTTP ${String(response.status)}.`,
    );
  }
  let body;
  try {
    body = await readBodyWithinLimit(
      response,
      context.input.max_total_bytes,
      context.signal,
    );
  } catch (cause: unknown) {
    if (context.signal?.aborted === true) throw cause;
    throw new WebScriptFetchError(
      "unavailable",
      target,
      `The page body could not be read (${describe(cause)}).`,
    );
  }
  if (body.state === "limit")
    throw new WebScriptFetchError(
      "limit",
      target,
      `The page alone exceeds max_total_bytes (${String(context.input.max_total_bytes)}).`,
    );
  return {
    fetchedUrl,
    logicalUrl: logicalOf(context, fetchedUrl) ?? logicalPageUrl,
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes: body.bytes,
    sha256: sha256(body.bytes),
  };
};

const httpSource = (
  pending: PendingScript,
  outcome: {
    readonly fetchedUrl: string | null;
    readonly status: number | null;
    readonly contentType: string | null;
  },
): HttpFetchSource => ({
  kind: "http-fetch",
  discovered_by: pending.discoveredBy,
  referrer_url: pending.referrerUrl,
  inline_index: null,
  fetched_url: outcome.fetchedUrl,
  status: outcome.status,
  content_type: outcome.contentType,
  is_module: pending.isModule,
});

const unavailable = (
  pending: PendingScript,
  source: HttpFetchSource,
  reason: string,
  message: string,
): ScriptOutcome => ({
  script: {
    source,
    url: pending.logicalUrl,
    content: { state: "unavailable", reason, message },
  },
  resolvedUrl: pending.logicalUrl,
  budgetExhausted: reason === "limit",
});

/** Markup, not JavaScript: the first non-blank byte opens a tag. */
const looksLikeMarkup = (bytes: Buffer): boolean =>
  /^\s*</u.test(bytes.subarray(0, 512).toString("utf8"));

/** Fetch one script within the remaining byte budget, never throwing for HTTP or transport failures. */
export const fetchScript = async (
  context: FetchContext,
  pending: PendingScript,
  budget: number,
): Promise<ScriptOutcome> => {
  if (budget <= 0)
    return unavailable(
      pending,
      httpSource(pending, NO_RESPONSE),
      "limit",
      "The max_total_bytes budget was exhausted before this script was fetched.",
    );
  let fetched;
  try {
    fetched = await fetchFollowingApprovedRedirects(
      transportOf(context, pending.logicalUrl),
      fetchOptions(context, SCRIPT_ACCEPT),
    );
  } catch (cause: unknown) {
    if (context.signal?.aborted === true) throw cause;
    return unavailable(
      pending,
      httpSource(pending, NO_RESPONSE),
      isTimeout(cause) ? "timeout" : "fetch_failed",
      isTimeout(cause)
        ? `The script did not finish within request_timeout_ms (${String(context.input.request_timeout_ms)}).`
        : `The script could not be fetched (${describe(cause)}).`,
    );
  }
  if (fetched.kind === "refused")
    return unavailable(
      pending,
      httpSource(pending, NO_RESPONSE),
      "policy_filtered",
      refusalMessage(context, fetched),
    );
  const { response, fetchedUrl } = fetched;
  const contentType = response.headers.get("content-type");
  const source = httpSource(pending, {
    fetchedUrl,
    status: response.status,
    contentType,
  });
  if (!response.ok) {
    await discardBody(response);
    return unavailable(
      pending,
      source,
      "http_status",
      `The script server returned HTTP ${String(response.status)}.`,
    );
  }
  const body = await readScriptBody(context, response, budget, {
    pending,
    source,
  });
  if (!Buffer.isBuffer(body)) return body;
  return {
    resolvedUrl: logicalOf(context, fetchedUrl) ?? pending.logicalUrl,
    budgetExhausted: false,
    script: {
      source,
      url: pending.logicalUrl,
      content: {
        state: "captured",
        bytes: body,
        sha256: sha256(body),
        media_type: contentType,
        redacted: false,
        representation: "http-response-bytes",
      },
    },
  };
};

/** Read a script body within budget, returning an unavailable outcome instead of throwing for transport or content failures. */
const readScriptBody = async (
  context: FetchContext,
  response: Response,
  budget: number,
  record: { readonly pending: PendingScript; readonly source: HttpFetchSource },
): Promise<Buffer | ScriptOutcome> => {
  const { pending, source } = record;
  let body;
  try {
    body = await readBodyWithinLimit(response, budget, context.signal);
  } catch (cause: unknown) {
    if (context.signal?.aborted === true) throw cause;
    return unavailable(
      pending,
      source,
      isTimeout(cause) ? "timeout" : "fetch_failed",
      isTimeout(cause)
        ? `The script body did not finish within request_timeout_ms (${String(context.input.request_timeout_ms)}).`
        : `The script body could not be read (${describe(cause)}).`,
    );
  }
  if (body.state === "limit")
    return unavailable(
      pending,
      source,
      "limit",
      `Reading this script would exceed the remaining max_total_bytes budget (${String(budget)} bytes left).`,
    );
  if (looksLikeMarkup(body.bytes))
    return unavailable(
      pending,
      source,
      "not_javascript",
      `The script URL returned markup (content type ${source.content_type ?? "unknown"}), as single-page servers do for missing assets; it was not exported as JavaScript.`,
    );
  return body.bytes;
};
