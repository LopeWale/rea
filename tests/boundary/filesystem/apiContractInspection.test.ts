import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectApiContract } from "../../../src/application/ApiContractService.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { apiContractInspectionSchema } from "../../../src/domain/apiContract.js";
import { ApiContractError } from "../../../src/domain/apiContractError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const YAML_DOCUMENT = `openapi: 3.0.3
info:
  title: Vendor API
  version: "1.2"
servers:
  - url: https://api.vendor.test
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Job:
      type: object
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string, enum: [queued, running, done] }
paths:
  /v1/jobs:
    post:
      responses:
        "202": { description: accepted }
  /v1/jobs/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Job" }
`;

const write = async (
  name: string,
  content: string | Buffer,
): Promise<string> => {
  const root = await createTestTempDirectory("rea-api-contract-");
  const path = join(root, name);
  await writeFile(path, content);
  return path;
};

describe("API contract inspection boundary", () => {
  it("inspects YAML and JSON documents as caller-supplied reference evidence", async () => {
    const yamlPath = await write("vendor.yaml", YAML_DOCUMENT);
    const fromYaml = await inspectApiContract({ contract_path: yamlPath });
    if (!fromYaml.ok) throw fromYaml.error;
    expect(fromYaml.value.authority).toBe("historical-reference");
    expect(fromYaml.value.confidence).toBe("observed");
    expect(fromYaml.value.subject?.local_path).toBe(yamlPath);
    const yamlResult = apiContractInspectionSchema.parse(
      fromYaml.value.normalized_result,
    );
    expect(yamlResult.document).toMatchObject({
      format: "yaml",
      openapi_version: "3.0.3",
      title: "Vendor API",
      version: "1.2",
    });
    expect(
      yamlResult.operations.map(({ method, path }) => `${method} ${path}`),
    ).toEqual(["post /v1/jobs", "get /v1/jobs/{id}"]);
    expect(
      yamlResult.inferences.async_indicators.map(({ reason }) => reason),
    ).toEqual(["accepted_202", "status_poll"]);
    expect(yamlResult.limitations.length).toBeGreaterThan(0);

    const jsonPath = await write(
      "vendor.json",
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Vendor API", version: "2" },
        paths: {
          "/ping": { get: { responses: { "200": { description: "ok" } } } },
        },
      }),
    );
    const fromJson = await inspectApiContract({
      contract_path: jsonPath,
      include_schema_properties: false,
    });
    if (!fromJson.ok) throw fromJson.error;
    const jsonResult = apiContractInspectionSchema.parse(
      fromJson.value.normalized_result,
    );
    expect(jsonResult.document.format).toBe("json");
    expect(jsonResult.completeness).toMatchObject({
      operations_total: 1,
      schemas_total: 0,
      schemas_with_properties: 0,
    });
    expect(fromJson.value.parameters).toEqual({
      contract_path: jsonPath,
      include_schema_properties: false,
    });
  });

  it("detects the format from content when the extension is unknown", async () => {
    const path = await write("spec.txt", YAML_DOCUMENT);
    const result = await inspectApiContract({ contract_path: path });
    if (!result.ok) throw result.error;
    expect(
      apiContractInspectionSchema.parse(result.value.normalized_result).document
        .format,
    ).toBe("yaml");
  });

  it("reports caller mistakes and unusable documents with distinct typed reasons", async () => {
    const relative = await inspectApiContract({
      contract_path: "relative.yaml",
    });
    if (relative.ok) throw new Error("Expected rejection");
    expect(relative.error).toBeInstanceOf(AnalysisInputError);

    const root = await createTestTempDirectory("rea-api-contract-");
    const missing = await inspectApiContract({
      contract_path: join(root, "absent.yaml"),
    });
    if (missing.ok) throw new Error("Expected rejection");
    expect(missing.error).toBeInstanceOf(ApiContractError);
    if (missing.error instanceof ApiContractError)
      expect(missing.error.reason).toBe("path");

    const invalidYaml = await inspectApiContract({
      contract_path: await write(
        "broken.yaml",
        "openapi: 3.0.0\npaths: [unclosed",
      ),
    });
    if (invalidYaml.ok) throw new Error("Expected rejection");
    expect(invalidYaml.error).toBeInstanceOf(ApiContractError);
    if (invalidYaml.error instanceof ApiContractError) {
      expect(invalidYaml.error.reason).toBe("format");
      expect(invalidYaml.error.userMessage).toContain("not valid YAML");
    }

    const swagger = await inspectApiContract({
      contract_path: await write(
        "swagger.json",
        JSON.stringify({ swagger: "2.0", info: {}, paths: {} }),
      ),
    });
    if (swagger.ok) throw new Error("Expected rejection");
    expect(swagger.error).toBeInstanceOf(ApiContractError);
    if (swagger.error instanceof ApiContractError) {
      expect(swagger.error.reason).toBe("unavailable");
      expect(swagger.error.userMessage).toContain("Swagger 2.0");
    }

    const binary = await inspectApiContract({
      contract_path: await write(
        "binary.yaml",
        Buffer.from([0xff, 0xfe, 0x00, 0xc3]),
      ),
    });
    if (binary.ok) throw new Error("Expected rejection");
    expect(binary.error).toBeInstanceOf(ApiContractError);
    if (binary.error instanceof ApiContractError)
      expect(binary.error.userMessage).toContain("not UTF-8");
  });
});

describe("API contract inspection boundary: parser and limit edge cases", () => {
  it("keeps duplicate YAML keys as unknowns, strips a BOM, and honours a pre-aborted signal", async () => {
    const duplicated = await inspectApiContract({
      contract_path: await write(
        "dup.yaml",
        "openapi: 3.0.0\ninfo:\n  title: A\n  title: B\n  version: '1'\npaths: {}\n",
      ),
    });
    if (!duplicated.ok) throw duplicated.error;
    const result = apiContractInspectionSchema.parse(
      duplicated.value.normalized_result,
    );
    expect(result.document.title).toBe("B");
    expect(result.unknowns).toContainEqual({
      subject: "yaml line 4:3",
      reason: "duplicate_yaml_key_last_value_kept",
    });

    const bom = await inspectApiContract({
      contract_path: await write(
        "bom.json",
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(
            JSON.stringify({
              openapi: "3.0.3",
              info: { title: "B", version: "1" },
              paths: { "/x": { get: { responses: { "200": {} } } } },
            }),
          ),
        ]),
      ),
    });
    if (!bom.ok) throw bom.error;
    expect(
      apiContractInspectionSchema.parse(bom.value.normalized_result).operations,
    ).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await inspectApiContract(
      { contract_path: await write("c.yaml", YAML_DOCUMENT) },
      { signal: controller.signal },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });

  it("rejects YAML above its own byte limit without reading it into the parser", async () => {
    const root = await createTestTempDirectory("rea-api-contract-");
    const path = join(root, "huge.yaml");
    const handle = await open(path, "w");
    try {
      await handle.write("openapi: 3.0.0\n");
      await handle.truncate(9 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const huge = await inspectApiContract({ contract_path: path });
    if (huge.ok) throw new Error("Expected rejection");
    expect(huge.error).toBeInstanceOf(ApiContractError);
    if (huge.error instanceof ApiContractError) {
      expect(huge.error.reason).toBe("limit");
      expect(huge.error.userMessage).toContain("YAML");
    }
  });
});
