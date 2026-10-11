import { FORCED_DRY_RUN_NOTE, isForceDryRun } from "./forceDryRun.js";

export interface DryRunResult<TPayload> {
  dryRun: boolean;
  executed: boolean;
  payload: TPayload;
  note: string;
}

export function createDryRunResult<TPayload>(payload: TPayload): DryRunResult<TPayload> {
  return {
    dryRun: true,
    executed: false,
    payload,
    note: isForceDryRun() ? FORCED_DRY_RUN_NOTE : "Mutação não executada porque --dry-run foi informado."
  };
}
