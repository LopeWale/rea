import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";

/** Inspect one local OpenAPI document and normalize the API surface it declares. */
export const inspectApiContractInputSchema = z.strictObject({
  contract_path: z
    .string()
    .min(1)
    .describe(
      "Absolute filesystem path to an OpenAPI 3.0.x or 3.1.x document in JSON or YAML",
    ),
  include_schema_properties: z
    .boolean()
    .default(true)
    .describe(
      "Include each component schema's property records in the result. Inferences and unknowns are always computed from the full document",
    ),
});
/** Parsed input of inspect_api_contract. */
export type InspectApiContractInput = z.output<
  typeof inspectApiContractInputSchema
>;

/**
 * Document size limits. YAML parsing is synchronous and expands in memory, so
 * its cap is lower than JSON's to keep the MCP process within a 1 GiB heap.
 */
export const API_CONTRACT_LIMITS = {
  json_bytes: 32 * 1024 * 1024,
  yaml_bytes: 8 * 1024 * 1024,
} as const;

const nullableText = z.string().nullable();

/** HTTP methods that OpenAPI 3.0 and 3.1 define on a Path Item. */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/** A resolved local schema name, or the raw reference when it could not be resolved. */
const schemaReferenceFields = {
  schema_ref: nullableText,
  unresolved_ref: nullableText,
};

const apiContractMediaSchema = z.strictObject({
  media_type: z.string().min(1),
  ...schemaReferenceFields,
  schema_type: nullableText,
});

const apiContractParameterSchema = z.strictObject({
  name: z.string().min(1),
  in: nullableText,
  /** Declared `required`, or implied by `in: path`, which the specification makes mandatory. */
  required: z.boolean(),
  schema_type: nullableText,
  ...schemaReferenceFields,
  /** Media type when the parameter is serialized through `content` instead of `schema`. */
  content_media_type: nullableText,
  enum: z.array(jsonValueSchema).nullable(),
  description: nullableText,
});

const securityRequirementSchema = z.array(
  z.strictObject({ scheme: z.string().min(1), scopes: z.array(z.string()) }),
);

/** One operation exactly as the document declares it. */
export const apiContractOperationSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1),
  operation_id: nullableText,
  summary: nullableText,
  description: nullableText,
  tags: z.array(z.string()),
  deprecated: z.boolean(),
  /** Server URLs when the operation or its path item overrides the document servers; null inherits. */
  servers: z.array(z.string()).nullable(),
  parameters: z.array(apiContractParameterSchema),
  request_body: z
    .strictObject({
      required: z.boolean(),
      content: z.array(apiContractMediaSchema),
    })
    .nullable(),
  responses: z.array(
    z.strictObject({
      status: z.string().min(1),
      description: nullableText,
      headers: z.array(z.string()),
      content: z.array(apiContractMediaSchema),
    }),
  ),
  /** Operation-level security requirements; null inherits the document default, [] disables security. */
  security: z.array(securityRequirementSchema).nullable(),
});

const apiContractPropertySchema = z.strictObject({
  name: z.string().min(1),
  type: nullableText,
  format: nullableText,
  ref: nullableText,
  unresolved_ref: nullableText,
  items_type: nullableText,
  items_ref: nullableText,
  items_unresolved_ref: nullableText,
  enum: z.array(jsonValueSchema).nullable(),
  const_json: nullableText,
  nullable: z.boolean(),
  required: z.boolean(),
  minimum: z.number().nullable(),
  maximum: z.number().nullable(),
  default_json: nullableText,
  description: nullableText,
});

/** One component schema with its declared shape. */
export const apiContractSchemaSchema = z.strictObject({
  name: z.string().min(1),
  type: nullableText,
  description: nullableText,
  /** Set when the component is itself a reference to another schema. */
  ref: nullableText,
  unresolved_ref: nullableText,
  enum: z.array(jsonValueSchema).nullable(),
  const_json: nullableText,
  composition: z.array(z.enum(["allOf", "oneOf", "anyOf", "not"])),
  additional_properties: z.enum(["any", "none", "typed"]).nullable(),
  required: z.array(z.string()),
  property_count: z.number().int().min(0),
  properties: z.array(apiContractPropertySchema),
  /** Every schema reference reachable inside this schema, with the JSON pointer it sits at. */
  references: z.array(
    z.strictObject({
      via: z.string().min(1),
      ...schemaReferenceFields,
    }),
  ),
});

/** Heuristic readings of the declared surface, kept apart from observations. */
export const apiContractInferencesSchema = z.strictObject({
  namespaces: z.array(
    z.strictObject({
      prefix: z.string().min(1),
      depth: z.number().int().min(1),
      operation_count: z.number().int().min(1),
    }),
  ),
  status_enums: z.array(
    z.strictObject({
      schema: z.string().min(1),
      property: z.string().min(1),
      values: z.array(jsonValueSchema),
    }),
  ),
  async_indicators: z.array(
    z.strictObject({
      method: z.enum(HTTP_METHODS),
      path: z.string().min(1),
      reason: z.enum(["accepted_202", "status_poll"]),
      detail: z.string().min(1),
    }),
  ),
  schema_references: z.array(
    z.strictObject({
      from: z.string().min(1),
      via: z.string().min(1),
      to: z.string().min(1),
    }),
  ),
  quota_statuses: z.array(
    z.strictObject({
      method: z.enum(HTTP_METHODS),
      path: z.string().min(1),
      statuses: z.array(z.string().min(1)),
    }),
  ),
});

/** Normalized API surface declared by one OpenAPI 3.0.x or 3.1.x document. */
export const apiContractInspectionSchema = z.strictObject({
  document: z.strictObject({
    format: z.enum(["json", "yaml"]),
    openapi_version: z.string().min(1),
    title: nullableText,
    version: nullableText,
    description: nullableText,
  }),
  servers: z.array(
    z.strictObject({
      url: z.string().min(1),
      description: nullableText,
      variables: z.array(
        z.strictObject({
          name: z.string().min(1),
          default: nullableText,
          enum: z.array(z.string()).nullable(),
        }),
      ),
    }),
  ),
  security_schemes: z.array(
    z.strictObject({
      name: z.string().min(1),
      type: nullableText,
      scheme: nullableText,
      bearer_format: nullableText,
      in: nullableText,
      parameter_name: nullableText,
      open_id_connect_url: nullableText,
      flows: z.array(
        z.strictObject({
          name: z.string().min(1),
          authorization_url: nullableText,
          token_url: nullableText,
          scopes: z.array(z.string()),
        }),
      ),
    }),
  ),
  global_security: z.array(securityRequirementSchema),
  operations: z.array(apiContractOperationSchema),
  schemas: z.array(apiContractSchemaSchema),
  inferences: apiContractInferencesSchema,
  unknowns: z.array(
    z.strictObject({ subject: z.string().min(1), reason: z.string().min(1) }),
  ),
  completeness: z.strictObject({
    operations_total: z.number().int().min(0),
    schemas_total: z.number().int().min(0),
    /** Schemas whose property records are present in the output. */
    schemas_with_properties: z.number().int().min(0),
    /** Distinct references that could not be resolved locally. */
    unresolved_references: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});
/** Normalized result of inspect_api_contract. */
export type ApiContractInspection = z.output<
  typeof apiContractInspectionSchema
>;
/** One normalized operation. */
export type ApiContractOperation = z.output<typeof apiContractOperationSchema>;
/** One normalized component schema. */
export type ApiContractSchema = z.output<typeof apiContractSchemaSchema>;
