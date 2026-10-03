import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmInfo } from "@/lib/types";
import type { ToolSpec } from "./tools";

// Provider-agnostic LLM interface for the tool-use loop. The one real provider
// is Claude (Anthropic Messages API with tool use), read from env:
//   ANTHROPIC_API_KEY   required for the LLM agent
//   LLM_MODEL           optional override (default claude-haiku-4-5-20251001)
//   LLM_PROVIDER=scripted forces the deterministic planner
// With no key, the scripted planner in run.ts executes the same tool sequence.

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

export function selectProvider(): LlmProvider | null {
  if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "scripted") return null;
  if (process.env.ANTHROPIC_API_KEY) return claude();
  return null;
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
