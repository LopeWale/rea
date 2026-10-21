import { Cli, z } from "incur";

import { exportWebScripts } from "../application/WebScriptExportService.js";
import { fetchWebScripts } from "../application/WebScriptFetchService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { WEB_SCRIPT_FETCH_DEFAULTS } from "../domain/webScriptFetch.js";
import type { Logger } from "../logger.js";

const fetchWebScriptOptions = z.object({
  allowedOrigins: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Exact origin whose scripts may be fetched; repeat for multiple. Defaults to the page origin, which must be included",
    ),
  followImports: z
    .boolean()
    .default(true)
    .describe(
      "Follow literal import, import(), and unbound require specifiers",
    ),
  maxScripts: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.max_scripts)
    .describe(
      "Maximum scripts to fetch; the rest are reported as unavailable with reason limit",
    ),
  maxTotalBytes: z
    .number()
    .int()
    .min(1024)
    .max(WEB_SCRIPT_FETCH_DEFAULTS.max_total_bytes_ceiling)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.max_total_bytes)
    .describe("Maximum total page and script bytes to retain"),
  requestTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(WEB_SCRIPT_FETCH_DEFAULTS.request_timeout_ms)
    .describe("Timeout in milliseconds for each script's redirects and body"),
});

/** Register the local captured-script export and browserless fetch CLI workflows. */
export const registerWebScriptCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.exportWebScripts, {
    description:
      "Export retained website scripts into an absent directory for static JavaScript analysis",
    args: z.object({
      capturePath: z
        .string()
        .describe("Absolute path to saved page or scenario capture JSON"),
      outputDirectory: z
        .string()
        .describe(
          "Absolute absent directory for verified scripts and manifest",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.exportWebScripts, async () => {
        const result = await exportWebScripts({
          capture_path: args.capturePath,
          output_directory: args.outputDirectory,
        });
        return result.ok
          ? result.value
          : {
              error: "Script export failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
  cli.command(CLI_COMMANDS.fetchWebScripts, {
    description:
      "Fetch a page's scripts over HTTP, without a browser, into an absent directory for static JavaScript analysis",
    args: z.object({
      pageUrl: z
        .string()
        .describe(
          "Absolute http(s) page URL, or a web.archive.org snapshot URL of the page",
        ),
      outputDirectory: z
        .string()
        .describe(
          "Absolute absent directory for page.html, verified scripts, and manifest",
        ),
    }),
    options: fetchWebScriptOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.fetchWebScripts, async () => {
        const result = await fetchWebScripts({
          page_url: args.pageUrl,
          output_directory: args.outputDirectory,
          ...(options.allowedOrigins.length === 0
            ? {}
            : { allowed_origins: options.allowedOrigins }),
          follow_imports: options.followImports,
          max_scripts: options.maxScripts,
          max_total_bytes: options.maxTotalBytes,
          request_timeout_ms: options.requestTimeoutMs,
        });
        return result.ok
          ? result.value
          : {
              error: "Script fetch failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
