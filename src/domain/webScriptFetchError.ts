import { ArtifactOperationError } from "./artifactOperationError.js";

/** Fetch or publication failure retaining its page, output target, and cleanup state. */
export class WebScriptFetchError extends ArtifactOperationError {
  override readonly userMessage: string;
  override readonly cleanupIncomplete: boolean;
  override readonly cleanupResources: readonly string[];

  constructor(
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
    residualPaths: readonly string[] = [],
  ) {
    super("fetch_web_scripts", reason);
    this.userMessage = `Script fetch failed for ${target}: ${diagnostic}`;
    this.cleanupResources = residualPaths;
    this.cleanupIncomplete = residualPaths.length > 0;
  }
}
