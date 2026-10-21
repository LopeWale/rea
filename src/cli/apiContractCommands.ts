import { Cli, z } from "incur";

import { inspectApiContract } from "../application/ApiContractService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";

/** Register the local OpenAPI document inspection CLI workflow. */
export const registerApiContractCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectApiContract, {
    description:
      "Inspect a local OpenAPI 3.x document and normalize the API surface it declares",
    args: z.object({
      contractPath: z
        .string()
        .describe("Absolute path to an OpenAPI 3.x JSON or YAML document"),
    }),
    options: z.object({
      includeSchemaProperties: z
        .boolean()
        .default(true)
        .describe(
          "Include each schema's properties, enums, references, and bounds",
        ),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectApiContract, async () => {
        const result = await inspectApiContract({
          contract_path: args.contractPath,
          include_schema_properties: options.includeSchemaProperties,
        });
        return result.ok
          ? result.value
          : {
              error: "API contract inspection failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
