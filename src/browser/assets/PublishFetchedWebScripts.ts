import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import type { CapturedWebScript } from "../../domain/webScriptExport.js";
import { planWebScriptExport } from "../../domain/webScriptExportPlan.js";
import {
  webScriptFetchManifestSchema,
  webScriptFetchResultSchema,
  type FetchWebScriptsInput,
  type WebScriptFetchManifest,
  type WebScriptFetchResult,
} from "../../domain/webScriptFetch.js";
import { WebScriptFetchError } from "../../domain/webScriptFetchError.js";
import type { WebArchiveSnapshot } from "../WebArchiveUrl.js";

const LIMITATIONS = [
  "Scripts were fetched over HTTP without a browser, cookies, or credentials. The bytes show what the server sent to this client at fetch time; they do not prove execution, and an authenticated or script-rendered page may load different scripts.",
  "Markup discovery is a conservative scan of <script src>, inline <script>, <link rel=modulepreload>, and <link rel=preload as=script>. Runtime-injected scripts, import maps, and non-literal dynamic import specifiers are not followed; bare specifiers remain unknown.",
  "Ordinary unambiguous URL paths preserve relative module layouts by origin. Query variants, collisions, inline sources, and unrepresentable paths are isolated; their browser module relationships remain unknown.",
  "Local JavaScript analysis does not implement browser import maps, root-relative URL resolution, remote URL loading, or browser runtime behavior. It may strip import queries and fragments; isolated variants are not canonical targets.",
  "No source maps are fetched by this operation; analyze_web_bundle fetches declared source maps from a live page when asked.",
];

/** The fetched page document as retained for publication. */
export interface FetchedPageDocument {
  readonly fetchedUrl: string;
  readonly logicalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Everything collected from the page and its script graph before publication. */
export interface CollectedWebScripts {
  readonly scripts: readonly CapturedWebScript[];
  readonly discovery: WebScriptFetchManifest["discovery"];
  readonly truncatedBy: readonly WebScriptFetchManifest["truncated_by"][number][];
  /** Limitations observed while collecting, such as an entry page that was neither HTML nor JavaScript. */
  readonly limitations: readonly string[];
}

/** Caller selections that the manifest records verbatim. */
export interface FetchPublicationContext {
  readonly input: FetchWebScriptsInput;
  readonly snapshot: WebArchiveSnapshot | null;
  readonly allowedOrigins: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown publication failure";

const boundText = (
  context: FetchPublicationContext,
  bound: WebScriptFetchManifest["truncated_by"][number],
): string =>
  bound === "max_scripts"
    ? `max_scripts (${String(context.input.max_scripts)})`
    : `max_total_bytes (${String(context.input.max_total_bytes)})`;

const limitations = (
  context: FetchPublicationContext,
  collected: CollectedWebScripts,
  exportedAny: boolean,
): readonly string[] => [
  ...LIMITATIONS,
  ...collected.limitations,
  ...(context.snapshot === null
    ? []
    : [
        `Bytes come from an Internet Archive snapshot (${context.snapshot.archive_origin}, timestamp ${context.snapshot.timestamp}). Captures missing from the archive are reported as unavailable, and a snapshot does not represent the site at one single moment.`,
      ]),
  ...(collected.truncatedBy.length === 0
    ? []
    : [
        `Fetching stopped at ${collected.truncatedBy.map((bound) => boundText(context, bound)).join(" and ")}; scripts that were discovered but not fetched are listed as unavailable with reason limit, and the script graph is incomplete.`,
      ]),
  ...(collected.discovery.parse_failures === 0 &&
  collected.discovery.partial_parses === 0
    ? []
    : [
        `${String(collected.discovery.parse_failures)} script(s) could not be parsed and ${String(collected.discovery.partial_parses)} parsed with recovered syntax errors, so imports declared in them may be missing from the graph.`,
      ]),
  ...(exportedAny
    ? []
    : [
        "No script bytes were fetched. The page declared no fetchable scripts within the allowed origins, or every fetch failed; see each script's unavailable reason.",
      ]),
];

/**
 * Publish the page, verified script bytes, and a manifest into the tree the
 * caller created before fetching. The caller owns rollback on failure.
 */
export const publishFetchedWebScripts = async (
  context: FetchPublicationContext,
  tree: SafeOutputTree,
  page: FetchedPageDocument,
  collected: CollectedWebScripts,
): Promise<WebScriptFetchResult> => {
  const planned = planWebScriptExport(collected.scripts);
  context.signal?.throwIfAborted();
  const records = planned.map(({ record }) => record);
  const exportedAny = records.some(
    ({ content }) => content.state === "exported",
  );
  const manifest = webScriptFetchManifestSchema.parse({
    page_url: context.input.page_url,
    page: {
      fetched_url: page.fetchedUrl,
      status: page.status,
      content_type: page.contentType,
      sha256: page.sha256,
      bytes: page.bytes.length,
      relative_path: "page.html",
    },
    archive_snapshot: context.snapshot,
    allowed_origins: context.allowedOrigins,
    follow_imports: context.input.follow_imports,
    output_directory: tree.outputRoot,
    analysis_input: exportedAny
      ? { input_path: join(tree.outputRoot, "files"), format: "directory" }
      : null,
    scripts: records,
    discovery: collected.discovery,
    completeness:
      collected.truncatedBy.length > 0
        ? "truncated"
        : records.some(({ content }) => content.state === "unavailable") ||
            collected.discovery.parse_failures > 0 ||
            collected.discovery.partial_parses > 0
          ? "partial"
          : "complete",
    truncated_by: collected.truncatedBy,
    limitations: limitations(context, collected, exportedAny),
  });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = sha256(bytes);
  const result = webScriptFetchResultSchema.parse({
    ...manifest,
    manifest: {
      path: join(tree.outputRoot, "manifest.json"),
      sha256: digest,
      bytes: bytes.length,
    },
  });
  await tree.write(
    "page.html",
    Readable.from([page.bytes]),
    page.sha256,
    context.signal,
  );
  for (const { script, record } of planned) {
    context.signal?.throwIfAborted();
    if (
      script.content.state === "captured" &&
      record.content.state === "exported"
    )
      await tree.write(
        `files/${record.content.relative_path}`,
        Readable.from([script.content.bytes]),
        script.content.sha256,
        context.signal,
      );
  }
  await tree.write(
    "manifest.json",
    Readable.from([bytes]),
    digest,
    context.signal,
  );
  context.signal?.throwIfAborted();
  await tree.commit();
  return result;
};

/** Remove partial output after a failure, reporting residual paths when cleanup itself fails. */
export const rollbackFetchedWebScripts = async (
  tree: SafeOutputTree,
  cause: unknown,
): Promise<void> => {
  try {
    await tree.rollback();
  } catch (cleanupCause: unknown) {
    throw new WebScriptFetchError(
      "io",
      tree.outputRoot,
      `Fetch failed (${describe(cause)}); rollback failed (${describe(cleanupCause)}). Remove the residual output directory before retrying.`,
      [tree.outputRoot],
    );
  }
};
