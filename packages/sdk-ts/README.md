# @curb/sdk

TypeScript SDK for [Curb](https://github.com/itsnevu/Curb) — guardrails and circuit
breakers for AI agents.

Curb stops runaway agents before they cost you money: infinite loops, cost blowups, and
destructive tool calls, enforced by one policy engine. This package is the client your
agent uses to ask Curb for a decision before it acts.

> You need a running Curb control plane for this to do anything. The fastest way:
> `docker compose up` from the [repo](https://github.com/itsnevu/Curb#quickstart-60-seconds).

## Install

```bash
npm i @curb/sdk      # or: pnpm add @curb/sdk
```

## Use

```ts
import { Curb, PolicyViolation } from "@curb/sdk";

const curb = new Curb({
  baseUrl: "http://localhost:8090",
  apiKey: process.env.CURB_API_KEY,
});

const deleteFile = curb.wrapTool(rmFile, { name: "delete_file", sensitivity: "high" });

await curb.run(async () => {
  await curb.step();                         // enforces step_limit / time_limit
  try {
    await deleteFile("/data/production.db");  // held until someone clicks Approve
  } catch (err) {
    if (err instanceof PolicyViolation) console.log("blocked:", err.policyId);
  }
});
```

The run id propagates automatically through `AsyncLocalStorage`, so nested tools never
need it passed explicitly.

## What you get

- `curb.run()` — opens a run; everything inside shares its id and its budget
- `curb.step()` — enforces `step_limit` and `time_limit`
- `curb.wrapTool()` — wraps a tool so `tool_permission` can deny it or hold it for
  human approval before it ever executes
- `PolicyViolation` / `ApprovalTimeout` — thrown when a policy blocks or an approval
  expires, carrying `policyId` and the reason

## Note on cost caps

`cost_cap` accumulates spend at the **gateway**, which is what meters real token usage.
Using this SDK alone, a cost cap still refuses any single call whose estimate would break
the limit, but cumulative run spend is only tracked for traffic routed through the Curb
gateway. See the [policy reference](https://github.com/itsnevu/Curb#policy-reference).

## License

MIT
