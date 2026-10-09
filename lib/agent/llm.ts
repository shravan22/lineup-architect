import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import type { LlmInfo } from "@/lib/types";
import type { ToolSpec } from "./tools";

// Provider-agnostic LLM interface for the tool-use loop. Two real providers:
//   Claude (Anthropic Messages API, tool use)      ANTHROPIC_API_KEY
//   Gemini (@google/genai, function calling)       GEMINI_API_KEY
//   LLM_PROVIDER   gemini | claude | scripted (optional). Unset: claude if
//                  ANTHROPIC_API_KEY is set, else gemini if GEMINI_API_KEY is set,
//                  else the deterministic scripted planner in run.ts.
//   LLM_MODEL      optional model override for the selected provider
// Keys are only read from env and never logged or sent to the browser.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { id: string; name: string; content: string; isError?: boolean }[] };

export interface LlmTurn {
  text?: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface LlmProvider {
  info: LlmInfo;
  next(system: string, messages: Msg[], tools: ToolSpec[]): Promise<LlmTurn>;
}

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
// Free-tier model (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-08).
// Measured live 2026-10-08 on the Detroit preset: gemini-3.8-flash took 20-29 s on its
// first call and missed the budget twice; gemini-3.5-flash-lite finished in 9 s
// (5 calls, 0.8-2.5 s each). LLM_MODEL overrides.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export function selectProvider(): LlmProvider | null {
  const want = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (want === "scripted") return null;
  if (want === "gemini") return process.env.GEMINI_API_KEY ? gemini() : null;
  if (want === "claude" || want === "anthropic") return process.env.ANTHROPIC_API_KEY ? claude() : null;
  if (process.env.ANTHROPIC_API_KEY) return claude();
  if (process.env.GEMINI_API_KEY) return gemini();
  return null;
}

/** True for rate-limit / quota failures (HTTP 429, Gemini RESOURCE_EXHAUSTED). */
export function isQuotaError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  if (status === 429) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
}

/** Short error text for the trace. Never includes request details or keys. */
export function llmErrorText(e: unknown): string {
  const status = (e as { status?: unknown })?.status;
  // Google errors carry a status word (UNAVAILABLE, RESOURCE_EXHAUSTED); keep only that.
  const word = e instanceof Error ? e.message.match(/"status"\s*:\s*"([A-Z_]+)"/)?.[1] : undefined;
  if (typeof status === "number") return `HTTP ${status}${word ? ` ${word}` : ""}`;
  return e instanceof Error ? e.name || "error" : "error";
}

const LOCAL_ID = "local-call-";

function gemini(): LlmProvider {
  const model = process.env.LLM_MODEL || DEFAULT_GEMINI_MODEL;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 45_000 } });
  let seq = 0;
  const toContent = (m: Msg): Content => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "assistant") {
      // Replay the model's own content so Gemini 3 thought signatures are kept.
      if (m.raw) return m.raw as Content;
      return {
        role: "model",
        parts: [...(m.text ? [{ text: m.text }] : []), ...m.toolCalls.map((c): Part => ({ functionCall: { id: c.id, name: c.name, args: c.args } }))],
      };
    }
    return {
      role: "user",
      parts: m.results.map((r): Part => ({
        functionResponse: { id: r.id.startsWith(LOCAL_ID) ? undefined : r.id, name: r.name, response: r.isError ? { error: r.content } : { output: r.content } },
      })),
    };
  };
  return {
    info: { provider: "gemini", model, label: `Gemini (${model})` },
    async next(system, messages, tools) {
      const call = () => ai.models.generateContent({
        model,
        contents: messages.map(toContent),
        config: {
          systemInstruction: system,
          maxOutputTokens: 1500,
          // Default for 3.x Flash is "medium"; low keeps planning turns fast (GEMINI_THINKING overrides).
          thinkingConfig: { thinkingLevel: (process.env.GEMINI_THINKING?.toUpperCase() as ThinkingLevel) || ThinkingLevel.LOW },
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        },
      });
      let res;
      try {
        res = await call();
      } catch (e) {
        // 500/503 (model overloaded) is usually transient: one retry. 429 is not retried.
        const status = (e as { status?: unknown })?.status;
        if (status !== 500 && status !== 503) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        res = await call();
      }
      const content = res.candidates?.[0]?.content;
      const parts = content?.parts ?? [];
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("\n")
        .trim();
      const toolCalls = parts
        .filter((p) => p.functionCall?.name)
        // When Gemini gives no call id, use a local one for bookkeeping only (not sent back).
        .map((p) => ({ id: p.functionCall!.id || `${LOCAL_ID}${++seq}`, name: p.functionCall!.name!, args: (p.functionCall!.args ?? {}) as Record<string, unknown> }));
      // `raw` is the model's content unchanged (keeps thought signatures for the next turn).
      return { text: text || undefined, toolCalls, raw: content };
    },
  };
}

function claude(): LlmProvider {
  const model = process.env.LLM_MODEL || DEFAULT_CLAUDE_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 2 });
  return {
    info: { provider: "anthropic", model, label: `Claude (${model})` },
    async next(system, messages, tools) {
      const res = await client.messages.create({
        model,
        max_tokens: 1500,
        system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
        })),
        messages: messages.map((m): Anthropic.Messages.MessageParam => {
          if (m.role === "user") return { role: "user", content: m.text };
          if (m.role === "assistant") {
            if (m.raw) return { role: "assistant", content: m.raw as Anthropic.Messages.ContentBlockParam[] };
            return {
              role: "assistant",
              content: [
                ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
                ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
              ],
            };
          }
          return {
            role: "user",
            content: m.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError ?? false,
            })),
          };
        }),
      });
      const text = res.content
        .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      return {
        text: text || undefined,
        toolCalls: res.content
          .filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === "tool_use")
          .map((c) => ({ id: c.id, name: c.name, args: (c.input ?? {}) as Record<string, unknown> })),
        raw: res.content,
      };
    },
  };
}
