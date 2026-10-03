import { runAgent } from "@/lib/agent/run";
import type { AgentEvent } from "@/lib/types";
import { SAMPLE_VENUES } from "@/lib/venues";

// Streams agent events as NDJSON (one JSON object per line).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let venueId = "";
  try {
    const body = (await req.json()) as { venueId?: unknown };
    venueId = typeof body.venueId === "string" ? body.venueId : "";
  } catch {
    // fall through to validation error
  }
  const venue = SAMPLE_VENUES.find((v) => v.id === venueId);
  if (!venue) return Response.json({ error: "Unknown venue" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(venue, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : "Agent failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
