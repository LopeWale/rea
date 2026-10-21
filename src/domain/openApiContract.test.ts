import { describe, expect, it } from "vitest";

import { apiContractInspectionSchema } from "./apiContract.js";
import { normalizeOpenApiDocument } from "./openApiContract.js";

const document = {
  openapi: "3.1.0",
  info: { title: "Studio API", version: "0.0.1", description: "Agent API" },
  servers: [
    { url: "https://studio.example.test", description: "production" },
    {
      url: "http://{host}/api",
      variables: {
        host: { default: "localhost", enum: ["localhost", "127.0.0.1"] },
      },
    },
  ],
  security: [{ bearerAuth: [] }, { oauth: ["read", "write"] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      oauth: {
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: "https://auth.example.test/token",
            scopes: { read: "r", write: "w" },
          },
        },
      },
    },
    parameters: {
      JobId: {
        name: "jobId",
        in: "path",
        schema: { type: "string", format: "uuid" },
      },
      Chained: { $ref: "#/components/parameters/JobId" },
    },
    schemas: {
      Base: { type: "object", properties: { id: { type: "string" } } },
      Child: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { $ref: "#/components/schemas/Gone" },
          {
            type: "object",
            properties: {
              status: { type: "string", enum: ["queued", "done"] },
            },
          },
        ],
      },
      Alias: { $ref: "#/components/schemas/Base" },
      Dict: {
        type: "object",
        additionalProperties: { $ref: "#/components/schemas/Base" },
      },
      FinetuningJob: {
        type: "object",
        required: ["id", "status", "experiments"],
        properties: {
          id: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["processing", "completed", "failed"],
          },
          experiments: {
            type: "array",
            items: { $ref: "#/components/schemas/Experiment" },
          },
          note: { type: ["string", "null"] },
          kind: { const: "job" },
          mixed: { enum: [1, "1", null] },
        },
      },
      Experiment: {
        type: "object",
        properties: {
          training_type: { type: "string", enum: ["full", "lora", "qlora"] },
          batch_size: {
            type: "integer",
            minimum: 1,
            maximum: Number.POSITIVE_INFINITY,
            default: 4,
          },
          processingStatus: { type: "string", enum: ["none", "processing"] },
        },
      },
    },
  },
  paths: {
    "x-ext": { get: {} },
    "relative/path": { get: {} },
    "/api/v1/public/finetuning/create": {
      servers: [{ url: "https://alt.example.test" }],
      post: {
        operationId: "finetuning.create",
        summary: "Create job",
        tags: ["finetuning"],
        parameters: [
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "x-trace", in: "header", schema: { type: "integer" } },
          { name: "Authorization", in: "header", schema: { type: "string" } },
          {
            name: "filter",
            in: "query",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Base" },
              },
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Experiment" },
            },
          },
        },
        responses: {
          "200": {
            description: "created",
            headers: { "X-RateLimit-Remaining": {}, "x-codegen-ignored": {} },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FinetuningJob" },
              },
            },
          },
          "402": { $ref: "#/components/responses/__proto__" },
          "429": { description: "quota" },
          default: { description: "error" },
          "x-codegen": { description: "ignored" },
        },
        callbacks: { done: {} },
      },
    },
    "/api/v1/public/finetuning/{jobId}": {
      parameters: [
        { $ref: "#/components/parameters/Chained" },
        { name: "verbose", in: "query", schema: { type: "boolean" } },
      ],
      get: {
        parameters: [
          {
            name: "verbose",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FinetuningJob" },
              },
            },
          },
        },
        security: [],
      },
    },
    "/api/v1/models/up": {
      post: {
        deprecated: true,
        servers: [{ url: "https://op.example.test" }],
        requestBody: { $ref: "#/components/requestBodies/Missing" },
        responses: { "202": { description: "loading" } },
      },
    },
    "/legacy": { $ref: "other.yaml#/paths/legacy" },
  },
  webhooks: { event: {} },
};

