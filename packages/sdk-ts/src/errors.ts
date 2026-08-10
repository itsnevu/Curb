import type { Decision } from "@curb/shared";

/** Thrown when a policy denies an action. Catch this to handle refusals. */
export class PolicyViolation extends Error {
  readonly decision: Decision;
  readonly policyId?: string;
  readonly toolName?: string;

  constructor(decision: Decision, toolName?: string) {
    super(decision.reason ?? "action denied by Curb policy");
    this.name = "PolicyViolation";
    this.decision = decision;
    this.policyId = decision.policyId;
    this.toolName = toolName;
  }
}

/** No approval decision arrived before the deadline. Handled according to failMode. */
export class ApprovalTimeout extends PolicyViolation {
  constructor(approvalId: string, waitedMs: number, toolName?: string) {
    super(
      {
        effect: "DENY",
        policyId: "curb_approval_timeout",
        reason: `approval ${approvalId} was not decided within ${waitedMs}ms`,
      },
      toolName,
    );
    this.name = "ApprovalTimeout";
  }
}
