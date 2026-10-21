import { z } from "zod";

import { browserOriginSchema } from "./browserObservation.js";
import { digestSchema } from "./digests.js";
import {
  exportedWebScriptRecordSchema,
  FETCHED_SCRIPT_REPRESENTATIONS,
  httpFetchSourceSchema,
} from "./webScriptExport.js";

/** Default and maximum bounds for one browserless script fetch. */
export const WEB_SCRIPT_FETCH_DEFAULTS = {
  max_scripts: 200,
  max_total_bytes: 64 * 1024 * 1024,
  max_total_bytes_ceiling: 1024 * 1024 * 1024,
  request_timeout_ms: 15_000,
} as const;

/** Fetch one page's script graph over HTTP into one absent, caller-selected directory. */
export const fetchWebScriptsInputSchema = z.strictObject({
  page_url: z
    .string()
    .min(1)
    .describe(
      "Absolute http(s) URL of the page whose scripts to fetch, or a web.archive.org Wayback snapshot URL of that page (archived bytes are fetched unmodified). Embedded credentials are rejected",
    ),
  output_directory: z
    .string()
    .min(1)
    .describe(
      "Absolute absent filesystem directory for page.html, verified scripts, and manifest; parent directory must exist",
    ),
  allowed_origins: z
    .array(browserOriginSchema)
    .min(1)
    .optional()
    .describe(
      "Exact HTTP(S) origins whose scripts may be fetched; must include the page's own origin. Defaults to the page's origin. For archive snapshots this applies to the archived original URLs, not the archive host",
    ),
  follow_imports: z
    .boolean()
    .default(true)
    .describe(
      "Parse fetched and inline scripts for literal import, dynamic import(), and unbound require specifiers and fetch the resolvable ones within allowed origins",
    ),
  max_scripts: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.max_scripts)
    .describe(
      "Maximum number of scripts to fetch; the rest are reported as unavailable with reason limit",
    ),
  max_total_bytes: z
    .number()
    .int()
    .min(1024)
    .max(WEB_SCRIPT_FETCH_DEFAULTS.max_total_bytes_ceiling)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.max_total_bytes)
    .describe("Maximum total page and script bytes to retain"),
  request_timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.request_timeout_ms)
    .describe(
      "Timeout in milliseconds for each request (the page and every script), covering its redirects and body; a timed-out script is reported as unavailable and a timed-out page fails the operation",
    ),
});
export type FetchWebScriptsInput = z.output<typeof fetchWebScriptsInputSchema>;

/** Publication record for one fetched or inline script. */
export const fetchedWebScriptSchema = exportedWebScriptRecordSchema(
  httpFetchSourceSchema,
  FETCHED_SCRIPT_REPRESENTATIONS,
);

/** Markup and module-graph discovery counts with every skipped or unresolved reference. */
export const webScriptFetchDiscoverySchema = z.strictObject({
  script_tags: z.number().int().min(0),
  modulepreload_links: z.number().int().min(0),
  preload_links: z.number().int().min(0),
  inline_scripts: z.number().int().min(0),
  import_specifiers: z.number().int().min(0),
  parse_failures: z
    .number()
    .int()
    .min(0)
    .describe("Scripts that could not be parsed, so their imports are unknown"),
  partial_parses: z
    .number()
    .int()
    .min(0)
    .describe(
      "Scripts parsed with recovered syntax errors, so their import lists may be incomplete",
    ),
  skipped_markup: z.array(
    z.strictObject({ reason: z.string().min(1), detail: z.string() }),
  ),
  unresolved_specifiers: z.array(
    z.strictObject({
      referrer_url: z.string(),
      specifier: z.string(),
      reason: z.enum([
        "bare_specifier",
        "outside_allowed_origins",
        "unsupported_scheme",
        "embedded_credentials",
        "unresolvable",
      ]),
    }),
  ),
});

/** Persisted manifest, also returned inline without duplicating script bytes. */
export const webScriptFetchManifestSchema = z.strictObject({
  page_url: z.string().min(1),
  page: z.strictObject({
    fetched_url: z.string().min(1),
    status: z.number().int(),
    content_type: z.string().nullable(),
    sha256: digestSchema,
    bytes: z.number().int().min(0),
    relative_path: z.literal("page.html"),
  }),
  archive_snapshot: z
    .strictObject({
      archive_origin: z.string().min(1),
      timestamp: z.string().min(1),
      original_url: z.string().min(1),
    })
    .nullable(),
  allowed_origins: z.array(z.string().min(1)),
  follow_imports: z.boolean(),
  output_directory: z.string().min(1),
  analysis_input: z
    .strictObject({
      input_path: z.string().min(1),
      format: z.literal("directory"),
    })
    .nullable(),
  scripts: z.array(fetchedWebScriptSchema),
  discovery: webScriptFetchDiscoverySchema,
  /**
   * complete: every discovered script was fetched and parsed. partial: some
   * script is unavailable or could not be fully parsed. truncated: a caller
   * bound stopped the walk (see truncated_by); it takes precedence.
   */
  completeness: z.enum(["complete", "partial", "truncated"]),
  truncated_by: z.array(z.enum(["max_scripts", "max_total_bytes"])),
  limitations: z.array(z.string()),
});
export type WebScriptFetchManifest = z.output<
  typeof webScriptFetchManifestSchema
>;

/** Verified publication including the digest of the persisted manifest. */
export const webScriptFetchResultSchema = webScriptFetchManifestSchema.extend({
  manifest: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: z.number().int().min(0),
  }),
});
export type WebScriptFetchResult = z.output<typeof webScriptFetchResultSchema>;
