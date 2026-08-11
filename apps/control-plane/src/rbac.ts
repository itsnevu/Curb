/**
 * Roles and what each one may do.
 *
 * These are capability sets, not a ladder. An `agent` may submit decisions and audit
 * events but must never be able to edit the policies it is judged by — that is the whole
 * point of running the policy engine outside the agent. An `operator` is the mirror
 * image: it can release a held tool call but cannot loosen a policy to avoid the hold.
 */
export const ROLES = ["admin", "operator", "agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  /** Read runs, events and dashboard stats. */
  "read",
  /** Read the policy set — the gateway needs this to evaluate locally. */
  "policies:read",
  "policies:write",
  /** Submit decisions and audit events; the machine path. */
  "decisions:write",
  "approvals:read",
  "approvals:decide",
  /** Manage the org itself: projects and API keys. */
  "org:admin",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const GRANTS: Record<Role, Capability[]> = {
  admin: [...CAPABILITIES],
  operator: ["read", "policies:read", "approvals:read", "approvals:decide"],
  // An agent sees only what it needs to ask permission and report what it did. It gets
  // approvals:read so the SDK can long-poll the approval it just created.
  agent: ["policies:read", "decisions:write", "approvals:read"],
  viewer: ["read", "policies:read", "approvals:read"],
};

/** The full grant for a role. The dashboard reads this so it never has to guess. */
export function capabilitiesOf(role: Role): Capability[] {
  return [...GRANTS[role]];
}

export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
