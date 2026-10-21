import {
  HTTP_METHODS,
  type ApiContractInspection,
  type ApiContractOperation,
} from "./apiContract.js";
import { inferApiContractFacets } from "./openApiContractInferences.js";
import { schemaEntry } from "./openApiContractSchemas.js";
import {
  enumOf,
  isExtensionKey,
  isRecord,
  recordUnknown,
  resolveReference,
  scalarText,
  schemaRef,
  text,
  typeOf,
  type Context,
  type JsonRecord,
  type OpenApiVersion,
} from "./openApiContractShared.js";

type HttpMethod = (typeof HTTP_METHODS)[number];
type Parameter = ApiContractOperation["parameters"][number];
type Media = ApiContractOperation["responses"][number]["content"][number];
type SecurityRequirement = NonNullable<
  ApiContractOperation["security"]
>[number];
type Unknown = ApiContractInspection["unknowns"][number];

/** Why a document could not be normalized at all. */
export interface OpenApiNormalizationFailure {
  readonly reason: "not_an_object" | "unsupported_version";
  readonly message: string;
}

/** Result of normalizing a parsed document. */
export type OpenApiNormalization =
  | { readonly ok: true; readonly value: ApiContractInspection }
  | { readonly ok: false; readonly error: OpenApiNormalizationFailure };

/** Caller selections and parser-reported issues to carry into the result. */
export interface OpenApiNormalizationOptions {
  readonly format: "json" | "yaml";
  readonly includeProperties: boolean;
  /** Issues the parser reported, such as duplicate YAML keys, recorded as unknowns. */
  readonly parserUnknowns?: readonly Unknown[];
}

const LIMITATIONS = [
  "The document describes the API its author published; it does not establish the server's actual behavior, authorization decisions, rate limits, or current availability.",
  "Inferences (namespaces, state machines, asynchronous-job indicators, quota statuses, schema references) are heuristics over path shapes, property names, and status codes; confirm them against observed traffic before relying on them.",
  "Only local references into #/components (schemas, parameters, requestBodies, responses, headers) are resolved. External documents and other reference targets are reported as unknown, and the unresolved count is per distinct reference.",
  "Composition members (allOf, oneOf, anyOf, not) and nested inline objects are not flattened into property records; references inside them are listed under each schema's references with the JSON pointer where they occur.",
  "Only the eight Path Item operations of OpenAPI 3.0 and 3.1 are read. OpenAPI 3.2 documents are rejected rather than read partially.",
];

const PATH_ITEM_FIELDS: ReadonlySet<string> = new Set([
  ...HTTP_METHODS,
  "summary",
  "description",
  "servers",
  "parameters",
]);
const IGNORED_HEADER_PARAMETERS: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "authorization",
]);

const sortedEntries = (value: unknown): readonly [string, unknown][] =>
  isRecord(value)
    ? Object.entries(value)
        .filter(([key]) => !isExtensionKey(key))
        .sort(([left], [right]) => left.localeCompare(right))
    : [];

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const mediaList = (
  context: Context,
  content: unknown,
  subject: string,
): Media[] =>
  sortedEntries(content).map(([mediaType, media]) => {
    const schema = isRecord(media) ? media.schema : undefined;
    return {
      media_type: mediaType,
      ...schemaRef(context, schema, `${subject} ${mediaType}`),
      schema_type: typeOf(schema),
    };
  });

const parameter = (
  context: Context,
  raw: unknown,
  subject: string,
): Parameter | null => {
  const value = resolveReference(context, "parameters", raw, subject);
  if (value === undefined) return null;
  if (!isRecord(value) || typeof value.name !== "string") {
    recordUnknown(context, subject, "parameter_not_normalized");
    return null;
  }
  const location = text(value.in);
  if (
    location === "header" &&
    IGNORED_HEADER_PARAMETERS.has(value.name.toLowerCase())
  ) {
    recordUnknown(
      context,
      `${subject} ${value.name}`,
      "ignored_header_parameter",
    );
    return null;
  }
  const content = sortedEntries(value.content)[0];
  const schema =
    value.schema ??
    (content !== undefined && isRecord(content[1])
      ? content[1].schema
      : undefined);
  const named = `${subject} ${value.name}`;
  return {
    name: value.name,
    in: location,
    required: value.required === true || location === "path",
    schema_type: typeOf(schema),
    ...schemaRef(context, schema, named),
    content_media_type: content?.[0] ?? null,
    enum: enumOf(context, schema, named),
    description: text(value.description),
  };
};

const parameterList = (
  context: Context,
  raw: unknown,
  subject: string,
): Parameter[] =>
  Array.isArray(raw)
    ? raw.flatMap((item, index) => {
        const parsed = parameter(
          context,
          item,
          `${subject} parameters[${String(index)}]`,
        );
        return parsed === null ? [] : [parsed];
      })
    : [];

/** Header names are case-insensitive (RFC 9110 §5.1); other locations keep case. */
const parameterKey = (value: Parameter): string =>
  `${value.in ?? ""}:${value.in === "header" ? value.name.toLowerCase() : value.name}`;

