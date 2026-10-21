import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  discoverHtmlScripts,
  type HtmlScriptDiscovery,
} from "../../domain/htmlScriptDiscovery.js";
import { scanModuleDependencies } from "../../domain/javascriptModuleDependencies.js";
import { parseJavaScriptSource } from "../../domain/javascriptSourceParser.js";
import { isUrlLikeModuleSpecifier } from "../../domain/webBundleAnalyzerAst.js";
import type { CapturedWebScript } from "../../domain/webScriptExport.js";
import type {
  FetchWebScriptsInput,
  WebScriptFetchManifest,
  WebScriptFetchResult,
} from "../../domain/webScriptFetch.js";
import { WebScriptFetchError } from "../../domain/webScriptFetchError.js";
import {
  approvedOriginUrl,
  type ApprovedFetchHost,
} from "../ApprovedOriginFetch.js";
import { parseWebArchiveUrl } from "../WebArchiveUrl.js";
import {
  fetchPage,
  fetchScript,
  isHtmlMediaType,
  isJavaScriptMediaType,
  sha256,
  type FetchContext,
  type PendingScript,
} from "./FetchWebScriptResources.js";
import {
  publishFetchedWebScripts,
  rollbackFetchedWebScripts,
  type CollectedWebScripts,
  type FetchedPageDocument,
} from "./PublishFetchedWebScripts.js";

type UnresolvedSpecifier =
  WebScriptFetchManifest["discovery"]["unresolved_specifiers"][number];
type TruncationBound = WebScriptFetchManifest["truncated_by"][number];

/** Mutable bookkeeping for one bounded breadth-first script collection. */
interface CollectionState {
  readonly scripts: CapturedWebScript[];
  readonly queue: PendingScript[];
  readonly queued: Set<string>;
  readonly unresolved: UnresolvedSpecifier[];
  readonly skippedMarkup: { reason: string; detail: string }[];
  readonly truncatedBy: Set<TruncationBound>;
  readonly limitations: string[];
  scriptTags: number;
  modulepreloadLinks: number;
  preloadLinks: number;
  inlineScripts: number;
  importSpecifiers: number;
  parseFailures: number;
  partialParses: number;
  budget: number;
  fetchedCount: number;
}

/** Text whose literal module dependencies should be queued. */
interface DependencySource {
  readonly text: string;
  readonly baseUrl: string;
  readonly referrerUrl: string;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};

/**
 * Fetch one page's script graph over HTTP and publish it for static analysis.
 * The output directory is claimed before any request so a conflicting path
 * fails fast, and partial output is rolled back on any failure.
 */
export const fetchWebScriptArtifacts = async (
  input: FetchWebScriptsInput,
  host: ApprovedFetchHost,
  signal?: AbortSignal,
): Promise<WebScriptFetchResult> => {
  const snapshot = parseWebArchiveUrl(input.page_url);
  const logicalPageUrl = snapshot?.original_url ?? input.page_url;
  if (!isHttpUrl(logicalPageUrl))
    throw new WebScriptFetchError(
      "format",
      input.page_url,
      "page_url must be an absolute http(s) URL or a web.archive.org snapshot of one.",
    );
  const context: FetchContext = {
    input,
    snapshot,
    allowedOrigins: input.allowed_origins ?? [new URL(logicalPageUrl).origin],
    host,
    signal,
  };
  const tree = await SafeOutputTree.create(input.output_directory);
  try {
    signal?.throwIfAborted();
    const page = await fetchPage(context, logicalPageUrl);
    const collected = await collectScripts(context, page);
    return await publishFetchedWebScripts(context, tree, page, collected);
  } catch (cause: unknown) {
    await rollbackFetchedWebScripts(tree, cause);
    throw cause;
  }
};

