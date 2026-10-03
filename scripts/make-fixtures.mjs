// Generates the SAMPLE (fixture) Qloo responses used when QLOO_API_KEY is not set.
//
// These are NOT recorded from the live Qloo API. They follow the response shapes
// documented for the Qloo hackathon API (/search, /v2/tags, /v2/insights with
// filter.type = urn:tag | urn:entity:artist | urn:entity:brand | urn:entity:place |
// urn:heatmap | urn:demographics). All scores below are illustrative values chosen
// by hand. The UI labels every fixture-backed result as "Sample data".
//
// Run: node scripts/make-fixtures.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "detroit-gasworks");
mkdirSync(out, { recursive: true });

const NOTE =
  "SAMPLE DATA: hand-written fixture in the documented Qloo response shape. Not a live Qloo response.";

function id(name) {
  const h = createHash("sha1").update("fixture:" + name).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function tag(name, type = "urn:tag:genre:music") {
  const slug = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return { id: `${type}:${slug}`, name, type };
}

function write(file, data) {
  writeFileSync(join(out, file), JSON.stringify({ _fixture: NOTE, ...data }, null, 2) + "\n");
}

// ---------- /search ----------
const artistEntity = (name, popularity, extra = {}) => ({
  name,
  entity_id: id(name),
  type: "urn:entity",
  subtype: "urn:entity:artist",
  types: ["urn:entity:artist"],
  popularity,
  properties: { short_description: extra.desc ?? "Musical artist" },
  tags: (extra.tags ?? []).map((t) => tag(t)),
});

write("search.json", {
  queries: {
    moodymann: {
      results: [
        artistEntity("Moodymann", 0.82, { desc: "Detroit house producer and DJ", tags: ["Deep House", "Detroit Techno", "Soul"] }),
      ],
    },
    "floating points": {
      results: [
        artistEntity("Floating Points", 0.84, { desc: "English electronic musician and producer", tags: ["Electronic", "Nu Jazz", "Ambient"] }),
      ],
    },
    "jamie xx": {
      results: [
        artistEntity("Jamie xx", 0.9, { desc: "English producer, DJ and member of The xx", tags: ["Electronic", "House", "UK Garage"] }),
        artistEntity("The xx", 0.93, { desc: "English indie pop band", tags: ["Indie Pop", "Dream Pop"] }),
      ],
    },
  },
});

// ---------- /v2/tags (genre lookup for "deep house") ----------
write("tags-search.json", {
  results: {
    tags: [
      tag("Deep House"),
      tag("House"),
      tag("Soulful House"),
      tag("Chicago House"),
      tag("Tech House"),
    ],
  },
});

// ---------- /v2/insights filter.type=urn:tag (taste profile of the venue's past headliners) ----------
const tasteTags = [
  ["Deep House", 0.94],
  ["Detroit Techno", 0.91],
  ["Electronic", 0.89],
  ["House", 0.86],
  ["Nu Jazz", 0.78],
  ["Ambient", 0.72],
  ["Soul", 0.7],
  ["Experimental", 0.68],
  ["Disco", 0.66],
  ["Broken Beat", 0.61],
];
write("insights-tags.json", {
  success: true,
  results: {
    tags: tasteTags.map(([n, a]) => ({
      tag_id: tag(n).id,
      name: n,
      types: ["urn:entity:artist"],
      subtype: "urn:tag:genre:music",
      query: { affinity: a },
    })),
  },
  duration: 41,
});

// ---------- /v2/insights filter.type=urn:entity:artist ----------
const artists = [
  ["Theo Parrish", 0.93, 0.71, "Detroit house producer and DJ", ["Deep House", "Detroit Techno", "Soul", "Disco"]],
  ["Four Tet", 0.91, 0.88, "English electronic musician", ["Electronic", "Ambient", "Experimental", "House"]],
  ["Kerri Chandler", 0.89, 0.74, "American deep house producer and DJ", ["Deep House", "House", "Soul"]],
  ["Caribou", 0.87, 0.86, "Canadian electronic musician", ["Electronic", "Experimental", "Psychedelic"]],
  ["Kyle Hall", 0.85, 0.45, "Detroit house and techno producer", ["Detroit Techno", "Deep House", "Broken Beat"]],
  ["Kaytranada", 0.84, 0.9, "Haitian-Canadian producer and DJ", ["House", "R&B", "Electronic"]],
  ["Octo Octa", 0.83, 0.58, "American house producer and DJ", ["House", "Breakbeat", "Electronic"]],
  ["Ross From Friends", 0.8, 0.62, "English electronic producer", ["House", "Lo-fi House", "Electronic"]],
  ["Hunee", 0.79, 0.48, "Berlin-based DJ and producer", ["Disco", "House", "Soul"]],
  ["Peggy Gou", 0.77, 0.89, "South Korean DJ and producer", ["House", "Techno", "Electronic"]],
  ["Andrés", 0.76, 0.4, "Detroit producer and DJ", ["Deep House", "Soul", "Hip Hop"]],
  ["Kamaal Williams", 0.74, 0.55, "English keyboardist and producer", ["Nu Jazz", "Broken Beat", "Jazz Fusion"]],
];
write("insights-artists.json", {
  success: true,
  results: {
    entities: artists.map(([name, aff, pop, desc, tags]) => ({
      name,
      entity_id: id(name),
      type: "urn:entity",
      subtype: "urn:entity:artist",
      popularity: pop,
      properties: { short_description: desc },
      tags: tags.map((t) => tag(t)),
      query: { affinity: aff },
    })),
  },
  duration: 112,
});

// ---------- /v2/insights filter.type=urn:demographics ----------
const demo = (name, age, male) => ({
  entity_id: id(name),
  query: {
    age: Object.fromEntries(
      ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"].map((k, i) => [k, age[i]]),
    ),
    gender: { male, female: -male },
  },
});
write("insights-demographics.json", {
  success: true,
  results: {
    demographics: [
      demo("Theo Parrish", [0.05, 0.31, 0.38, 0.12, -0.24, -0.52], 0.18),
      demo("Four Tet", [0.22, 0.41, 0.27, -0.04, -0.35, -0.58], 0.09),
      demo("Kerri Chandler", [-0.02, 0.18, 0.29, 0.26, -0.07, -0.41], 0.05),
    ],
  },
  duration: 37,
});

// ---------- /v2/insights filter.type=urn:entity:brand ----------
const brands = [
  ["Carhartt WIP", 0.92, 0.74, "Apparel"],
  ["Shinola", 0.88, 0.61, "Watches & leather goods"],
  ["Bandcamp", 0.86, 0.66, "Music platform"],
  ["Ableton", 0.84, 0.58, "Music software"],
  ["Del Maguey", 0.79, 0.39, "Mezcal"],
  ["Topo Chico", 0.77, 0.81, "Sparkling water"],
  ["Aesop", 0.73, 0.57, "Skincare"],
  ["Patagonia", 0.7, 0.87, "Outdoor apparel"],
];
write("insights-brands.json", {
  success: true,
  results: {
    entities: brands.map(([name, aff, pop, cat]) => ({
      name,
      entity_id: id(name),
      type: "urn:entity",
      subtype: "urn:entity:brand",
      popularity: pop,
      properties: { short_description: cat },
      tags: [{ id: `urn:tag:category:brand:${cat.toLowerCase().replace(/[^a-z]+/g, "_")}`, name: cat, type: "urn:tag:category:brand" }],
      query: { affinity: aff },
    })),
  },
  duration: 88,
});

// ---------- /v2/insights filter.type=urn:entity:place ----------
const places = [
  ["Spot Lite", 0.9, "2905 Beaufait St, Detroit, MI", "Bar", 42.3561, -83.0313],
  ["Marble Bar", 0.88, "1501 Holden St, Detroit, MI", "Bar & club", 42.3685, -83.0806],
  ["Motor City Wine", 0.84, "1949 Michigan Ave, Detroit, MI", "Wine bar", 42.3311, -83.0719],
  ["Third Man Records Cass Corridor", 0.81, "441 W Canfield St, Detroit, MI", "Record store", 42.3513, -83.0661],
  ["Detroit City Distillery", 0.78, "2462 Riopelle St, Detroit, MI", "Distillery", 42.3467, -83.0412],
  ["Eastern Market", 0.74, "2934 Russell St, Detroit, MI", "Market", 42.3473, -83.0413],
];
write("insights-places.json", {
  success: true,
  results: {
    entities: places.map(([name, aff, addr, cat, lat, lng]) => ({
      name,
      entity_id: id(name),
      type: "urn:entity",
      subtype: "urn:entity:place",
      popularity: 0.5,
      location: { lat, lon: lng },
      properties: { address: addr, short_description: cat },
      tags: [{ id: `urn:tag:category:place:${cat.toLowerCase().replace(/[^a-z]+/g, "_")}`, name: cat, type: "urn:tag:category:place" }],
      query: { affinity: aff },
    })),
  },
  duration: 95,
});

// ---------- /v2/insights filter.type=urn:heatmap ----------
// Deterministic pseudo-random points around Detroit-area neighborhoods.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohash(lat, lon, precision = 6) {
  let latR = [-90, 90], lonR = [-180, 180], hash = "", bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    const r = even ? lonR : latR, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch |= 1 << (4 - bit); r[0] = mid; } else { r[1] = mid; }
    even = !even;
    if (bit < 4) bit++; else { hash += B32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}