const mergeParameters = (
  pathLevel: readonly Parameter[],
  operationLevel: readonly Parameter[],
): Parameter[] => {
  const merged = new Map<string, Parameter>();
  for (const value of [...pathLevel, ...operationLevel])
    merged.set(parameterKey(value), value);
  return [...merged.values()];
};

const securityOf = (value: unknown): SecurityRequirement[] | null =>
  Array.isArray(value)
    ? value.map((requirement) =>
        sortedEntries(requirement).map(([scheme, scopes]) => ({
          scheme,
          scopes: stringList(scopes),
        })),
      )
    : null;

const serverUrls = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.flatMap((server) =>
        isRecord(server) && typeof server.url === "string" ? [server.url] : [],
      )
    : null;

const requestBody = (
  context: Context,
  raw: unknown,
  subject: string,
): ApiContractOperation["request_body"] => {
  if (raw === undefined) return null;
  const value = resolveReference(context, "requestBodies", raw, subject);
  if (!isRecord(value)) return null;
  return {
    required: value.required === true,
    content: mediaList(context, value.content, subject),
  };
};

const responses = (
  context: Context,
  raw: unknown,
  subject: string,
): ApiContractOperation["responses"] =>
  sortedEntries(raw).map(([status, response]) => {
    const value = resolveReference(
      context,
      "responses",
      response,
      `${subject} ${status}`,
    );
    const record = isRecord(value) ? value : {};
    return {
      status,
      description: text(record.description),
      headers: sortedEntries(record.headers).map(([name]) => name),
      content: mediaList(context, record.content, `${subject} ${status}`),
    };
  });

interface PathItemContext {
  readonly path: string;
  readonly parameters: readonly Parameter[];
  readonly servers: string[] | null;
}

const operation = (
  context: Context,
  item: PathItemContext,
  method: HttpMethod,
  value: JsonRecord,
): ApiContractOperation => {
  const subject = `${method.toUpperCase()} ${item.path}`;
  if (isRecord(value.callbacks) && Object.keys(value.callbacks).length > 0)
    recordUnknown(context, subject, "callbacks_not_inspected");
  return {
    method,
    path: item.path,
    operation_id: text(value.operationId),
    summary: text(value.summary),
    description: text(value.description),
    tags: stringList(value.tags),
    deprecated: value.deprecated === true,
    servers: serverUrls(value.servers) ?? item.servers,
    parameters: mergeParameters(
      item.parameters,
      parameterList(context, value.parameters, subject),
    ),
    request_body: requestBody(
      context,
      value.requestBody,
      `${subject} requestBody`,
    ),
    responses: responses(context, value.responses, `${subject} responses`),
    security: securityOf(value.security),
  };
};

const pathItemOperations = (
  context: Context,
  path: string,
  item: JsonRecord,
): ApiContractOperation[] => {
  if (typeof item.$ref === "string") {
    context.unresolvedRefs.add(item.$ref);
    recordUnknown(
      context,
      `${path} → ${item.$ref}`,
      "path_item_reference_not_resolved",
    );
    return [];
  }
  for (const key of Object.keys(item))
    if (!PATH_ITEM_FIELDS.has(key) && !isExtensionKey(key))
      recordUnknown(context, `${path} ${key}`, "unsupported_path_item_field");
  const pathItem: PathItemContext = {
    path,
    parameters: parameterList(context, item.parameters, path),
    servers: serverUrls(item.servers),
  };
  return HTTP_METHODS.flatMap((method) => {
    const value = item[method];
    return isRecord(value) ? [operation(context, pathItem, method, value)] : [];
  });
};

const operations = (
  context: Context,
  paths: unknown,
): ApiContractOperation[] =>
  isRecord(paths)
    ? Object.keys(paths)
        .sort()
        .flatMap((path) => {
          if (isExtensionKey(path)) return [];
          if (!path.startsWith("/")) {
            recordUnknown(context, path, "invalid_path_key");
            return [];
          }
          const item = paths[path];
          return isRecord(item) ? pathItemOperations(context, path, item) : [];
        })
    : [];

const servers = (
  context: Context,
  value: unknown,
): ApiContractInspection["servers"] =>
  Array.isArray(value)
    ? value.flatMap((server, index) =>
        isRecord(server) && typeof server.url === "string"
          ? [
              {
                url: server.url,
                description: text(server.description),
                variables: sortedEntries(server.variables).map(
                  ([name, variable]) => {
                    const record = isRecord(variable) ? variable : {};
                    return {
                      name,
                      default: scalarText(
                        context,
                        record.default,
                        `servers[${String(index)}].variables.${name}.default`,
                      ),
                      enum: Array.isArray(record.enum)
                        ? record.enum.map(String)
                        : null,
                    };
                  },
                ),
              },
            ]
          : [],
      )
    : [];

