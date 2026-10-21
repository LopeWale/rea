import { AnyMap, eachMapping } from "@jridgewell/trace-mapping";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { isUrlLikeModuleSpecifier } from "../domain/webBundleAnalyzerAst.js";
import { scanModuleDependencies } from "../domain/javascriptModuleDependencies.js";
import { parseJavaScriptSource } from "../domain/javascriptSourceParser.js";
import { hasValidSourceMapContents } from "../domain/sourceMapContents.js";
import {
  approvedOriginUrl,
  fetchFollowingApprovedRedirects,
  type ApprovedFetchHost,
} from "./ApprovedOriginFetch.js";
import type {
  AnalyzeWebBundleInput,
  WebSourceMapItem,
  WebSourceMaps,
} from "../domain/webBundleAnalysis.js";
import { webSourceMapsSchema } from "../domain/webBundleAnalysis.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import { safeParseJson } from "../domain/safeJson.js";

export interface WebSourceMapRequest {
  readonly scriptKey: string;
  readonly declaredUrl: string;
  readonly fetchUrl: string;
}

type SourceMapFetchHost = ApprovedFetchHost;

type SourceMaps = WebSourceMaps;
type SourceMapItem = WebSourceMapItem;
type ParsedSourceMapItem = Extract<
  SourceMapItem,
  { status: "included" | "partial" }
>;

/** Fetch and validate approved source maps without browser credentials. */
export const fetchWebSourceMaps = async (
  requests: readonly WebSourceMapRequest[],
  input: AnalyzeWebBundleInput,
  signal?: AbortSignal,
  host: SourceMapFetchHost = { fetch: globalThis.fetch },
): Promise<SourceMaps> => {
  const items: SourceMapItem[] = [];
  for (const request of requests) {
    if (signal?.aborted === true) throw signal.reason;
    items.push(await fetchOne(request, input, signal, host));
  }
  const retained = items.filter(
    ({ status }) => status === "included" || status === "partial",
  ).length;
  return webSourceMapsSchema.parse({
    status:
      items.length === 0
        ? "unavailable"
        : retained === items.length &&
            !items.some(({ status }) => status === "partial")
          ? "included"
          : retained > 0
            ? "partial"
            : "unavailable",
    requested: requests.length,
    processed: items.length,
    items,
  });
};

const fetchOne = async (
  request: WebSourceMapRequest,
  input: AnalyzeWebBundleInput,
  signal: AbortSignal | undefined,
  host: SourceMapFetchHost,
): Promise<SourceMapItem> => {
  if (!approvedOriginUrl(request.fetchUrl, input.allowed_origins))
    return emptySourceMapItem(
      request,
      "policy_filtered",
      "Declared source-map URL is outside the approved exact origins.",
    );
  try {
    const fetched = await fetchFollowingApprovedRedirects(request.fetchUrl, {
      approve: (url) => approvedOriginUrl(url, input.allowed_origins),
      accept: "application/json, application/source-map+json;q=0.9",
      host,
      signal,
    });
    if (fetched.kind === "refused")
      return emptySourceMapItem(
        request,
        "policy_filtered",
        "A source-map redirect left the approved exact origins.",
      );
    const { response, fetchedUrl } = fetched;
    if (!response.ok) {
      await response.body?.cancel();
      return emptySourceMapItem(
        request,
        "fetch_failed",
        `Source-map server returned HTTP ${String(response.status)}.`,
      );
    }
    return normalizeSourceMap(request, await response.text(), fetchedUrl);
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    return emptySourceMapItem(
      request,
      "fetch_failed",
      "Source-map fetch or validation failed.",
    );
  }
};

const normalizeSourceMap = (
  request: WebSourceMapRequest,
  text: string,
  fetchedUrl: string,
): SourceMapItem => {
  if (!validSourceMapEnvelope(text))
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map JSON is not a version 3 map.",
    );
  try {
    const map = new AnyMap(text, fetchedUrl);
    const resolvedBySource = new Map<string, string>();
    const originalSources = map.sources.map((source, index) => {
      const content = map.sourcesContent?.[index];
      const resolved =
        map.resolvedSources[index] ?? source ?? "[unknown-source]";
      if (source !== null) resolvedBySource.set(source, resolved);
      return {
        source: sanitizeSource(resolved),
        artifact:
          typeof content === "string"
            ? createWebTextArtifact(content, sourceMediaType(source))
            : null,
      };
    });
    const mappings: ParsedSourceMapItem["mappings"] = [];
    eachMapping(map, (mapping) => {
      if (
        mapping.source === null ||
        mapping.originalLine === null ||
        mapping.originalColumn === null
      )
        return;
      mappings.push({
        generated_line: mapping.generatedLine,
        generated_column: mapping.generatedColumn,
        source: sanitizeSource(
          resolvedBySource.get(mapping.source) ?? mapping.source,
        ),
        original_line: mapping.originalLine,
        original_column: mapping.originalColumn,
        name: mapping.name ?? null,
      });
    });
    const modules = originalModuleEdges(originalSources);
    const parsed = {
      ...sourceMapContext(request),
      artifact: createWebTextArtifact(text, "application/source-map+json"),
      original_sources: originalSources,
      original_module_edges: modules.edges,
      mappings,
    };
    return modules.incomplete.length === 0
      ? { ...parsed, status: "included", limitation: null }
      : {
          ...parsed,
          status: "partial",
          limitation: `Module edges are incomplete: ${modules.incomplete.length} of ${originalSources.filter(({ artifact }) => artifact !== null).length} original sources could not be parsed in full (${modules.incomplete.join(", ")}).`,
        };
  } catch (cause: unknown) {
    void cause;
    return emptySourceMapItem(
      request,
      "invalid",
      "Source-map mappings could not be decoded safely.",
    );
  }
};

