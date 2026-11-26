# Recording the 2-minute demo

Two fictional companies, three fictional people, five emails. Everything runs on your own computer. Nothing is sent to a real mailbox or CRM.

| Person | Company | Role | Window |
|---|---|---|---|
| Maya | GulfCool (AC servicing, UAE) | staff: reads, asks for actions | Claude Code in `demo-workspace\maya` |
| Omar | GulfCool | approver | Claude Code in `demo-workspace\omar` |
| Lee | Northwind Freight (UK) | approver | Claude Code in `demo-workspace\lee` |

## Before recording (once)

1. In the `opsdesk` folder: `npm install`.
2. Optional, recommended: set `ANTHROPIC_API_KEY` in the terminal that runs the demo, so Claude reads the emails instead of the keyword stand-in. In Command Prompt: `set ANTHROPIC_API_KEY=...`. In PowerShell: `$env:ANTHROPIC_API_KEY = "..."`.
3. Run `npm run demo`. It prints a folder and one `claude mcp add ...` line for each person.
4. For each person, open a new terminal, go to their folder, run their line, then start `claude` there. Type `/mcp` to check that `opsdesk` shows as connected.
5. Rehearse once. The first time each opsdesk tool runs, Claude Code asks permission. Allow the read tools for this folder so the recording isn't interrupted. Leave `request_action`, `approve_action` and `reject_action` asking.
6. Stop the demo (Ctrl+C) and start it again. Every run starts with empty data, and the setup lines from step 4 keep working.

Arrange the screen with the demo terminal at the bottom and Maya's and Omar's windows side by side above it. Lee's window can sit behind them.

## The recording

| Time | Where | Do or say | What appears |
|---|---|---|---|
| 0:00 | Title | "GulfCool, a fictional AC firm. The AI reads the inbox; nothing happens without a person." | |
| 0:05 | Demo terminal | Press Enter (email 1) | `went to workflow sales_enquiry: lead done, quote waiting for approval (AED 1,617.00)` |
| 0:12 | Maya | *What came in this morning, and what's waiting for approval?* | Sara Khan's quote request; a lead created; a priced quote waiting |
| 0:25 | Maya | *Draft a short reply to Sara with her quote total and request sending it.* | `request_action` for `email.send_reply`, status waiting for approval. Point out that the reply can only go to Sara. |
| 0:40 | Omar | *What's waiting for my approval? Approve the reply to Sara.* | Claude Code shows the approval prompt: the exact email, recipient, fingerprint. Tick approve. |
| 0:55 | Omar | (after approving) | `approved: true, status: executed`: the reply is sent and logged |
| 1:00 | Maya | *Approve the quote for Sara yourself.* | Claude explains Maya cannot approve. Failure case 1: no unapproved action. |
| 1:08 | Demo terminal | Press Enter twice (emails 2 and 3) | Email 2: `general_enquiry: lead waiting for approval`. Email 3: `parked for a person to review` |
| 1:18 | Omar | *Show me the review queue. Why is the billing email there?* | The email that tried to give the AI orders: flagged, nothing sent, nothing approved. Failure case 2. |
| 1:35 | Demo terminal | Press Enter (email 4) | Sara again, second villa: a new quote, and the same customer record. |
| 1:42 | Demo terminal, then Lee | Press Enter (email 5). Lee: *Show our emails and anything waiting.* | Only Northwind's freight request. None of GulfCool's data. Failure case 3. |
| 1:52 | Omar | *Verify the audit log.* | `ok: true`: every step recorded, tamper-evident |
| 2:00 | Title | "Runs on your own server. Your team uses it from Claude Code." | |

The wording in *italics* is what you type; Claude's exact wording will vary. If Claude asks before running a tool, allow it. That prompt is Claude Code's own permission check, separate from opsdesk's approval.

## Checked by a test

`test/demo.test.ts` runs every step above through the real MCP endpoint, with clients playing Maya, Omar and Lee, so a code change that would break the recording fails CI first.
