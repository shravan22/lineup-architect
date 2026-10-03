import LineupArchitect from "@/components/LineupArchitect";
import { llmInfo } from "@/lib/agent/run";
import { qlooMode } from "@/lib/qloo/client";
import { SAMPLE_VENUES } from "@/lib/venues";

// Server component: reads which modes are active (never the key values) and
// hands them to the client UI.
export const dynamic = "force-dynamic";

export default function Home() {
  return <LineupArchitect status={{ qlooMode: qlooMode(), llm: llmInfo() }} venues={SAMPLE_VENUES} />;
}
