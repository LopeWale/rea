import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ApprovedFetchHost } from "../browser/ApprovedOriginFetch.js";
import { fetchWebScriptArtifacts } from "../browser/assets/FetchWebScripts.js";
import { parseWebArchiveUrl } from "../browser/WebArchiveUrl.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  type AnalysisInputIssue,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  fetchWebScriptsInputSchema,
  type FetchWebScriptsInput,
} from "../domain/webScriptFetch.js";
import { WebScriptFetchError } from "../domain/webScriptFetchError.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { WEB_SCRIPT_FETCH_PROVIDER as PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "fetch_web_scripts";
const DEFAULT_HOST: ApprovedFetchHost = { fetch: globalThis.fetch };

/** Fetch one page's scripts through the shared CLI/MCP application workflow. */
export const fetchWebScripts = async (
  rawInput: unknown,
  options: ExecutionOptions = {},
  host: ApprovedFetchHost = DEFAULT_HOST,
): Promise<Result<Evidence, AnalysisError>> => {
  const input = fetchWebScriptsInputSchema.safeParse(rawInput);
  return input.success
    ? fetchWebScriptsValidated(input.data, options, host)
    : err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          projectInputIssues(input.error.issues, rawInput),
        ),
      );
};

/**
 * Reject malformed requests before any network or filesystem access, keeping
 * caller mistakes distinct from an unavailable target. Credentials embedded in
 * the page URL are refused and never echoed.
 */
const inputIssues = (
  input: FetchWebScriptsInput,
): readonly AnalysisInputIssue[] => {
  const issues: AnalysisInputIssue[] = [];
  if (!isAbsolute(input.output_directory))
    issues.push({
      path: ["output_directory"],
      reason: "invalid_format",
      message:
        "output_directory must be an absolute filesystem path on this host.",
    });
  const logical =
    parseWebArchiveUrl(input.page_url)?.original_url ?? input.page_url;
  let page: URL | undefined;
  try {
    page = new URL(logical);
  } catch (cause: unknown) {
    void cause;
  }
  if (
    page === undefined ||
    (page.protocol !== "http:" && page.protocol !== "https:")
  )
    issues.push({
      path: ["page_url"],
      reason: "invalid_format",
      message:
        "page_url must be an absolute http(s) URL or a web.archive.org snapshot of one.",
    });
  else if (page.username !== "" || page.password !== "")
    issues.push({
      path: ["page_url"],
      reason: "invalid_value",
      message:
        "page_url must not embed credentials; REA sends no credentials and does not echo them.",
    });
  else if (
    input.allowed_origins !== undefined &&
    !input.allowed_origins.includes(page.origin)
  )
    issues.push({
      path: ["allowed_origins"],
      reason: "invalid_value",
      message: `allowed_origins must include the page's own origin (${page.origin}).`,
    });
  return issues;
};

/** Fetch and publish input already parsed by a named adapter contract. */
export const fetchWebScriptsValidated = async (
  input: FetchWebScriptsInput,
  options: ExecutionOptions = {},
  host: ApprovedFetchHost = DEFAULT_HOST,
): Promise<Result<Evidence, AnalysisError>> => {
  const issues = inputIssues(input);
  if (issues.length > 0)
    return err(new AnalysisInputError(OPERATION, undefined, issues));
  try {
    options.signal?.throwIfAborted();
    const result = await fetchWebScriptArtifacts(input, host, options.signal);
    return ok(
      createEvidence(
        {
          path: join(result.output_directory, result.page.relative_path),
          sha256: result.page.sha256,
          format: "file",
        },
        PROVIDER,
        {
          predicateType: "rea.web-script-fetch",
          operation: OPERATION,
          parameters: {
            page_url: input.page_url,
            output_directory: input.output_directory,
            allowed_origins: [...result.allowed_origins],
            follow_imports: input.follow_imports,
            max_scripts: input.max_scripts,
            max_total_bytes: input.max_total_bytes,
            request_timeout_ms: input.request_timeout_ms,
          },
          result: jsonValueSchema.parse(result),
          rawResult: null,
          confidence: "observed",
          authority:
            result.archive_snapshot === null
              ? "shipped-artifact"
              : "historical-reference",
          limitations: result.limitations,
          locations: [{ kind: "artifact-path", path: result.manifest.path }],
        },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof WebScriptFetchError) return err(cause);
    if (options.signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new WebScriptFetchError(
          cause.reason,
          input.output_directory,
          cause.message,
        ),
      );
    if (cause instanceof z.ZodError)
      return err(new AnalysisOutputError(OPERATION, cause.message, { cause }));
    if (
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
    )
      return err(
        new WebScriptFetchError(
          "io",
          `${input.page_url} → ${input.output_directory}`,
          cause.message,
        ),
      );
    return err(
      new ProviderAdapterError(PROVIDER.id, OPERATION, {
        cause,
        diagnostics: {
          page_url: input.page_url,
          output_directory: input.output_directory,
          error_name: cause instanceof Error ? cause.name : "UnknownError",
          error_message:
            cause instanceof Error
              ? cause.message
              : typeof cause === "string"
                ? cause
                : "Unknown script fetch failure",
        },
      }),
    );
  }
};
