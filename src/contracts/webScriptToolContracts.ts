import {
  exportWebScriptsInputSchema,
  webScriptExportResultSchema,
} from "../domain/webScriptExport.js";
import {
  fetchWebScriptsInputSchema,
  webScriptFetchResultSchema,
} from "../domain/webScriptFetch.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

/** Local captured-script publication contracts shared by CLI and MCP. */
export const WEB_SCRIPT_TOOL_CONTRACTS = [
  {
    name: "export_web_scripts",
    ...toolContractMetadata("export_web_scripts"),
    description:
      "Export JavaScript bytes already retained in one local inspect_web_page or capture_browser_scenario JSON capture (normalized result or complete Evidence). Writes scripts and a digest-verified manifest into an absent absolute output_directory. Returns all source URLs, script or transaction/event references, unavailable states, and an analysis_input for analyze_javascript_application when any bytes were exported. Include script sources in inspect_web_page or select capture.network.response_body in scenarios. No refetch or execution. Safe unambiguous URL layouts preserve relative module paths; versions, query variants, inline scripts, and path collisions are isolated with explicit resolution limitations.",
    kind: "application",
    inputSchema: exportWebScriptsInputSchema,
    outputSchema: evidenceResultOf(webScriptExportResultSchema),
    examples: [
      {
        title: "Export a saved website capture for static JavaScript analysis",
        input: {
          capture_path: "/analysis/capture.json",
          output_directory: "/analysis/exported-scripts",
        },
      },
    ],
  },
  {
    name: "fetch_web_scripts",
    ...toolContractMetadata("fetch_web_scripts"),
    description:
      "Fetch one page and its JavaScript over HTTP without a browser, cookies, or credentials, then write page.html, verified scripts, and a digest-verified manifest into an absent absolute output_directory. Accepts a live http(s) page URL or a web.archive.org snapshot URL of the page; archived bytes are fetched unmodified. Discovers <script src>, inline scripts, <link rel=modulepreload>, and <link rel=preload as=script> from markup and, by default, follows literal import, import(), and unbound require specifiers within allowed_origins (default: the page's origin, which must be included). Returns every source URL with its fetch outcome, discovery counts, unresolved specifiers, completeness (complete, partial when any script is unavailable or unparsed, truncated when a bound stopped the walk), and an analysis_input for analyze_javascript_application when any bytes were fetched. No execution: runtime-injected scripts, import maps, and non-literal specifiers remain unknown. Use inspect_web_page or capture_browser_scenario instead when the page needs a logged-in session or script execution to load its code.",
    kind: "application",
    inputSchema: fetchWebScriptsInputSchema,
    outputSchema: evidenceResultOf(webScriptFetchResultSchema),
    examples: [
      {
        title: "Fetch a live page's script graph for static analysis",
        input: {
          page_url: "https://app.example.test/",
          output_directory: "/analysis/fetched-scripts",
        },
      },
      {
        title:
          "Fetch an archived snapshot's scripts without touching the live site",
        input: {
          page_url:
            "https://web.archive.org/web/20260219070517/https://app.example.test/",
          output_directory: "/analysis/archived-scripts",
          allowed_origins: ["https://app.example.test"],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
