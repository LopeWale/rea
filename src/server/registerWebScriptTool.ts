import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { exportWebScriptsValidated } from "../application/WebScriptExportService.js";
import { fetchWebScriptsValidated } from "../application/WebScriptFetchService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register local script export and browserless script fetch without a live browser provider. */
export const registerWebScriptTool = (
  server: McpServer,
  options: {
    readonly logger: Logger;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  },
): void => {
  const exportContract = toolContract("export_web_scripts");
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input, context) => {
      const result = await logToolExecution(
        options.logger,
        exportContract.name,
        () => exportWebScriptsValidated(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, exportContract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, exportContract)
        : toCallToolResult(result, exportContract);
    },
  );
  const fetchContract = toolContract("fetch_web_scripts");
  server.registerTool(
    fetchContract.name,
    toolRegistrationOptions(fetchContract),
    async (input, context) => {
      const result = await logToolExecution(
        options.logger,
        fetchContract.name,
        () => fetchWebScriptsValidated(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, fetchContract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, fetchContract)
        : toCallToolResult(result, fetchContract);
    },
  );
};
