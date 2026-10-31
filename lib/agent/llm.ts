import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import type { LlmInfo } from "@/lib/types";
import type { ToolSpec } from "./tools";

// Provider-agnostic LLM interface for the tool-use loop. Two real providers:
//   Claude (Anthropic Messages API, tool use)      ANTHROPIC_API_KEY
//   Gemini (@google/genai, function calling)       GEMINI_API_KEY
// selectProviders() returns a fallback chain; run.ts moves to the next provider when
// one fails (timeout, 5xx, 429/quota, other errors) and to the scripted planner last.
//   LLM_PROVIDER   gemini | claude | scripted (optional). Forces the primary provider;
//                  the other provider (if its key is set) stays as the fallback.
//                  Unset: Claude, then Gemini, for whichever keys are set.
//   LLM_MODEL      optional model override for the primary provider
//   CLAUDE_MODEL / GEMINI_MODEL   per-provider model overrides
//   LLM_TEST_FAULT test only: "<provider>:hang" or "<provider>:503" (provider gemini,
//                  anthropic or all) makes that provider hang until aborted or fail.
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
  /** One model call. `signal` aborts it (per-call timeout); the SDKs do not retry. */
  next(system: string, messages: Msg[], tools: ToolSpec[], signal: AbortSignal): Promise<LlmTurn>;
}

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
// Free-tier model (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-08).
// Measured live 2026-10-08 on the Detroit preset: gemini-3.8-flash took 20-29 s on its
// first call and missed the budget twice; gemini-3.5-flash-lite finished in 9 s
// (5 calls, 0.8-2.5 s each). LLM_MODEL overrides.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Fallback chain of LLM providers (may be empty: the scripted planner runs). */
export function selectProviders(): LlmProvider[] {
  const want = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (want === "scripted") return [];
  const order: ("claude" | "gemini")[] = want === "gemini" ? ["gemini", "claude"] : ["claude", "gemini"];
  const chain: LlmProvider[] = [];
  for (const p of order) {
    const primary = chain.length === 0;
    if (p === "claude" && process.env.ANTHROPIC_API_KEY) chain.push(claude(primary));
    if (p === "gemini" && process.env.GEMINI_API_KEY) chain.push(gemini(primary));
  }
  return chain;
}

/** The primary provider, or null for the scripted planner. */
export function selectProvider(): LlmProvider | null {
  return selectProviders()[0] ?? null;
}

/** Thrown when a call is aborted by the per-call timeout. */
export class LlmTimeout extends Error {
  constructor(public ms: number) {
    super(`timed out after ${(ms / 1000).toFixed(0)} s`);
    this.name = "LlmTimeout";
  }
}

/** True for transient server errors worth one retry (HTTP 5xx, connection errors). Not 429, not timeouts. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof LlmTimeout) return false;
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") return status >= 500;
  const name = e instanceof Error ? e.name : "";
  return /Connection|FetchError|ECONNRESET|socket/i.test(name + " " + (e instanceof Error ? e.message : ""));
}

/** Test-only fault injection (LLM_TEST_FAULT), see the header comment. */
async function testFault(provider: "anthropic" | "gemini", signal: AbortSignal) {
  const f = (process.env.LLM_TEST_FAULT ?? "").trim().toLowerCase();
  if (!f) return;
  const [who, kind] = f.split(":");
  if (who !== provider && who !== "all") return;
  if (kind === "503") throw Object.assign(new Error("simulated overload (LLM_TEST_FAULT)"), { status: 503 });
  if (kind === "hang")
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
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

function gemini(primary: boolean): LlmProvider {
  const model = (primary && process.env.LLM_MODEL) || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 45_000, retryOptions: { attempts: 1 } } });
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
    async next(system, messages, tools, signal) {
      await testFault("gemini", signal);
      const res = await ai.models.generateContent({
        model,
        contents: messages.map(toContent),
        config: {
          abortSignal: signal,
          systemInstruction: system,
          maxOutputTokens: 1500,
          // Default for 3.x Flash is "medium"; low keeps planning turns fast (GEMINI_THINKING overrides).
          thinkingConfig: { thinkingLevel: (process.env.GEMINI_THINKING?.toUpperCase() as ThinkingLevel) || ThinkingLevel.LOW },
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        },
      });
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

function claude(primary: boolean): LlmProvider {
  const model = (primary && process.env.LLM_MODEL) || process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  // Retries and timeouts are handled in run.ts (one retry per provider, per-call abort).
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 0 });
  return {
    info: { provider: "anthropic", model, label: `Claude (${model})` },
    async next(system, messages, tools, signal) {
      await testFault("anthropic", signal);
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
      }, { signal });
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
