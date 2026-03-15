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
    note: "Mutação não executada porque --dry-run foi informado."
  };
}