const securitySchemes = (
  value: unknown,
): ApiContractInspection["security_schemes"] =>
  sortedEntries(value).map(([name, scheme]) => {
    const record = isRecord(scheme) ? scheme : {};
    return {
      name,
      type: text(record.type),
      scheme: text(record.scheme),
      bearer_format: text(record.bearerFormat),
      in: text(record.in),
      parameter_name: text(record.name),
      open_id_connect_url: text(record.openIdConnectUrl),
      flows: sortedEntries(record.flows).map(([flowName, flow]) => {
        const flowRecord = isRecord(flow) ? flow : {};
        return {
          name: flowName,
          authorization_url: text(flowRecord.authorizationUrl),
          token_url: text(flowRecord.tokenUrl),
          scopes: isRecord(flowRecord.scopes)
            ? Object.keys(flowRecord.scopes).sort()
            : [],
        };
      }),
    };
  });

type VersionDetection =
  | {
      readonly ok: true;
      readonly version: OpenApiVersion;
      readonly declared: string;
      readonly coerced: boolean;
    }
  | { readonly ok: false; readonly error: OpenApiNormalizationFailure };

const detectVersion = (document: JsonRecord): VersionDetection => {
  const raw = document.openapi;
  const coerced = typeof raw === "number" && Number.isFinite(raw);
  const declared = coerced ? String(raw) : text(raw);
  if (declared === null) {
    const swagger = document.swagger;
    return {
      ok: false,
      error: {
        reason: "unsupported_version",
        message:
          swagger === undefined
            ? "The document has no string openapi version field, so it is not an OpenAPI 3.x document."
            : `Swagger ${typeof swagger === "string" ? swagger : "2.x"} documents are not supported; convert the document to OpenAPI 3.0 or 3.1 first.`,
      },
    };
  }
  if (/^3\.0(?:\.|$)/u.test(declared))
    return { ok: true, version: "3.0", declared, coerced };
  if (/^3\.1(?:\.|$)/u.test(declared))
    return { ok: true, version: "3.1", declared, coerced };
  return {
    ok: false,
    error: {
      reason: "unsupported_version",
      message: declared.startsWith("3.2")
        ? `OpenAPI ${declared} adds query operations and additionalOperations that this inspector does not read; only 3.0.x and 3.1.x documents are supported.`
        : `OpenAPI ${declared} is not supported; only 3.0.x and 3.1.x documents are inspected.`,
    },
  };
};

const declaredPathCount = (paths: unknown): number =>
  isRecord(paths)
    ? Object.keys(paths).filter((key) => key.startsWith("/")).length
    : 0;

/** Normalize a parsed OpenAPI 3.0 or 3.1 document without resolving remote references. */
export const normalizeOpenApiDocument = (
  value: unknown,
  options: OpenApiNormalizationOptions,
): OpenApiNormalization => {
  if (!isRecord(value))
    return {
      ok: false,
      error: {
        reason: "not_an_object",
        message: "The document root is not an object.",
      },
    };
  const detected = detectVersion(value);
  if (!detected.ok) return detected;
  const components = isRecord(value.components) ? value.components : {};
  const schemaRecords = isRecord(components.schemas) ? components.schemas : {};
  const context: Context = {
    version: detected.version,
    components,
    schemaNames: new Set(Object.keys(schemaRecords)),
    unknowns: [],
    unknownKeys: new Set(),
    unresolvedRefs: new Set(),
  };
  for (const unknown of options.parserUnknowns ?? [])
    recordUnknown(context, unknown.subject, unknown.reason);
  if (detected.coerced)
    recordUnknown(context, "openapi", "numeric_scalar_coerced_to_text");
  const info = isRecord(value.info) ? value.info : {};
  if (declaredPathCount(value.paths) === 0)
    recordUnknown(context, "paths", "no_paths_declared");
  if (isRecord(value.webhooks) && Object.keys(value.webhooks).length > 0)
    recordUnknown(context, "webhooks", "webhooks_not_inspected");
  const ops = operations(context, value.paths);
  const schemas = Object.keys(schemaRecords)
    .sort()
    .map((name) => schemaEntry(context, name, schemaRecords[name]));
  const inferences = inferApiContractFacets(ops, schemas);
  return {
    ok: true,
    value: {
      document: {
        format: options.format,
        openapi_version: detected.declared,
        title: scalarText(context, info.title, "info.title"),
        version: scalarText(context, info.version, "info.version"),
        description: text(info.description),
      },
      servers: servers(context, value.servers),
      security_schemes: securitySchemes(components.securitySchemes),
      global_security: securityOf(value.security) ?? [],
      operations: ops,
      schemas: options.includeProperties
        ? schemas
        : schemas.map((schema) => ({ ...schema, properties: [] })),
      inferences,
      unknowns: context.unknowns,
      completeness: {
        operations_total: ops.length,
        schemas_total: schemas.length,
        schemas_with_properties: options.includeProperties ? schemas.length : 0,
        unresolved_references: context.unresolvedRefs.size,
      },
      limitations: LIMITATIONS,
    },
  };
};
