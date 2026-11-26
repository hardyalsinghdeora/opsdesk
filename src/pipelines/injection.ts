/**
 * Spots email text written to steer an AI rather than to ask the business for
 * something. It is one layer of defence, not the main one: the model only
 * labels, routing is plain code, replies go only to the sender, and writes
 * need approval. When it fires, every step for that email waits for a person
 * and the approver is told why.
 *
 * Patterns are deliberately narrow (words addressed to an assistant), so an
 * ordinary customer writing "please ignore my previous email" is not flagged.
 */
const PATTERNS: [string, RegExp][] = [
  ["override", /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|your|the|my|these|those)\s+){0,3}(?:previous|prior|above|earlier|system|original)\s+(?:instructions?|rules|prompts?|directions)\b/i],
  ["addressed_to_ai", /\b(?:to|for|attention)\s*:?\s*(?:the\s+)?(?:ai|assistant|chatbot|language model|llm|agent)\b|\bsystem\s+(?:notice|message|prompt)\s+(?:to|for)\b/i],
  ["role_claim", /\byou\s+are\s+now\s+(?:authori[sz]ed|allowed|permitted|in\s+\w+\s+mode)\b/i],
  ["skip_approval", /\b(?:do\s+not|don'?t|without)\s+(?:ask(?:ing)?\s+(?:anyone\s+|a\s+person\s+|a\s+human\s+)?for|wait(?:ing)?\s+for)\s+(?:any\s+)?(?:approval|permission|confirmation)\b/i],
  ["role_tokens", /<\|?\s*(?:im_start|im_end|system)\s*\|?>|\[\/?INST\]/i],
];

export function injectionSignals(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
