import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  ExtractionError,
  normaliseExtraction,
  type ExtractionRequest,
  type ExtractionResult,
  type Extractor,
} from "./extraction.ts";

/**
 * One structured-output call per email. No agent loop and no tools: the model
 * reads and labels, and deterministic code decides what happens next.
 */
export class AnthropicExtractor implements Extractor {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(client: Anthropic = new Anthropic()) {
    this.client = client;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: request.model,
        max_tokens: request.maxTokens,
        // If the model declines, the API retries on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
        messages: [{ role: "user", content: request.user }],
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ExtractionError("api_error", `Model API error ${error.status ?? ""}: ${error.message}`);
      }
      throw error;
    }

    if (response.stop_reason === "refusal") {
      throw new ExtractionError("refusal", `Model declined (${response.stop_details?.category ?? "unspecified"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ExtractionError("truncated", "Model output hit max_tokens");
    }
    if (!response.parsed_output) {
      throw new ExtractionError("invalid_output", "Model output did not match the schema");
    }
    return {
      extraction: normaliseExtraction(response.parsed_output as Record<string, unknown>, request),
      model: response.model,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
      },
    };
  }
}
