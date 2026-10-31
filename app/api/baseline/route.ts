import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CLAUDE_MODEL } from "@/lib/agent/llm";

// "Without Qloo": the same model asked the same booking question with no Qloo data, so the
// UI can show what the taste data adds. Runs only when a viewer opens that panel.
export const dynamic = "force-dynamic";

type Body = { name?: unknown; city?: unknown; capacity?: unknown; headliners?: unknown };

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "Needs a Claude key on the server." }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as Body;
  const name = str(b.name, 80);
  const city = str(b.city, 80);
  const capacity = typeof b.capacity === "number" && b.capacity >= 50 && b.capacity <= 20000 ? Math.round(b.capacity) : null;
  const headliners = Array.isArray(b.headliners) ? b.headliners.map((h) => str(h, 80)).filter((h): h is string => !!h).slice(0, 3) : [];
  if (!name || !city || !capacity || !headliners.length) return Response.json({ error: "Missing venue details." }, { status: 422 });

  const model = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 0 });
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content:
            `You help a talent buyer. Using only your own knowledge (no tools or data), suggest the next booking for ${name}, ` +
            `a ${capacity}-capacity venue in ${city} whose past headliners included ${headliners.join(", ")}. ` +
            `Do not suggest those past headliners. Reply with JSON only: {"headliner": "...", "supports": ["...", "..."], "reason": "one sentence"}`,
        },
      ],
    });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { headliner?: unknown; supports?: unknown; reason?: unknown };
    const acts = [json.headliner, ...(Array.isArray(json.supports) ? json.supports : [])].map((a) => str(a, 80)).filter((a): a is string => !!a).slice(0, 3);
    if (!acts.length) throw new Error("no acts in the reply");
    return Response.json({ acts, reason: str(json.reason, 400) ?? "", model }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Claude didn't answer in time. Try again." }, { status: 502 });
  }
}