const clusters = [
  // [lat, lng, base affinity, points]
  [42.331, -83.068, 0.93, 10], // Corktown
  [42.351, -83.062, 0.9, 10], // Midtown / Cass Corridor
  [42.347, -83.041, 0.84, 6], // Eastern Market
  [42.397, -83.05, 0.82, 6], // Hamtramck
  [42.46, -83.134, 0.76, 6], // Ferndale
  [42.489, -83.144, 0.62, 4], // Royal Oak
  [42.322, -83.176, 0.55, 4], // Dearborn
  [42.28, -83.743, 0.71, 5], // Ann Arbor
  [42.37, -83.0, 0.48, 3], // East side
];
const heat = [];
for (const [lat, lng, base, n] of clusters) {
  for (let i = 0; i < n; i++) {
    const la = +(lat + (rand() - 0.5) * 0.03).toFixed(4);
    const lo = +(lng + (rand() - 0.5) * 0.04).toFixed(4);
    const aff = Math.max(0.2, Math.min(0.99, base + (rand() - 0.5) * 0.12));
    heat.push({
      location: { latitude: la, longitude: lo, geohash: geohash(la, lo) },
      query: { affinity: +aff.toFixed(3), affinity_rank: +Math.min(0.99, aff + 0.03).toFixed(3), popularity: +(0.3 + rand() * 0.6).toFixed(3) },
    });
  }
}
write("insights-heatmap.json", { success: true, results: { heatmap: heat }, duration: 230 });

console.log("wrote fixtures to", out, "heat points:", heat.length);
