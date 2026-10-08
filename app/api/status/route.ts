import { llmInfo } from "@/lib/agent/run";
import { qlooMode } from "@/lib/qloo/client";
import { recordedOn } from "@/lib/qloo/fixtures";
import type { StatusInfo } from "@/lib/types";

// Reports which modes are active. Never returns key values.
export const dynamic = "force-dynamic";

export function GET() {
  const body: StatusInfo = { qlooMode: qlooMode(), llm: llmInfo(), recordedOn: recordedOn() };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
