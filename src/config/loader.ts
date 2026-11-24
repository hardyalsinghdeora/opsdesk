import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError, ValidationError } from "../core/errors.ts";
import { deepMerge, isPlainObject } from "../core/json.ts";
import { CompanyConfig, RuntimeOverrides } from "./schema.ts";

export interface ConfigSource {
  defaults: Record<string, unknown>;
  /** Raw company packs keyed by company id. */
  packs: Map<string, Record<string, unknown>>;
}

function readYaml(file: string): Record<string, unknown> {
  const parsed: unknown = parseYaml(readFileSync(file, "utf8"));
  if (!isPlainObject(parsed)) throw new ConfigError(`${file} must contain a YAML mapping`);
  return parsed;
}

/**
 * Reads `config/platform.defaults.yaml` and every `companies/<id>/company.yaml`.
 * The directory name must match the pack's `id`.
 */
export function loadConfigSource(rootDir: string): ConfigSource {
  const defaults = readYaml(path.join(rootDir, "config", "platform.defaults.yaml"));
  const packs = new Map<string, Record<string, unknown>>();
  const companiesDir = path.join(rootDir, "companies");
  if (existsSync(companiesDir)) {
    for (const entry of readdirSync(companiesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(companiesDir, entry.name, "company.yaml");
      if (!existsSync(file)) continue;
      const pack = readYaml(file);
      if (pack.id !== entry.name) {
        throw new ConfigError(`${file}: id "${String(pack.id)}" must match its directory "${entry.name}"`);
      }
      packs.set(entry.name, pack);
    }
  }
  return { defaults, packs };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseOverrides(raw: unknown): RuntimeOverrides {
  const result = RuntimeOverrides.safeParse(raw ?? {});
  if (!result.success) {
    throw new ValidationError(`Invalid runtime overrides: ${formatIssues(result.error)}`, result.error.issues);
  }
  return result.data;
}

/** Merge the three layers and validate the result. */
export function resolveCompanyConfig(
  source: ConfigSource,
  companyId: string,
  overrides: unknown = {},
): CompanyConfig {
  const pack = source.packs.get(companyId);
  if (!pack) throw new ConfigError(`No company pack for "${companyId}"`);
  const merged = deepMerge(deepMerge(source.defaults, pack), parseOverrides(overrides));
  const result = CompanyConfig.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`Company "${companyId}" config is invalid: ${formatIssues(result.error)}`, result.error.issues);
  }
  return result.data;
}
