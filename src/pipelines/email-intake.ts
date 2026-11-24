import { ConflictError, type OpsdeskError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import type { ActionRecord, InboundEmailInput, InboundStatus } from "../core/types.ts";
import type { GatewayOutcome } from "../gateway/gateway.ts";
import { buildExtractionRequest, ExtractionError, type Extraction, type ExtractionRequest } from "../llm/extraction.ts";
import { scopeFor, type Runtime } from "../runtime.ts";

export const INTAKE_ACTOR = "system:email-intake";

export interface IntakeResult {
  inboundId: string;
  status: InboundStatus | "duplicate";
  extraction: Extraction | null;
  actions: ActionRecord[];
  refusals: { tool: string; code: string; message: string }[];
}

const leadKey = (messageId: string) => `email:${messageId}:lead`;
const quoteKey = (messageId: string) => `email:${messageId}:quote`;

function senderAddress(from: string): string | null {
  return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(from)?.[0] ?? null;
}

/**
 * Inbound email -> extraction -> proposed actions.
 *
 * Three steps, so no database transaction is held open during the model call:
 *   1. record the email (idempotent on Message-ID) and build the request
 *   2. call the model, outside any transaction
 *   3. turn the extraction into gateway requests; the gateway decides what
 *      runs now and what waits for a person
 */
export async function handleInboundEmail(rt: Runtime, tenantId: string, email: InboundEmailInput): Promise<IntakeResult> {
  const receivedAt = email.receivedAt ?? rt.clock().toISOString();

  type Step1 =
    | { kind: "channel_disabled" }
    | { kind: "duplicate"; result: IntakeResult }
    | { kind: "new"; inboundId: string; request: ExtractionRequest };

  const step1 = await rt.store.withTenant<Step1>(tenantId, async (tx) => {
    const { config, toolset } = await scopeFor(rt, tx);
    if (!config.channels.email.enabled) {
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.refused", subject: email.messageId, data: { reason: "channel_disabled" } });
      return { kind: "channel_disabled" };
    }
    const { record, created } = await tx.recordInbound({ ...email, receivedAt });
    if (!created) {
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.duplicate", subject: record.id, data: { message_id: email.messageId } });
      const actions = (await Promise.all([tx.getActionByKey(leadKey(email.messageId)), tx.getActionByKey(quoteKey(email.messageId))]))
        .filter((a): a is ActionRecord => a !== null);
      return {
        kind: "duplicate",
        result: { inboundId: record.id, status: "duplicate", extraction: null, actions, refusals: [] },
      };
    }
    await tx.appendAudit({
      actor: INTAKE_ACTOR,
      type: "email.received",
      subject: record.id,
      data: { message_id: email.messageId, from: email.from, subject: email.subject },
    });
    return { kind: "new", inboundId: record.id, request: buildExtractionRequest(config, toolset, email) };
  });

  if (step1.kind === "channel_disabled") throw new ConflictError("channel_disabled", "Email intake is not enabled for this company");
  if (step1.kind === "duplicate") return step1.result;
  const { inboundId, request } = step1;

  let extracted;
  try {
    extracted = await rt.extractor.extract(request);
  } catch (error) {
    const kind = error instanceof ExtractionError ? error.kind : "api_error";
    const message = error instanceof Error ? error.message : String(error);
    await rt.store.withTenant(tenantId, async (tx) => {
      await tx.updateInbound(inboundId, { status: "needs_review", error: `${kind}: ${message}` });
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.extraction_failed", subject: inboundId, data: { kind, message, extractor: rt.extractor.name } });
    });
    return { inboundId, status: "needs_review", extraction: null, actions: [], refusals: [] };
  }

  const ex = extracted.extraction;
  return rt.store.withTenant(tenantId, async (tx) => {
    const scope = await scopeFor(rt, tx);
    const { config, toolset } = scope;
    await tx.appendAudit({
      actor: INTAKE_ACTOR,
      type: "email.extracted",
      subject: inboundId,
      data: { extractor: rt.extractor.name, model: extracted.model, confidence: ex.confidence, usage: (extracted.usage ?? null) as Json },
    });

    if (!ex.is_business_inquiry) {
      await tx.updateInbound(inboundId, { status: "ignored", extraction: ex as unknown as Json });
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.ignored", subject: inboundId, data: { summary: ex.summary } });
      return { inboundId, status: "ignored", extraction: ex, actions: [], refusals: [] };
    }

    const min = config.channels.email.min_confidence;
    const lowConfidence = ex.confidence < min;
    const actions: ActionRecord[] = [];
    const refusals: IntakeResult["refusals"] = [];
    const collect = (tool: string, outcome: GatewayOutcome) => {
      if (outcome.ok) actions.push(outcome.action);
      else refusals.push({ tool, code: (outcome.error as OpsdeskError).code, message: outcome.error.message });
    };
    const notes: string[] = [];
    if (lowConfidence) notes.push(`model confidence ${ex.confidence.toFixed(2)} is below ${min}`);

    const contactEmail = ex.contact.email ?? senderAddress(email.from);

    if (toolset.has("crm.create_lead")) {
      collect(
        "crm.create_lead",
        await rt.gateway.request(scope, {
          tool: "crm.create_lead",
          actor: INTAKE_ACTOR,
          idempotencyKey: leadKey(email.messageId),
          forceApproval: lowConfidence,
          reason: notes.join("; ") || undefined,
          input: {
            contact: { ...ex.contact, email: contactEmail },
            summary: ex.summary || email.subject,
            urgency: ex.urgency,
            custom_fields: ex.custom_fields,
            source: "email",
            source_ref: email.messageId,
          },
        }),
      );
    }

    if (toolset.has("quote.issue") && ex.wants_quote) {
      const mapped = ex.items.filter((i) => i.service_code !== null);
      const unmapped = ex.items.filter((i) => i.service_code === null);
      if (mapped.length === 0) {
        await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.quote_skipped", subject: inboundId, data: { reason: "no catalogue match" } });
        notes.push("quote requested but nothing matched the catalogue");
      } else {
        const quoteNotes = [...notes];
        if (unmapped.length > 0) quoteNotes.push(`not priced: ${unmapped.map((i) => i.description).join(", ")}`);
        collect(
          "quote.issue",
          await rt.gateway.request(scope, {
            tool: "quote.issue",
            actor: INTAKE_ACTOR,
            idempotencyKey: quoteKey(email.messageId),
            forceApproval: lowConfidence || unmapped.length > 0,
            reason: quoteNotes.join("; ") || undefined,
            input: {
              customer: { name: ex.contact.name, email: contactEmail },
              items: mapped.map((i) => ({ code: i.service_code!, quantity: i.quantity, note: i.description })),
              source_ref: email.messageId,
            },
          }),
        );
      }
    }

    const status: InboundStatus = lowConfidence || refusals.length > 0 || notes.length > 0 ? "needs_review" : "processed";
    await tx.updateInbound(inboundId, { status, extraction: ex as unknown as Json });
    return { inboundId, status, extraction: ex, actions, refusals };
  });
}
