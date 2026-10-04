import { runAgent } from "@/lib/agent/run";
import type { AgentEvent, VenueInput } from "@/lib/types";
import { customVenue, SAMPLE_VENUES } from "@/lib/venues";

// Streams agent events as NDJSON (one JSON object per line).
// Body: { venueId: "<preset id>" } or { custom: CustomVenueRequest }.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { venueId?: unknown; custom?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // validated below
  }

  let venue: VenueInput | undefined;
  if (body.custom !== undefined) {
    const r = customVenue(body.custom);
    if (!r.venue) return Response.json({ error: r.error }, { status: 422 });
    venue = r.venue;
  } else {
    venue = SAMPLE_VENUES.find((v) => v.id === body.venueId);
    if (!venue)
      return Response.json(
        { error: `Pick one of the preset venues (${SAMPLE_VENUES.map((v) => v.id).join(", ")}) or send a custom venue.` },
        { status: 422 },
      );
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      // Late events from abandoned parallel calls (after a timeout) are dropped.
      const emit = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
        }
      };
      try {
        await runAgent(venue, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : "Agent failed" });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
