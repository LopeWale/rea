import { ArtifactOperationError } from "./artifactOperationError.js";

/** API contract inspection failed a typed document boundary. */
export class ApiContractError extends ArtifactOperationError {
  override readonly userMessage: string;

  constructor(
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
  ) {
    super("inspect_api_contract", reason);
    this.userMessage = `API contract inspection failed for ${target}: ${diagnostic}`;
  }
}
