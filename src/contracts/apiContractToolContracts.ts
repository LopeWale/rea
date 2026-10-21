import {
  apiContractInspectionSchema,
  inspectApiContractInputSchema,
} from "../domain/apiContract.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

/** Local API contract inspection shared by CLI and MCP. */
export const API_CONTRACT_TOOL_CONTRACTS = [
  {
    name: "inspect_api_contract",
    ...toolContractMetadata("inspect_api_contract"),
    description:
      "Inspect one local OpenAPI 3.x document (JSON or YAML) and return the API surface it declares: servers, security schemes, every operation with its parameters, request body, response statuses, and schema references, and every component schema with properties, enums, required fields, and bounds. Separately returns inferences (path namespaces, status-enum state machines, asynchronous-job indicators from 202 responses and polled status schemas, quota statuses 402/429, schema reference graph), unknowns (unresolved or external $ref, path-item references, webhooks, callbacks), and completeness counts. Reads only the local file; resolves no remote references and makes no network requests. Use it to reconstruct a service's data model and workflow from a published or SDK-bundled specification, then confirm against observed traffic with inspect_web_page or fetch_web_scripts.",
    kind: "application",
    inputSchema: inspectApiContractInputSchema,
    outputSchema: evidenceResultOf(apiContractInspectionSchema),
    examples: [
      {
        title: "Normalize a vendor's published OpenAPI document",
        input: { contract_path: "/analysis/vendor-openapi.yml" },
      },
      {
        title: "List operations and schema names without property detail",
        input: {
          contract_path: "/analysis/vendor-openapi.json",
          include_schema_properties: false,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
