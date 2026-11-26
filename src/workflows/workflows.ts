import type { CompanyConfig, ToolApproval } from "../config/schema.ts";
import { ConfigError } from "../core/errors.ts";
import type { Toolset } from "../tools/registry.ts";

export interface ResolvedStep {
  tool: string;
  effect: "read" | "write";
  /** The stricter of the tool's policy and the step's own. */
  approval: ToolApproval;
}

export interface ResolvedWorkflow {
  id: string;
  description: string;
  priority: number;
  trigger: { channel: string; intent?: string };
  owner: string;
  /** False when something it needs has been switched off at runtime. It then takes no new work. */
  active: boolean;
  /** Why it is paused, in words an owner can act on. */
  paused_reason?: string;
  steps: ResolvedStep[];
}

const STRICTNESS: Record<ToolApproval, number> = { auto: 0, required: 1, never: 2 };

const stricter = (a: ToolApproval, b: ToolApproval | undefined): ToolApproval =>
  b !== undefined && STRICTNESS[b] > STRICTNESS[a] ? b : a;

/**
 * The company's enabled workflows, sorted by priority, each with the
 * effective policy of every step: a step may make a tool stricter, never looser.
 *
 * `strict` is for checking a pack as written (startup, `aiops config validate`):
 * a workflow that uses a tool or channel the pack leaves off is an authoring
 * mistake and throws. At runtime the same situation means an owner has just
 * switched something off, and a kill switch must never break the rest, so the
 * workflow is returned paused with the reason instead.
 */
export function resolveWorkflows(config: CompanyConfig, toolset: Toolset, options: { strict?: boolean } = {}): ResolvedWorkflow[] {
  const out: ResolvedWorkflow[] = [];
  for (const [id, wf] of Object.entries(config.workflows)) {
    if (!wf.enabled) continue;
    const problems: string[] = [];
    if (wf.trigger.channel === "email" && !config.channels.email.enabled) problems.push("the email channel is off");

    const steps: ResolvedStep[] = [];
    for (const step of wf.steps) {
      if (!toolset.has(step.tool)) {
        problems.push(`"${step.tool}" is not enabled`);
        continue;
      }
      const { tool, approval } = toolset.get(step.tool);
      const policy = tool.effect === "read" ? "auto" : stricter(approval, step.approval);
      steps.push({ tool: step.tool, effect: tool.effect, approval: policy });
    }

    if (problems.length > 0 && options.strict) {
      throw new ConfigError(`Company "${config.id}" workflow "${id}" cannot run: ${problems.join("; ")}`);
    }
    out.push({
      id,
      description: wf.description,
      priority: wf.priority,
      trigger: wf.trigger,
      owner: wf.owner,
      active: problems.length === 0,
      ...(problems.length > 0 ? { paused_reason: problems.join("; ") } : {}),
      steps,
    });
  }
  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
