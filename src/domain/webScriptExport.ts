import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import { browserScenarioCompletenessSchema } from "./browserScenarioCaptureValues.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";

/** Export already captured scripts into one absent, caller-selected directory. */
export const exportWebScriptsInputSchema = z.strictObject({
  capture_path: z
    .string()
    .min(1)
    .describe(
      "Absolute filesystem path to saved inspect_web_page or capture_browser_scenario JSON, normalized result or complete Evidence",
    ),
  output_directory: z
    .string()
    .min(1)
    .describe(
      "Absolute absent filesystem directory for verified scripts and manifest; parent directory must exist",
    ),
});
export type ExportWebScriptsInput = z.output<
  typeof exportWebScriptsInputSchema
>;

const pageScriptSourceSchema = z.strictObject({
  kind: z.literal("page-script"),
  script_key: z.string().min(1),
  frame_id: z.string().nullable(),
  is_module: z.boolean(),
  language: z.string().nullable(),
  source_map_url: z.string().nullable(),
});

const scenarioResponseSourceSchema = z.strictObject({
  kind: z.literal("scenario-response"),
  transaction_id: z.string().nullable(),
  request_sequence: z.number().int().min(1),
  response_sequence: z.number().int().min(1).nullable(),
  status: z.number().nullable(),
});

/** Source identity of a script retrieved over HTTP, or read from markup, by fetch_web_scripts. */
export const httpFetchSourceSchema = z.strictObject({
  kind: z.literal("http-fetch"),
  discovered_by: z.enum([
    "entry-page",
    "script-src",
    "modulepreload",
    "preload",
    "inline-script",
    "static_import",
    "dynamic_import",
    "require",
  ]),
  referrer_url: z.string().nullable(),
  inline_index: z.number().int().min(0).nullable(),
  fetched_url: z.string().nullable(),
  status: z.number().int().nullable(),
  content_type: z.string().nullable(),
  is_module: z.boolean().nullable(),
});

/** Byte representations retained from browser captures. */
export const CAPTURED_SCRIPT_REPRESENTATIONS = [
  "debugger-source-utf8",
  "browser-decoded-response-bytes",
] as const;

/** Byte representations retained by browserless HTTP fetches. */
export const FETCHED_SCRIPT_REPRESENTATIONS = [
  "http-response-bytes",
  "inline-markup-utf8",
] as const;

const unavailableContentSchema = z.strictObject({
  state: z.literal("unavailable"),
  reason: z.string().min(1),
  message: z.string().min(1),
});

/**
 * Build one tool's exported-script record schema from its own source and
 * representation vocabulary, so each tool advertises only variants it can
 * produce while sharing the publication layout.
 */
export const exportedWebScriptRecordSchema = <
  Source extends z.ZodType,
  const Representation extends readonly [string, ...string[]],
>(
  source: Source,
  representations: Representation,
) =>
  z.strictObject({
    source,
    url: z.string(),
    content: z.discriminatedUnion("state", [
      z.strictObject({
        state: z.literal("exported"),
        relative_path: z.string().min(1),
        layout: z.enum(["url-path", "isolated"]),
        layout_reason: z.string().nullable(),
        sha256: digestSchema,
        bytes: z.number().int().min(0),
        media_type: z.string().nullable(),
        redacted: z.boolean().nullable(),
        representation: z.enum(representations),
      }),
      unavailableContentSchema,
    ]),
  });

/** Exact retained-source identity and publication outcome for captured scripts. */
export const exportedWebScriptSchema = exportedWebScriptRecordSchema(
  z.discriminatedUnion("kind", [
    pageScriptSourceSchema,
    scenarioResponseSourceSchema,
  ]),
  CAPTURED_SCRIPT_REPRESENTATIONS,
);

const anyExportedWebScriptSchema = exportedWebScriptRecordSchema(
  z.discriminatedUnion("kind", [
    pageScriptSourceSchema,
    scenarioResponseSourceSchema,
    httpFetchSourceSchema,
  ]),
  [...CAPTURED_SCRIPT_REPRESENTATIONS, ...FETCHED_SCRIPT_REPRESENTATIONS],
);
/** Any adapter's exported record; each public tool publishes only its own variants. */
export type ExportedWebScript = z.output<typeof anyExportedWebScriptSchema>;

/** Persisted manifest, also returned inline without duplicating script bytes. */
export const webScriptExportManifestSchema = z.strictObject({
  capture_path: z.string().min(1),
  capture_sha256: digestSchema,
  capture_kind: z.enum(["page-inspection", "browser-scenario"]),
  source_evidence_id: prefixedDigestSchema("ev").nullable(),
  capture_completeness: z.union([
    browserCompletenessSchema,
    browserScenarioCompletenessSchema,
  ]),
  output_directory: z.string().min(1),
  analysis_input: z
    .strictObject({
      input_path: z.string().min(1),
      format: z.literal("directory"),
    })
    .nullable(),
  scripts: z.array(exportedWebScriptSchema),
  limitations: z.array(z.string()),
});

/** Verified publication including the digest of the persisted manifest. */
export const webScriptExportResultSchema = webScriptExportManifestSchema.extend(
  {
    manifest: z.strictObject({
      path: z.string().min(1),
      sha256: digestSchema,
      bytes: z.number().int().min(0),
    }),
  },
);
export type WebScriptExportResult = z.output<
  typeof webScriptExportResultSchema
>;

/** Adapter input to the provider-neutral path planner and publisher. */
export interface CapturedWebScript {
  readonly source: ExportedWebScript["source"];
  readonly url: string;
  readonly content:
    | {
        readonly state: "captured";
        readonly bytes: Buffer;
        readonly sha256: string;
        readonly media_type: string | null;
        readonly redacted: boolean | null;
        readonly representation:
          | (typeof CAPTURED_SCRIPT_REPRESENTATIONS)[number]
          | (typeof FETCHED_SCRIPT_REPRESENTATIONS)[number];
      }
    | Extract<ExportedWebScript["content"], { state: "unavailable" }>;
}
