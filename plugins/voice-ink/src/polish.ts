// Turning a transcript into something you would have typed.
//
// Whisper writes what it hears: no question marks, no paragraphs, and the
// occasional wrong word where the audio was ambiguous. A small language model
// fixes all three in well under a second — this is what MyInk calls AI
// enhancement, and it is why its output reads like writing rather than speech.
//
// The audio never leaves the machine; only the text does.

/** Providers the plugin can send a transcript to. */
export type PolishProvider = "off" | "groq" | "anthropic" | "openai-compatible";

export interface PolishConfig {
  provider: PolishProvider;
  apiKey: string | null;
  model: string;
  /** Overrides the provider's default endpoint; required for openai-compatible. */
  baseUrl: string | null;
  /** Extra instruction appended to the built-in one (tone, formatting habits). */
  extraInstruction: string | null;
  /** Terms the model should prefer when the audio is ambiguous. */
  vocabulary: string | null;
}

const BASE_INSTRUCTION = [
  "You clean up dictated speech into text the speaker would have typed.",
  "Restore punctuation, sentence boundaries, question marks and paragraph breaks by meaning.",
  "Keep the original language and every meaningful word. Remove only filler sounds and stutters.",
  "Fix words the speech recognizer clearly got wrong, using the surrounding context.",
  "Never answer, translate, summarize, comment, or add anything of your own.",
  "Output only the corrected text.",
].join(" ");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export function buildInstruction(config: PolishConfig): string {
  const parts = [BASE_INSTRUCTION];
  if (config.vocabulary !== null && config.vocabulary.trim() !== "") {
    parts.push(
      `Terms the speaker uses, prefer these spellings when the audio is close: ${config.vocabulary.trim()}.`,
    );
  }
  if (config.extraInstruction !== null && config.extraInstruction.trim() !== "") {
    parts.push(config.extraInstruction.trim());
  }
  return parts.join(" ");
}

function endpointFor(config: PolishConfig): string {
  if (config.baseUrl !== null && config.baseUrl.trim() !== "") {
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    return config.provider === "anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`;
  }
  return config.provider === "anthropic" ? ANTHROPIC_URL : GROQ_URL;
}

function requestFor(
  config: PolishConfig,
  text: string,
): { headers: Record<string, string>; body: string } {
  const instruction = buildInstruction(config);
  if (config.provider === "anthropic") {
    return {
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2_000,
        temperature: 0,
        system: instruction,
        messages: [{ role: "user", content: text }],
      }),
    };
  }
  return {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey ?? ""}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: text },
      ],
    }),
  };
}

function readReply(provider: PolishProvider, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  if (provider === "anthropic") {
    const content = record.content;
    if (!Array.isArray(content)) return null;
    const texts = content
      .map((block) =>
        typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter((part) => part !== "");
    return texts.length > 0 ? texts.join("") : null;
  }

  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : null;
}

/**
 * Clean up one transcript. Failures return the original text: a dictation that
 * arrives unpolished is a small annoyance, one that arrives not at all is not.
 */
export async function polishTranscript(args: {
  text: string;
  config: PolishConfig;
  timeoutMs: number;
  log(message: string): void;
}): Promise<string> {
  const { text, config, timeoutMs } = args;
  if (config.provider === "off" || text.trim() === "") return text;
  if (config.apiKey === null || config.apiKey.trim() === "") return text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const { headers, body } = requestFor(config, text);
    const response = await fetch(endpointFor(config), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      args.log(`text cleanup rejected by ${config.provider}: HTTP ${response.status}`);
      return text;
    }
    const reply = readReply(config.provider, await response.json());
    if (reply === null || reply.trim() === "") {
      args.log(`text cleanup returned nothing from ${config.provider}`);
      return text;
    }
    return reply.trim();
  } catch (error) {
    args.log(
      `text cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return text;
  } finally {
    clearTimeout(timer);
  }
}
