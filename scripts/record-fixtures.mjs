// Builds fixtures/<venue-id>.json from responses recorded live from the Qloo
// hackathon API.
//
// 1. Record: run the app with a key and QLOO_RECORD_DIR=.recordings, then run each
//    preset once (POST /api/agent {"venueId": "<id>"}). lib/qloo/client.ts appends
//    every trimmed live response (lib/qloo/trim.ts) to .recordings/<id>.ndjson.
// 2. Assemble: node scripts/record-fixtures.mjs [YYYY-MM-DD]
//
// Each record holds only the request path + params (the cache key) and the
// response body. The script refuses to write anything that looks like a header or key.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETS = ["detroit-gasworks", "austin-lantern", "brooklyn-lowtide", "nashville-copperline", "london-basement"];
const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);

let failed = false;
for (const set of SETS) {
  const src = join(root, ".recordings", `${set}.ndjson`);
  if (!existsSync(src)) {
    console.error(`missing ${src}`);
    failed = true;
    continue;
  }
  const calls = {};
  for (const line of readFileSync(src, "utf8").split("\n").filter(Boolean)) {
    const { key, data } = JSON.parse(line);
    calls[key] = data;
  }
  const out = {
    recordedAt: date,
    note: `Recorded from the Qloo hackathon API (https://hackathon.api.qloo.com) on ${date}, trimmed to the fields the app reads. Not edited.`,
    calls,
  };
  const text = JSON.stringify(out);
  if (/x-api-key|api[_-]?key|authorization|set-cookie/i.test(text)) {
    console.error(`${set}: refusing to write, found a header/key-like string`);
    failed = true;
    continue;
  }
  writeFileSync(join(root, "fixtures", `${set}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`${set}: ${Object.keys(calls).length} calls, ${Math.round(text.length / 1024)} KB`);
}
process.exit(failed ? 1 : 0);