const collectScripts = async (
  context: FetchContext,
  page: FetchedPageDocument,
): Promise<CollectedWebScripts> => {
  const state: CollectionState = {
    scripts: [],
    queue: [],
    queued: new Set(),
    unresolved: [],
    skippedMarkup: [],
    truncatedBy: new Set(),
    limitations: [],
    scriptTags: 0,
    modulepreloadLinks: 0,
    preloadLinks: 0,
    inlineScripts: 0,
    importSpecifiers: 0,
    parseFailures: 0,
    partialParses: 0,
    budget: context.input.max_total_bytes - page.bytes.length,
    fetchedCount: 0,
  };
  seedFromPage(context, page, state);
  await drainQueue(context, state);
  return {
    scripts: state.scripts,
    discovery: {
      script_tags: state.scriptTags,
      modulepreload_links: state.modulepreloadLinks,
      preload_links: state.preloadLinks,
      inline_scripts: state.inlineScripts,
      import_specifiers: state.importSpecifiers,
      parse_failures: state.parseFailures,
      partial_parses: state.partialParses,
      skipped_markup: state.skippedMarkup,
      unresolved_specifiers: state.unresolved,
    },
    truncatedBy: [...state.truncatedBy],
    limitations: state.limitations,
  };
};

const enqueue = (state: CollectionState, pending: PendingScript): void => {
  if (state.queued.has(pending.logicalUrl)) return;
  state.queued.add(pending.logicalUrl);
  state.queue.push(pending);
};

const seedFromPage = (
  context: FetchContext,
  page: FetchedPageDocument,
  state: CollectionState,
): void => {
  if (isJavaScriptMediaType(page.contentType)) {
    state.queued.add(page.logicalUrl);
    state.scripts.push({
      source: {
        kind: "http-fetch",
        discovered_by: "entry-page",
        referrer_url: null,
        inline_index: null,
        fetched_url: page.fetchedUrl,
        status: page.status,
        content_type: page.contentType,
        is_module: null,
      },
      url: page.logicalUrl,
      content: {
        state: "captured",
        bytes: page.bytes,
        sha256: page.sha256,
        media_type: page.contentType,
        redacted: false,
        representation: "http-response-bytes",
      },
    });
    queueDependencies(context, state, {
      text: page.bytes.toString("utf8"),
      baseUrl: page.logicalUrl,
      referrerUrl: page.logicalUrl,
    });
    return;
  }
  if (page.contentType !== null && !isHtmlMediaType(page.contentType))
    state.limitations.push(
      `The page responded with content type ${page.contentType}, which is neither HTML nor JavaScript; it was scanned as HTML markup and may declare no scripts.`,
    );
  const html = discoverHtmlScripts(
    page.bytes.toString("utf8"),
    page.logicalUrl,
  );
  recordMarkup(context, page, html, state);
  for (const inline of html.inline)
    queueDependencies(context, state, {
      text: inline.text,
      baseUrl: html.base_url,
      referrerUrl: page.logicalUrl,
    });
};

const countMarkupReference = (
  state: CollectionState,
  kind: HtmlScriptDiscovery["external"][number]["discovered_by"],
): void => {
  if (kind === "script-src") state.scriptTags += 1;
  else if (kind === "modulepreload") state.modulepreloadLinks += 1;
  else state.preloadLinks += 1;
};

const recordMarkup = (
  context: FetchContext,
  page: FetchedPageDocument,
  html: HtmlScriptDiscovery,
  state: CollectionState,
): void => {
  for (const skipped of html.skipped)
    state.skippedMarkup.push({
      reason: skipped.reason,
      detail: skipped.detail,
    });
  for (const external of html.external) {
    countMarkupReference(state, external.discovered_by);
    // Markup URLs are plain URLs relative to the document base (HTML
    // "prepare the script element"), not module specifiers, so a path-relative
    // `src="app.js"` is valid here even though it would be bare as an import.
    const resolution = resolveUrl(context, external.specifier, html.base_url);
    if (resolution.ok)
      enqueue(state, {
        logicalUrl: resolution.url,
        discoveredBy: external.discovered_by,
        referrerUrl: page.logicalUrl,
        isModule: external.is_module,
      });
    else
      state.unresolved.push({
        referrer_url: page.logicalUrl,
        specifier: redactSpecifier(external.specifier),
        reason: resolution.reason,
      });
  }
  for (const inline of html.inline) {
    state.inlineScripts += 1;
    const bytes = Buffer.from(inline.text, "utf8");
    state.scripts.push({
      source: {
        kind: "http-fetch",
        discovered_by: "inline-script",
        referrer_url: page.logicalUrl,
        inline_index: inline.index,
        fetched_url: null,
        status: null,
        content_type: null,
        is_module: inline.is_module,
      },
      url: "",
      content: {
        state: "captured",
        bytes,
        sha256: sha256(bytes),
        media_type: "text/javascript",
        redacted: false,
        representation: "inline-markup-utf8",
      },
    });
  }
};

