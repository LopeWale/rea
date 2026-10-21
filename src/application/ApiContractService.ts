import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import { parseDocument as parseYamlDocument } from "yaml";
import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  API_CONTRACT_LIMITS,
  apiContractInspectionSchema,
  inspectApiContractInputSchema,
  type InspectApiContractInput,
} from "../domain/apiContract.js";
import { ApiContractError } from "../domain/apiContractError.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { normalizeOpenApiDocument } from "../domain/openApiContract.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { API_CONTRACT_PROVIDER as PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "inspect_api_contract";

/** Inspect one local OpenAPI document through the shared CLI/MCP workflow. */
export const inspectApiContract = async (
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = inspectApiContractInputSchema.safeParse(rawInput);
  return input.success
    ? inspectApiContractValidated(input.data, options)
    : err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          projectInputIssues(input.error.issues, rawInput),
        ),
      );
};

type DocumentFormat = "json" | "yaml";

interface DocumentText {
  readonly bytes: Buffer;
  readonly text: string;
  readonly format: DocumentFormat;
}

/** Decide JSON versus YAML from the extension, falling back to the first non-blank character. */
const documentFormat = (path: string, textValue: string): DocumentFormat => {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return /^\s*[[{]/u.test(textValue) ? "json" : "yaml";
};

const limitError = (
  path: string,
  format: DocumentFormat,
  bytes: number,
): ApiContractError =>
  new ApiContractError(
    "limit",
    path,
    `The ${format.toUpperCase()} document is ${String(bytes)} bytes; the limit is ${String(API_CONTRACT_LIMITS[`${format}_bytes`])} bytes. YAML is parsed synchronously in memory, so its limit is lower than JSON's.`,
  );

/** Read a bounded UTF-8 document, keeping each refusal reason distinct. */
const readDocument = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<DocumentText, AnalysisError>> => {
  const info = await stat(path);
  if (!info.isFile())
    return err(
      new ApiContractError("path", path, "The path is not a regular file."),
    );
  if (info.size > API_CONTRACT_LIMITS.json_bytes)
    return err(limitError(path, "json", info.size));
  const bytes = await readFile(path, { signal });
  let textValue: string;
  try {
    textValue = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch (cause: unknown) {
    void cause;
    return err(
      new ApiContractError("format", path, "The document is not UTF-8 text."),
    );
  }
  const format = documentFormat(path, textValue);
  // Re-check against the bytes actually read: the file may have grown since
  // stat, and YAML has its own lower cap.
  if (bytes.length > API_CONTRACT_LIMITS[`${format}_bytes`])
    return err(limitError(path, format, bytes.length));
  return ok({ bytes, text: textValue, format });
};

interface ParsedDocument {
  readonly value: unknown;
  readonly unknowns: readonly { subject: string; reason: string }[];
}

const parseJson = (
  path: string,
  textValue: string,
): Result<ParsedDocument, AnalysisError> => {
  const parsed = safeParseJson(textValue);
  return parsed.ok
    ? ok({ value: parsed.value, unknowns: [] })
    : err(
        new ApiContractError(
          "format",
          path,
          `The document is not valid JSON (${parsed.error}).`,
        ),
      );
};

/**
 * Parse YAML with the library defaults (alias count capped at 100, unique
 * keys required). Duplicate keys are kept as unknowns rather than rejected,
 * because JSON.parse also keeps the last duplicate silently and the two
 * formats should agree.
 */
const parseYaml = (
  path: string,
  textValue: string,
): Result<ParsedDocument, AnalysisError> => {
  const document = parseYamlDocument(textValue);
  const fatal = document.errors.find((error) => error.code !== "DUPLICATE_KEY");
  if (fatal !== undefined)
    return err(
      new ApiContractError(
        "format",
        path,
        `The document is not valid YAML (${fatal.message.trim()}).`,
      ),
    );
  const unknowns = document.errors.map((error) => {
    const position = error.linePos?.[0];
    return {
      subject:
        position === undefined
          ? "yaml duplicate key"
          : `yaml line ${String(position.line)}:${String(position.col)}`,
      reason: "duplicate_yaml_key_last_value_kept",
    };
  });
  return ok({ value: document.toJS() as unknown, unknowns });
};

/** Map an unexpected failure to the tagged error algebra with its reason intact. */
const failure = (
  cause: unknown,
  path: string,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (signal?.aborted === true) return new AnalysisCancelledError(OPERATION);
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(OPERATION, cause.message, { cause });
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    if (cause.code === "ENOENT")
      return new ApiContractError("path", path, "No file exists at this path.");
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new ApiContractError(
        "path",
        path,
        "Permission denied reading the document; check the file's permissions and the sandbox read rules.",
      );
    return new ApiContractError("io", path, cause.message);
  }
  return new ProviderAdapterError(PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      contract_path: path,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Unknown API contract inspection failure",
    },
  });
};

/** Inspect input already parsed by a named adapter contract. */
export const inspectApiContractValidated = async (
  input: InspectApiContractInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const path = input.contract_path;
  if (!isAbsolute(path))
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["contract_path"],
          reason: "invalid_format",
          message:
            "contract_path must be an absolute filesystem path on this host.",
        },
      ]),
    );
  try {
    options.signal?.throwIfAborted();
    const document = await readDocument(path, options.signal);
    if (!document.ok) return document;
    const parsed =
      document.value.format === "json"
        ? parseJson(path, document.value.text)
        : parseYaml(path, document.value.text);
    if (!parsed.ok) return parsed;
    options.signal?.throwIfAborted();
    const normalized = normalizeOpenApiDocument(parsed.value.value, {
      format: document.value.format,
      includeProperties: input.include_schema_properties,
      parserUnknowns: parsed.value.unknowns,
    });
    if (!normalized.ok)
      return err(
        new ApiContractError(
          // An unsupported version is a target REA does not read; a non-object
          // root is a malformed document. Keep the two apart for callers.
          normalized.error.reason === "unsupported_version"
            ? "unavailable"
            : "format",
          path,
          normalized.error.message,
        ),
      );
    const result = apiContractInspectionSchema.parse(normalized.value);
    return ok(
      createEvidence(
        {
          path,
          sha256: createHash("sha256")
            .update(document.value.bytes)
            .digest("hex"),
          format: "file",
        },
        PROVIDER,
        {
          predicateType: "rea.api-contract",
          operation: OPERATION,
          parameters: {
            contract_path: path,
            include_schema_properties: input.include_schema_properties,
          },
          result: jsonValueSchema.parse(result),
          rawResult: null,
          // Facts are read verbatim from the caller-supplied document, so they
          // are observed; the heuristic facets are labeled inferences inside.
          confidence: "observed",
          authority: "historical-reference",
          limitations: result.limitations,
          locations: [{ kind: "artifact-path", path }],
        },
      ),
    );
  } catch (cause: unknown) {
    return err(failure(cause, path, options.signal));
  }
};
