import type { CompanyConfig } from "../config/schema.ts";
import { ConfigError, ToolDisabledError } from "../core/errors.ts";
import { crmCreateLead } from "./crm-create-lead.ts";
import { quoteIssue } from "./quote-issue.ts";
import { emailSendReply } from "./email-send-reply.ts";
import type { EnabledTool, ToolDefinition } from "./types.ts";

export const BUILTIN_TOOLS: ToolDefinition[] = [crmCreateLead, quoteIssue, emailSendReply];

/** The tools one company may use, with their validated settings. */
export class Toolset {
  private readonly tools: Map<string, EnabledTool>;

  constructor(tools: Map<string, EnabledTool>) {
    this.tools = tools;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): EnabledTool {
    const entry = this.tools.get(name);
    if (!entry) throw new ToolDisabledError(name);
    return entry;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Settings for a tool, typed by the caller. Undefined when disabled. */
  settingsOf<S>(name: string): S | undefined {
    return this.tools.get(name)?.settings as S | undefined;
  }

  describe(): { name: string; summary: string; effect: string; approval: string }[] {
    return this.names().map((name) => {
      const { tool, approval } = this.get(name);
      return { name, summary: tool.summary, effect: tool.effect, approval: tool.effect === "read" ? "auto" : approval };
    });
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const tool of tools) {
      if (this.definitions.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
      this.definitions.set(tool.name, tool);
    }
  }

  known(): string[] {
    return [...this.definitions.keys()].sort();
  }

  /**
   * Build the toolset for a resolved company config. Unknown tool names and
   * invalid settings fail loudly here, at startup or when overrides change,
   * rather than halfway through handling a customer's email.
   */
  forCompany(config: CompanyConfig): Toolset {
    const enabled = new Map<string, EnabledTool>();
    for (const [name, entry] of Object.entries(config.tools)) {
      const tool = this.definitions.get(name);
      if (!tool) throw new ConfigError(`Company "${config.id}" configures unknown tool "${name}"`);
      if (!entry.enabled) continue;
      const settings = tool.settingsSchema.safeParse(entry.settings);
      if (!settings.success) {
        const issues = settings.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new ConfigError(`Company "${config.id}" tool "${name}" settings are invalid: ${issues}`);
      }
      enabled.set(name, {
        tool,
        settings: settings.data,
        approval: entry.approval ?? config.approvals.default,
      });
    }
    return new Toolset(enabled);
  }
}
