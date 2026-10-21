import type { McpServer } from "@modelcontextprotocol/server";

import { inspectApiContractValidated } from "../application/ApiContractService.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register local OpenAPI document inspection without requiring any provider. */
export const registerApiContractTool = (
  server: McpServer,
  options: {
    readonly logger: Logger;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  },
): void => {
  const contract = toolContract("inspect_api_contract");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        inspectApiContractValidated(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, contract)
        : toCallToolResult(result, contract);
    },
  );
};