const queueDependencies = (
  context: FetchContext,
  state: CollectionState,
  source: DependencySource,
): void => {
  if (!context.input.follow_imports) return;
  const parsed = parseJavaScriptSource(source.text);
  if (parsed === null) {
    state.parseFailures += 1;
    return;
  }
  const scan = scanModuleDependencies(parsed);
  if (!scan.complete) state.partialParses += 1;
  for (const dependency of scan.dependencies) {
    state.importSpecifiers += 1;
    if (!isUrlLikeModuleSpecifier(dependency.specifier)) {
      state.unresolved.push({
        referrer_url: source.referrerUrl,
        specifier: redactSpecifier(dependency.specifier),
        reason: "bare_specifier",
      });
      continue;
    }
    const resolution = resolveUrl(
      context,
      dependency.specifier,
      source.baseUrl,
    );
    if (resolution.ok)
      enqueue(state, {
        logicalUrl: resolution.url,
        discoveredBy: dependency.kind,
        referrerUrl: source.referrerUrl,
        isModule: dependency.kind !== "require",
      });
    else
      state.unresolved.push({
        referrer_url: source.referrerUrl,
        specifier: redactSpecifier(dependency.specifier),
        reason: resolution.reason,
      });
  }
};

type UrlResolution =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: Exclude<UnresolvedSpecifier["reason"], "bare_specifier">;
    };

const resolveUrl = (
  context: FetchContext,
  specifier: string,
  baseUrl: string,
): UrlResolution => {
  let resolved: URL;
  try {
    resolved = new URL(specifier, baseUrl);
  } catch (cause: unknown) {
    void cause;
    return { ok: false, reason: "unresolvable" };
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
    return { ok: false, reason: "unsupported_scheme" };
  if (resolved.username !== "" || resolved.password !== "")
    return { ok: false, reason: "embedded_credentials" };
  resolved.hash = "";
  if (!approvedOriginUrl(resolved.href, context.allowedOrigins))
    return { ok: false, reason: "outside_allowed_origins" };
  return { ok: true, url: resolved.href };
};

/** Never echo credentials that a page embedded in a URL. */
const redactSpecifier = (specifier: string): string =>
  specifier.replace(/\/\/[^/@\s]+@/u, "//[redacted]@");

const drainQueue = async (
  context: FetchContext,
  state: CollectionState,
): Promise<void> => {
  while (state.queue.length > 0) {
    context.signal?.throwIfAborted();
    if (state.fetchedCount >= context.input.max_scripts) {
      state.truncatedBy.add("max_scripts");
      for (const pending of state.queue.splice(0))
        state.scripts.push({
          source: {
            kind: "http-fetch",
            discovered_by: pending.discoveredBy,
            referrer_url: pending.referrerUrl,
            inline_index: null,
            fetched_url: null,
            status: null,
            content_type: null,
            is_module: pending.isModule,
          },
          url: pending.logicalUrl,
          content: {
            state: "unavailable",
            reason: "limit",
            message: `max_scripts (${String(context.input.max_scripts)}) was reached before this script was fetched.`,
          },
        });
      return;
    }
    const pending = state.queue.shift();
    if (pending === undefined) return;
    state.fetchedCount += 1;
    const outcome = await fetchScript(context, pending, state.budget);
    state.scripts.push(outcome.script);
    if (outcome.script.content.state === "captured") {
      state.budget -= outcome.script.content.bytes.length;
      queueDependencies(context, state, {
        text: outcome.script.content.bytes.toString("utf8"),
        baseUrl: outcome.resolvedUrl,
        referrerUrl: pending.logicalUrl,
      });
    }
    if (outcome.budgetExhausted) state.truncatedBy.add("max_total_bytes");
  }
};