interface OriginalModuleEdges {
  readonly edges: ParsedSourceMapItem["original_module_edges"];
  /** Original sources whose dependency edges may be incomplete. */
  readonly incomplete: readonly string[];
}

const originalModuleEdges = (
  sources: ParsedSourceMapItem["original_sources"],
): OriginalModuleEdges => {
  const edges: ParsedSourceMapItem["original_module_edges"] = [];
  const seen = new Set<string>();
  const incomplete: string[] = [];
  for (const source of sources) {
    if (source.artifact === null) continue;
    const parsed = parseJavaScriptSource(source.artifact.text);
    if (parsed === null) {
      incomplete.push(source.source);
      continue;
    }
    const scan = scanModuleDependencies(parsed);
    // A recovered program still yields the imports it did parse, but nodes
    // after an unrecoverable point are missing, so the edges are a subset.
    if (!scan.complete) incomplete.push(source.source);
    for (const { kind, specifier } of scan.dependencies) {
      const key = `${source.source}\0${kind}\0${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from_source: source.source,
        kind,
        specifier,
        resolved_source: resolveOriginalSource(specifier, source.source),
      });
    }
  }
  return { edges, incomplete };
};

const validSourceMapEnvelope = (text: string): boolean => {
  const parsedResult = safeParseJson(text);
  if (!parsedResult.ok) return false;
  const parsed: unknown = parsedResult.value;
  if (!isRecord(parsed) || parsed.version !== 3) return false;
  if (typeof parsed.mappings === "string") return validSourceMapLeaf(parsed);
  if (!Array.isArray(parsed.sections)) return false;
  const pending: unknown[] = [...parsed.sections];
  while (pending.length > 0) {
    const section = pending.pop();
    if (
      !isRecord(section) ||
      !isRecord(section.offset) ||
      !validSourceMapOffset(section.offset.line) ||
      !validSourceMapOffset(section.offset.column) ||
      !("map" in section)
    )
      return false;
    const map = section.map;
    if (!isRecord(map) || map.version !== 3) return false;
    if (Array.isArray(map.sections))
      for (const child of map.sections) pending.push(child);
    else if (!validSourceMapLeaf(map)) return false;
  }
  return true;
};

const validSourceMapOffset = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validSourceMapLeaf = (map: Readonly<Record<string, unknown>>): boolean =>
  typeof map.mappings === "string" &&
  Array.isArray(map.sources) &&
  Array.isArray(map.names) &&
  hasValidSourceMapContents(map.sources.length, map.sourcesContent);

const sourceMapContext = (request: WebSourceMapRequest) => ({
  script_key: request.scriptKey,
  declared_url: request.declaredUrl,
});

const emptySourceMapItem = (
  request: WebSourceMapRequest,
  status: Extract<SourceMapItem, { readonly artifact: null }>["status"],
  limitation: string,
): Extract<SourceMapItem, { readonly artifact: null }> => ({
  ...sourceMapContext(request),
  status,
  artifact: null,
  original_sources: [],
  original_module_edges: [],
  mappings: [],
  limitation,
});

const sanitizeSource = (value: string): string => {
  try {
    return sanitizeBrowserUrl(new URL(value).href).url;
  } catch (cause: unknown) {
    // Non-URL sources are preserved verbatim.
    void cause;
    return value;
  }
};

const resolveOriginalSource = (
  specifier: string,
  base: string,
): string | null => {
  if (!isUrlLikeModuleSpecifier(specifier)) return null;
  try {
    return sanitizeSource(new URL(specifier, base).href);
  } catch (cause: unknown) {
    // Unresolvable source specifiers are represented by null.
    void cause;
    return null;
  }
};

const sourceMediaType = (source: string | null): string =>
  source?.endsWith(".ts") || source?.endsWith(".tsx")
    ? "text/typescript"
    : "text/javascript";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
