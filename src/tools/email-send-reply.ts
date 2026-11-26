import { z } from "zod";
import type { InboundEmail } from "../core/types.ts";
import type { TenantTx } from "../store/types.ts";
import type { ToolDefinition } from "./types.ts";

const Input = z
  .object({
    /** The email being answered. The reply always goes to its sender, never an address the caller chooses. */
    inbound_id: z.uuid(),
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();

const Settings = z
  .object({
    /** Added under every reply, e.g. "GulfCool Technical Services\n+971 4 000 0000". */
    signature: z.string().max(1000).default(""),
  })
  .strict();

function senderAddress(from: string): string | null {
  return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(from)?.[0]?.toLowerCase() ?? null;
}

interface Draft {
  to: string;
  subject: string;
  text: string;
  in_reply_to: string;
}

/**
 * Exactly what will be sent, worked out from the stored email, which never
 * changes. The preview the approver sees and the message sent are built by
 * this same function, so they cannot differ.
 */
async function draft(tx: TenantTx, signature: string, input: z.infer<typeof Input>): Promise<Draft> {
  const inbound: InboundEmail | null = await tx.getInbound(input.inbound_id);
  if (!inbound) throw new Error(`No email ${input.inbound_id}`);
  const to = senderAddress(inbound.from);
  if (!to) throw new Error("The original email has no address to reply to");
  const subject = /^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`;
  const text = signature ? `${input.text}\n\n--\n${signature}` : input.text;
  return { to, subject, text, in_reply_to: inbound.messageId };
}

export const emailSendReply: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Settings>> = {
  name: "email.send_reply",
  summary: "Reply to an inbound email; the reply goes only to the original sender, in the same thread",
  effect: "write",
  inputSchema: Input,
  settingsSchema: Settings,
  async preview(ctx, input) {
    return { ...(await draft(ctx.tx, ctx.settings.signature, input)) };
  },
  async execute(ctx, input) {
    const mailbox = ctx.connectors.mailbox;
    if (!mailbox) throw new Error("No mailbox is connected for this company");
    const message = await draft(ctx.tx, ctx.settings.signature, input);
    const sent = await mailbox.sendReply({ inReplyTo: message.in_reply_to, to: message.to, subject: message.subject, text: message.text });
    return { sent_message_id: sent.messageId, to: message.to };
  },
};