const normalized = normalizeOpenApiDocument(document, {
  format: "json",
  includeProperties: true,
});
if (!normalized.ok) throw new Error(normalized.error.message);
const result = apiContractInspectionSchema.parse(normalized.value);
const schema = (name: string) => {
  const found = result.schemas.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing schema ${name}`);
  return found;
};
const propertyOf = (schemaName: string, propertyName: string) =>
  schema(schemaName).properties.find(({ name }) => name === propertyName);
const operation = (method: string, path: string) => {
  const found = result.operations.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (found === undefined) throw new Error(`Missing ${method} ${path}`);
  return found;
};

describe("OpenAPI contract normalization: document, servers, and security", () => {
  it("records identity, server variables, and security schemes with scopes", () => {
    expect(result.document).toMatchObject({
      format: "json",
      openapi_version: "3.1.0",
      title: "Studio API",
      version: "0.0.1",
      description: "Agent API",
    });
    expect(result.servers[1]).toEqual({
      url: "http://{host}/api",
      description: null,
      variables: [
        {
          name: "host",
          default: "localhost",
          enum: ["localhost", "127.0.0.1"],
        },
      ],
    });
    expect(result.security_schemes.map(({ name }) => name)).toEqual([
      "bearerAuth",
      "oauth",
    ]);
    expect(result.security_schemes[1]?.flows).toEqual([
      {
        name: "clientCredentials",
        authorization_url: null,
        token_url: "https://auth.example.test/token",
        scopes: ["read", "write"],
      },
    ]);
    expect(result.global_security).toEqual([
      [{ scheme: "bearerAuth", scopes: [] }],
      [{ scheme: "oauth", scopes: ["read", "write"] }],
    ]);
  });
});

describe("OpenAPI contract normalization: operations", () => {
  it("skips extension keys and non-path keys, and keeps declared statuses as written", () => {
    expect(
      result.operations.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "post /api/v1/models/up",
      "post /api/v1/public/finetuning/create",
      "get /api/v1/public/finetuning/{jobId}",
    ]);
    const create = operation("post", "/api/v1/public/finetuning/create");
    expect(create.responses.map(({ status }) => status)).toEqual([
      "200",
      "402",
      "429",
      "default",
    ]);
    expect(create.responses[0]?.headers).toEqual(["X-RateLimit-Remaining"]);
    expect(create.responses[0]?.content[0]).toEqual({
      media_type: "application/json",
      schema_ref: "FinetuningJob",
      unresolved_ref: null,
      schema_type: null,
    });
    expect(create.servers).toEqual(["https://alt.example.test"]);
    expect(create.security).toBeNull();
    expect(create.request_body).toEqual({
      required: true,
      content: [
        {
          media_type: "application/json",
          schema_ref: "Experiment",
          unresolved_ref: null,
          schema_type: null,
        },
      ],
    });
  });

  it("merges parameters by location and case-insensitive header name, ignoring reserved headers", () => {
    const create = operation("post", "/api/v1/public/finetuning/create");
    expect(create.parameters).toEqual([
      {
        name: "x-trace",
        in: "header",
        required: false,
        schema_type: "integer",
        schema_ref: null,
        unresolved_ref: null,
        content_media_type: null,
        enum: null,
        description: null,
      },
      {
        name: "filter",
        in: "query",
        required: false,
        schema_type: null,
        schema_ref: "Base",
        unresolved_ref: null,
        content_media_type: "application/json",
        enum: null,
        description: null,
      },
    ]);
    const get = operation("get", "/api/v1/public/finetuning/{jobId}");
    expect(
      get.parameters.map(({ name, in: location, required, schema_type }) => ({
        name,
        location,
        required,
        schema_type,
      })),
    ).toEqual([
      {
        name: "jobId",
        location: "path",
        required: true,
        schema_type: "string",
      },
      {
        name: "verbose",
        location: "query",
        required: true,
        schema_type: "string",
      },
    ]);
    expect(get.security).toEqual([]);
    expect(get.servers).toBeNull();
    const up = operation("post", "/api/v1/models/up");
    expect(up).toMatchObject({
      deprecated: true,
      servers: ["https://op.example.test"],
      request_body: null,
    });
  });
});

describe("OpenAPI contract normalization: schemas and references", () => {
  it("walks composition, additionalProperties, and items for references", () => {
    expect(result.schemas.map(({ name }) => name)).toEqual([
      "Alias",
      "Base",
      "Child",
      "Dict",
      "Experiment",
      "FinetuningJob",
    ]);
    expect(schema("Alias")).toMatchObject({
      ref: "Base",
      references: [{ via: "#", schema_ref: "Base", unresolved_ref: null }],
    });
    expect(schema("Child")).toMatchObject({
      type: "allOf",
      composition: ["allOf"],
      property_count: 0,
      references: [
        { via: "#/allOf/0", schema_ref: "Base", unresolved_ref: null },
        {
          via: "#/allOf/1",
          schema_ref: null,
          unresolved_ref: "#/components/schemas/Gone",
        },
      ],
    });
    expect(schema("Dict")).toMatchObject({
      additional_properties: "typed",
      references: [
        {
          via: "#/additionalProperties",
          schema_ref: "Base",
          unresolved_ref: null,
        },
      ],
    });
    expect(schema("FinetuningJob").references).toEqual([
      {
        via: "#/properties/experiments/items",
        schema_ref: "Experiment",
        unresolved_ref: null,
      },
    ]);
  });

  it("keeps enum values as JSON, reads const, nullability, and finite bounds", () => {
    expect(propertyOf("FinetuningJob", "mixed")?.enum).toEqual([1, "1", null]);
    expect(propertyOf("FinetuningJob", "kind")?.const_json).toBe('"job"');
    expect(propertyOf("FinetuningJob", "note")).toMatchObject({
      type: "string",
      nullable: true,
    });
    expect(propertyOf("FinetuningJob", "experiments")).toMatchObject({
      items_ref: "Experiment",
      required: true,
    });
    expect(propertyOf("Experiment", "batch_size")).toMatchObject({
      minimum: 1,
      maximum: null,
      default_json: "4",
    });
  });
});

describe("OpenAPI contract normalization: inferences, unknowns, and options", () => {
  it("separates inferences and unknowns from the declared facts", () => {
    expect(result.inferences.namespaces).toEqual([
      { prefix: "/api/v1", depth: 2, operation_count: 3 },
      { prefix: "/api/v1/public", depth: 3, operation_count: 2 },
    ]);
    expect(
      result.inferences.status_enums.map(
        ({ schema: name, property }) => `${name}.${property}`,
      ),
    ).toEqual(["Experiment.processingStatus", "FinetuningJob.status"]);
    expect(
      result.inferences.async_indicators.map(
        ({ path, reason }) => `${reason} ${path}`,
      ),
    ).toEqual([
      "accepted_202 /api/v1/models/up",
      "status_poll /api/v1/public/finetuning/{jobId}",
    ]);
    expect(result.inferences.quota_statuses).toEqual([
      {
        method: "post",
        path: "/api/v1/public/finetuning/create",
        statuses: ["402", "429"],
      },
    ]);
    expect(result.inferences.schema_references).toEqual([
      { from: "Alias", via: "#", to: "Base" },
      { from: "Child", via: "#/allOf/0", to: "Base" },
      { from: "Dict", via: "#/additionalProperties", to: "Base" },
      {
        from: "FinetuningJob",
        via: "#/properties/experiments/items",
        to: "Experiment",
      },
    ]);
    expect(result.unknowns.map(({ reason }) => reason).sort()).toEqual([
      "callbacks_not_inspected",
      "external_or_unsupported_reference",
      "external_or_unsupported_reference",
      "external_or_unsupported_reference",
      "ignored_header_parameter",
      "invalid_path_key",
      "non_finite_number",
      "path_item_reference_not_resolved",
      "webhooks_not_inspected",
    ]);
    expect(result.unknowns).toContainEqual({
      subject: "Child #/allOf/1 → #/components/schemas/Gone",
      reason: "external_or_unsupported_reference",
    });
    expect(result.unknowns).toContainEqual({
      subject: "Experiment.batch_size.maximum",
      reason: "non_finite_number",
    });
    expect(result.completeness).toEqual({
      operations_total: 3,
      schemas_total: 6,
      schemas_with_properties: 6,
      unresolved_references: 4,
    });
  });

  it("computes inferences from the full model even when properties are left out of the output", () => {
    const summary = normalizeOpenApiDocument(document, {
      format: "yaml",
      includeProperties: false,
    });
    if (!summary.ok) throw new Error(summary.error.message);
    const job = summary.value.schemas.find(
      ({ name }) => name === "FinetuningJob",
    );
    expect(job?.properties).toEqual([]);
    expect(job?.property_count).toBe(6);
    expect(summary.value.completeness.schemas_with_properties).toBe(0);
    expect(summary.value.inferences.status_enums).toHaveLength(2);
    expect(summary.value.inferences.schema_references).toHaveLength(4);
    expect(summary.value.completeness.unresolved_references).toBe(4);
  });

  it("rejects non-3.0/3.1 documents and reports coerced numeric scalars", () => {
    expect(
      normalizeOpenApiDocument("text", {
        format: "yaml",
        includeProperties: true,
      }),
    ).toEqual({
      ok: false,
      error: {
        reason: "not_an_object",
        message: "The document root is not an object.",
      },
    });
    const swagger = normalizeOpenApiDocument(
      { swagger: "2.0", paths: {} },
      { format: "json", includeProperties: true },
    );
    if (swagger.ok) throw new Error("Expected rejection");
    expect(swagger.error.reason).toBe("unsupported_version");
    const next = normalizeOpenApiDocument(
      { openapi: "3.2.0", paths: { "/a": { query: {} } } },
      { format: "json", includeProperties: true },
    );
    if (next.ok) throw new Error("Expected rejection");
    expect(next.error.message).toContain("3.2.0");
    const numeric = normalizeOpenApiDocument(
      { openapi: 3.1, info: { title: "N", version: 1 } },
      { format: "yaml", includeProperties: true },
    );
    if (!numeric.ok) throw new Error(numeric.error.message);
    expect(numeric.value.document).toMatchObject({
      openapi_version: "3.1",
      version: "1",
    });
    expect(numeric.value.unknowns).toEqual([
      { subject: "openapi", reason: "numeric_scalar_coerced_to_text" },
      { subject: "paths", reason: "no_paths_declared" },
      { subject: "info.version", reason: "numeric_scalar_coerced_to_text" },
    ]);
  });
});
