// Generates the SAMPLE (fixture) Qloo responses used when QLOO_API_KEY is not set.
//
// These are NOT recorded from the live Qloo API. They follow the response shapes
// documented for the Qloo hackathon API (/search, /v2/tags, /v2/insights with
// filter.type = urn:tag | urn:entity:artist | urn:entity:brand | urn:entity:place |
// urn:heatmap | urn:demographics). Every score below is an illustrative value chosen
// by hand. Venue names are fictional; artist, brand and place names are real public
// names used only as examples. The UI labels every fixture-backed result "Sample".
//
// One file per preset venue: fixtures/<venue-id>.json
// Run: node scripts/make-fixtures.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "fixtures");
mkdirSync(outDir, { recursive: true });

const NOTE =
  "SAMPLE DATA: hand-written fixture in the documented Qloo response shape. Not a live Qloo response.";

function id(name) {
  const h = createHash("sha1").update("fixture:" + name).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function hashUnit(s) {
  return parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
}
function tag(name, type = "urn:tag:genre:music") {
  const slug = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return { id: `${type}:${slug}`, name, type };
}
const artistEntity = (name, popularity, desc, tags, key = name) => ({
  name,
  entity_id: id(key),
  type: "urn:entity",
  subtype: "urn:entity:artist",
  types: ["urn:entity:artist"],
  popularity,
  properties: { short_description: desc },
  tags: tags.map((t) => tag(t)),
});

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

const AGE_KEYS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

// ---------------------------------------------------------------------------
// Preset venues. Each defines: search hits per headliner, genre tag lookup,
// taste-profile tags, candidate artists [name, affinity, popularity, desc, tags],
// a base age profile, brands, places and heatmap clusters.
// The popularity spread is chosen so each preset exercises a different branch
// of the agent: Detroit and Brooklyn disambiguate search hits, Austin narrows
// the popularity band, Nashville widens it, London keeps it.
// ---------------------------------------------------------------------------
const VENUES = [
  {
    id: "detroit-gasworks",
    search: {
      moodymann: [["Moodymann", 0.82, "Detroit house producer and DJ", ["Deep House", "Detroit Techno", "Soul"]]],
      "floating points": [["Floating Points", 0.84, "English electronic musician and producer", ["Electronic", "Nu Jazz", "Ambient"]]],
      // Ambiguous on purpose: two artist entities match "jamie xx".
      "jamie xx": [
        ["Jamie xx", 0.9, "English producer, DJ and member of The xx", ["Electronic", "House", "UK Garage"]],
        ["The xx", 0.93, "English indie pop band", ["Indie Pop", "Dream Pop"]],
      ],
    },
    genreKeywords: ["house", "techno"],
    genreTags: ["Deep House", "House", "Soulful House", "Chicago House", "Tech House"],
    taste: [["Deep House", 0.94], ["Detroit Techno", 0.91], ["Electronic", 0.89], ["House", 0.86], ["Nu Jazz", 0.78], ["Ambient", 0.72], ["Soul", 0.7], ["Experimental", 0.68], ["Disco", 0.66], ["Broken Beat", 0.61]],
    artists: [
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
    ],
    age: [0.05, 0.31, 0.33, 0.1, -0.24, -0.52],
    male: 0.12,
    brands: [["Carhartt WIP", 0.92, 0.74, "Apparel"], ["Shinola", 0.88, 0.61, "Watches & leather goods"], ["Bandcamp", 0.86, 0.66, "Music platform"], ["Ableton", 0.84, 0.58, "Music software"], ["Del Maguey", 0.79, 0.39, "Mezcal"], ["Topo Chico", 0.77, 0.81, "Sparkling water"], ["Aesop", 0.73, 0.57, "Skincare"], ["Patagonia", 0.7, 0.87, "Outdoor apparel"]],
    places: [
      ["Spot Lite", 0.9, "2905 Beaufait St, Detroit, MI", "Bar", 42.3561, -83.0313],
      ["Marble Bar", 0.88, "1501 Holden St, Detroit, MI", "Bar & club", 42.3685, -83.0806],
      ["Motor City Wine", 0.84, "1949 Michigan Ave, Detroit, MI", "Wine bar", 42.3311, -83.0719],
      ["Third Man Records Cass Corridor", 0.81, "441 W Canfield St, Detroit, MI", "Record store", 42.3513, -83.0661],
      ["Detroit City Distillery", 0.78, "2462 Riopelle St, Detroit, MI", "Distillery", 42.3467, -83.0412],
      ["Eastern Market", 0.74, "2934 Russell St, Detroit, MI", "Market", 42.3473, -83.0413],
    ],
    clusters: [[42.331, -83.068, 0.93, 10], [42.351, -83.062, 0.9, 10], [42.347, -83.041, 0.84, 6], [42.397, -83.05, 0.82, 6], [42.46, -83.134, 0.76, 6], [42.489, -83.144, 0.62, 4], [42.322, -83.176, 0.55, 4], [42.28, -83.743, 0.71, 5], [42.37, -83.0, 0.48, 3]],
  },
  {
    id: "austin-lantern",
    search: {
      hovvdy: [["Hovvdy", 0.55, "Texas indie rock duo", ["Indie Rock", "Bedroom Pop", "Lo-fi"]]],
      wednesday: [["Wednesday", 0.66, "Asheville indie rock band", ["Indie Rock", "Alt-Country", "Shoegaze"]]],
      ratboys: [["Ratboys", 0.5, "Chicago indie rock band", ["Indie Rock", "Alt-Country", "Emo"]]],
    },
    genreKeywords: ["indie", "rock"],
    genreTags: ["Indie Rock", "Slacker Rock", "Alt-Country", "Lo-fi"],
    taste: [["Indie Rock", 0.95], ["Alt-Country", 0.88], ["Slacker Rock", 0.84], ["Lo-fi", 0.8], ["Shoegaze", 0.77], ["Emo", 0.72], ["Bedroom Pop", 0.7], ["Folk Rock", 0.68], ["Dream Pop", 0.64], ["Post-Punk", 0.6]],
    artists: [
      ["MJ Lenderman", 0.91, 0.68, "Asheville singer-songwriter and guitarist", ["Indie Rock", "Alt-Country", "Slacker Rock"]],
      ["Squirrel Flower", 0.9, 0.52, "American singer-songwriter", ["Indie Rock", "Folk Rock", "Shoegaze"]],
      ["Horse Jumper of Love", 0.88, 0.5, "Boston indie rock band", ["Slacker Rock", "Lo-fi", "Indie Rock"]],
      ["Hurray for the Riff Raff", 0.86, 0.6, "American folk rock project", ["Folk Rock", "Alt-Country"]],
      ["Florist", 0.85, 0.47, "Brooklyn indie folk band", ["Bedroom Pop", "Folk Rock", "Lo-fi"]],
      ["Pinegrove", 0.84, 0.73, "New Jersey indie rock band", ["Indie Rock", "Emo", "Alt-Country"]],
      ["Snail Mail", 0.83, 0.78, "Baltimore indie rock project", ["Indie Rock", "Dream Pop"]],
      ["Waxahatchee", 0.82, 0.81, "American singer-songwriter", ["Indie Rock", "Alt-Country", "Folk Rock"]],
      ["Big Thief", 0.8, 0.86, "Brooklyn indie rock band", ["Indie Rock", "Folk Rock"]],
      ["Truth Club", 0.79, 0.33, "North Carolina indie rock band", ["Post-Punk", "Indie Rock", "Shoegaze"]],
      ["Dehd", 0.78, 0.55, "Chicago indie rock trio", ["Post-Punk", "Indie Rock", "Lo-fi"]],
      ["Indigo De Souza", 0.77, 0.66, "American singer-songwriter", ["Indie Rock", "Emo", "Bedroom Pop"]],
      ["Ryley Walker", 0.74, 0.44, "American guitarist and songwriter", ["Folk Rock", "Indie Rock"]],
      ["Lomelda", 0.73, 0.36, "Texas indie folk project", ["Bedroom Pop", "Lo-fi", "Folk Rock"]],
    ],
    age: [0.28, 0.36, 0.2, -0.05, -0.33, -0.55],
    male: 0.04,
    brands: [["Topo Chico", 0.9, 0.81, "Sparkling water"], ["Fender", 0.87, 0.79, "Musical instruments"], ["Bandcamp", 0.86, 0.66, "Music platform"], ["Lone Star Beer", 0.82, 0.6, "Beer"], ["Polaroid", 0.79, 0.7, "Cameras"], ["YETI", 0.76, 0.82, "Outdoor gear"], ["Patagonia", 0.74, 0.87, "Outdoor apparel"], ["Tecovas", 0.7, 0.58, "Western boots"]],
    places: [
      ["Cheer Up Charlies", 0.9, "Red River, Austin, TX", "Bar & venue", 30.2689, -97.736],
      ["Hotel Vegas", 0.88, "East Austin, TX", "Bar & venue", 30.2621, -97.7224],
      ["Waterloo Records", 0.86, "North Lamar, Austin, TX", "Record store", 30.2766, -97.7536],
      ["Spider House Cafe", 0.82, "West Campus, Austin, TX", "Cafe & bar", 30.2967, -97.7425],
      ["Barton Springs Pool", 0.77, "Zilker, Austin, TX", "Park", 30.2639, -97.7713],
      ["Kerbey Lane Cafe", 0.73, "Austin, TX", "Restaurant", 30.2944, -97.7444],
    ],
    clusters: [[30.262, -97.722, 0.92, 9], [30.268, -97.736, 0.9, 8], [30.305, -97.728, 0.84, 7], [30.248, -97.75, 0.8, 6], [30.298, -97.705, 0.74, 5], [30.318, -97.718, 0.7, 5], [30.266, -97.772, 0.66, 4], [30.205, -97.79, 0.5, 3]],
  },
  {
    id: "brooklyn-lowtide",
    search: {
      mike: [["MIKE", 0.6, "New York rapper and producer", ["Underground Hip Hop", "Abstract Hip Hop", "Jazz Rap"]]],
      // Ambiguous on purpose: two artist entities share the exact name "Navy Blue".
      "navy blue": [
        ["Navy Blue", 0.55, "Los Angeles rapper and producer", ["Underground Hip Hop", "Jazz Rap", "Lo-fi Hip Hop"], "Navy Blue (rapper)"],
        ["Navy Blue", 0.31, "Synth-pop duo (illustrative sample entity)", ["Synth-pop", "Indie Pop"], "Navy Blue (synth-pop)"],
      ],
      "billy woods": [["billy woods", 0.58, "New York rapper", ["Abstract Hip Hop", "Experimental Hip Hop", "Underground Hip Hop"]]],
    },
    genreKeywords: ["hip hop", "rap"],
    genreTags: ["Underground Hip Hop", "Abstract Hip Hop", "Jazz Rap"],
    taste: [["Underground Hip Hop", 0.95], ["Abstract Hip Hop", 0.92], ["Jazz Rap", 0.88], ["Experimental Hip Hop", 0.84], ["Lo-fi Hip Hop", 0.8], ["Boom Bap", 0.76], ["Conscious Hip Hop", 0.72], ["Soul", 0.69], ["Neo Soul", 0.64], ["Jazz", 0.6]],
    artists: [
      ["Earl Sweatshirt", 0.93, 0.84, "American rapper and producer", ["Abstract Hip Hop", "Underground Hip Hop", "Jazz Rap"]],
      ["Armand Hammer", 0.9, 0.55, "New York hip hop duo", ["Abstract Hip Hop", "Experimental Hip Hop"]],
      ["Mavi", 0.88, 0.58, "Charlotte rapper", ["Conscious Hip Hop", "Jazz Rap", "Underground Hip Hop"]],
      ["Pink Siifu", 0.86, 0.52, "American rapper and producer", ["Experimental Hip Hop", "Neo Soul", "Lo-fi Hip Hop"]],
      ["Medhane", 0.84, 0.4, "Brooklyn rapper", ["Underground Hip Hop", "Lo-fi Hip Hop"]],
      ["Liv.e", 0.83, 0.6, "Dallas singer and producer", ["Neo Soul", "Soul", "Experimental Hip Hop"]],
      ["Maxo", 0.81, 0.42, "Los Angeles rapper", ["Lo-fi Hip Hop", "Jazz Rap"]],
      ["Wiki", 0.8, 0.5, "New York rapper", ["Underground Hip Hop", "Boom Bap"]],
      ["Quelle Chris", 0.79, 0.5, "Detroit rapper and producer", ["Abstract Hip Hop", "Experimental Hip Hop"]],
      ["Mach-Hommy", 0.78, 0.62, "Haitian-American rapper", ["Boom Bap", "Underground Hip Hop"]],
      ["Akai Solo", 0.75, 0.38, "Brooklyn rapper", ["Abstract Hip Hop", "Lo-fi Hip Hop"]],
      ["Danny Brown", 0.74, 0.87, "Detroit rapper", ["Experimental Hip Hop", "Hip Hop"]],
      ["KeiyaA", 0.72, 0.5, "Chicago-born singer and producer", ["Neo Soul", "Jazz", "Experimental Hip Hop"]],
    ],
    age: [0.34, 0.38, 0.16, -0.08, -0.36, -0.6],
    male: 0.22,
    brands: [["Stüssy", 0.9, 0.76, "Streetwear"], ["Brooklyn Brewery", 0.88, 0.62, "Beer"], ["Carhartt WIP", 0.86, 0.74, "Apparel"], ["Bandcamp", 0.84, 0.66, "Music platform"], ["Telfar", 0.82, 0.55, "Fashion"], ["Kith", 0.78, 0.68, "Streetwear"], ["Liquid Death", 0.74, 0.7, "Canned water"], ["Supreme", 0.71, 0.88, "Streetwear"]],
    places: [
      ["Human Head Records", 0.89, "Bushwick, Brooklyn, NY", "Record store", 40.7069, -73.933],
      ["Fort Greene Park", 0.84, "Fort Greene, Brooklyn, NY", "Park", 40.6913, -73.9744],
      ["Brooklyn Museum", 0.82, "Prospect Heights, Brooklyn, NY", "Museum", 40.6712, -73.9636],
      ["Domino Park", 0.79, "Williamsburg, Brooklyn, NY", "Park", 40.7146, -73.9677],
      ["Prospect Park", 0.75, "Brooklyn, NY", "Park", 40.6602, -73.969],
    ],
    clusters: [[40.6944, -73.9213, 0.93, 9], [40.6872, -73.9418, 0.91, 9], [40.6694, -73.9422, 0.86, 7], [40.7081, -73.9571, 0.82, 6], [40.6892, -73.9742, 0.78, 6], [40.7043, -73.9018, 0.74, 5], [40.6501, -73.9496, 0.68, 4]],
  },
  {
    id: "nashville-copperline",
    search: {
      "s.g. goodman": [["S.G. Goodman", 0.42, "Kentucky singer-songwriter", ["Americana", "Alt-Country", "Southern Rock"]]],
      "joshua hedley": [["Joshua Hedley", 0.4, "Nashville country singer and fiddler", ["Classic Country", "Honky Tonk", "Americana"]]],
      "kelsey waldon": [["Kelsey Waldon", 0.44, "Kentucky country singer-songwriter", ["Americana", "Classic Country", "Folk"]]],
    },
    genreKeywords: ["americana", "country", "folk"],
    genreTags: ["Americana", "Alt-Country", "Honky Tonk"],
    taste: [["Americana", 0.96], ["Alt-Country", 0.92], ["Classic Country", 0.88], ["Honky Tonk", 0.84], ["Folk", 0.8], ["Bluegrass", 0.75], ["Southern Rock", 0.72], ["Singer-Songwriter", 0.7], ["Outlaw Country", 0.67], ["Roots Rock", 0.62]],
    artists: [
      ["Tyler Childers", 0.92, 0.9, "Kentucky country singer-songwriter", ["Americana", "Bluegrass", "Outlaw Country"]],
      ["Sierra Ferrell", 0.9, 0.78, "West Virginia singer-songwriter", ["Americana", "Bluegrass", "Folk"]],
      ["Charley Crockett", 0.89, 0.82, "Texas country singer", ["Honky Tonk", "Classic Country", "Americana"]],
      ["Colter Wall", 0.87, 0.84, "Canadian country singer-songwriter", ["Outlaw Country", "Folk", "Americana"]],
      ["Margo Price", 0.86, 0.74, "Nashville country singer-songwriter", ["Alt-Country", "Outlaw Country", "Americana"]],
      ["Sturgill Simpson", 0.85, 0.88, "Kentucky country singer", ["Outlaw Country", "Southern Rock"]],
      ["Jaime Wyatt", 0.84, 0.58, "Country singer-songwriter", ["Outlaw Country", "Americana", "Honky Tonk"]],
      ["Logan Ledger", 0.82, 0.41, "Nashville country singer", ["Classic Country", "Honky Tonk"]],
      ["Morgan Wade", 0.8, 0.76, "Virginia country singer-songwriter", ["Alt-Country", "Singer-Songwriter"]],
      ["Nick Shoulders", 0.79, 0.52, "Arkansas country singer", ["Honky Tonk", "Folk", "Americana"]],
      ["Vincent Neil Emerson", 0.78, 0.49, "Texas singer-songwriter", ["Americana", "Singer-Songwriter", "Folk"]],
      ["Lilly Hiatt", 0.76, 0.5, "Nashville singer-songwriter", ["Alt-Country", "Roots Rock"]],
    ],
    age: [0.02, 0.18, 0.27, 0.22, -0.04, -0.3],
    male: 0.08,
    brands: [["Gibson", 0.91, 0.8, "Guitars"], ["Wrangler", 0.86, 0.83, "Denim"], ["YETI", 0.85, 0.82, "Outdoor gear"], ["Tecovas", 0.84, 0.58, "Western boots"], ["Filson", 0.83, 0.6, "Outdoor apparel"], ["Pabst Blue Ribbon", 0.78, 0.74, "Beer"], ["Jack Daniel's", 0.76, 0.9, "Whiskey"], ["Duluth Trading Co.", 0.7, 0.6, "Workwear"]],
    places: [
      ["The Station Inn", 0.91, "The Gulch, Nashville, TN", "Bluegrass club", 36.1527, -86.7845],
      ["Robert's Western World", 0.88, "Lower Broadway, Nashville, TN", "Honky-tonk", 36.1609, -86.7774],
      ["Dino's Bar", 0.85, "East Nashville, TN", "Dive bar", 36.1773, -86.7485],
      ["Third Man Records Nashville", 0.82, "Cummins Station, Nashville, TN", "Record store", 36.153, -86.7766],
      ["The 5 Spot", 0.8, "East Nashville, TN", "Bar & venue", 36.177, -86.7492],
      ["Hattie B's Hot Chicken", 0.74, "Midtown, Nashville, TN", "Restaurant", 36.1514, -86.7965],
    ],
    clusters: [[36.177, -86.749, 0.94, 10], [36.125, -86.789, 0.84, 6], [36.162, -86.85, 0.8, 6], [36.18, -86.791, 0.83, 6], [36.152, -86.8, 0.78, 5], [36.212, -86.735, 0.86, 6], [36.1, -86.72, 0.6, 3]],
  },
  {
    id: "london-basement",
    search: {
      "nubya garcia": [["Nubya Garcia", 0.62, "London saxophonist and composer", ["UK Jazz", "Spiritual Jazz", "Afrobeat"]]],
      "alfa mist": [["Alfa Mist", 0.57, "London pianist and producer", ["UK Jazz", "Jazz Hip Hop", "Neo Soul"]]],
      kokoroko: [["Kokoroko", 0.6, "London Afrobeat collective", ["Afrobeat", "UK Jazz", "Highlife"]]],
    },
    genreKeywords: ["jazz"],
    genreTags: ["UK Jazz", "Spiritual Jazz", "Jazz Fusion"],
    taste: [["UK Jazz", 0.96], ["Spiritual Jazz", 0.9], ["Afrobeat", 0.87], ["Jazz Fusion", 0.84], ["Broken Beat", 0.8], ["Neo Soul", 0.77], ["Jazz Hip Hop", 0.74], ["Highlife", 0.68], ["Grime", 0.62], ["Dub", 0.58]],
    artists: [
      ["Ezra Collective", 0.91, 0.82, "London jazz quintet", ["UK Jazz", "Afrobeat", "Broken Beat"]],
      ["Yussef Dayes", 0.9, 0.74, "London drummer and producer", ["UK Jazz", "Jazz Fusion", "Broken Beat"]],
      ["Moses Boyd", 0.89, 0.6, "London drummer and producer", ["UK Jazz", "Broken Beat", "Grime"]],
      ["Shabaka", 0.88, 0.69, "London saxophonist and flautist", ["Spiritual Jazz", "UK Jazz"]],
      ["Theon Cross", 0.87, 0.48, "London tuba player", ["UK Jazz", "Grime", "Dub"]],
      ["Emma-Jean Thackray", 0.86, 0.55, "Yorkshire trumpeter and producer", ["Jazz Fusion", "Spiritual Jazz", "Neo Soul"]],
      ["Joe Armon-Jones", 0.85, 0.5, "London keyboardist", ["UK Jazz", "Dub", "Jazz Fusion"]],
      ["Binker and Moses", 0.84, 0.45, "London sax and drums duo", ["Spiritual Jazz", "UK Jazz"]],
      ["Ashley Henry", 0.82, 0.4, "London pianist", ["UK Jazz", "Jazz Hip Hop"]],
      ["Tom Misch", 0.79, 0.85, "London guitarist and producer", ["Neo Soul", "Jazz Hip Hop"]],
      ["Sarathy Korwar", 0.78, 0.42, "London drummer and composer", ["Spiritual Jazz", "Jazz Fusion"]],
      ["Cykada", 0.77, 0.26, "London jazz quintet", ["Jazz Fusion", "Afrobeat"]],
      ["Ill Considered", 0.76, 0.24, "London improvising quartet", ["Spiritual Jazz", "UK Jazz"]],
      ["Steam Down", 0.75, 0.28, "London jazz collective", ["UK Jazz", "Afrobeat", "Broken Beat"]],
      ["Oscar Jerome", 0.74, 0.5, "London guitarist and singer", ["Neo Soul", "Jazz Fusion"]],
    ],
    age: [0.12, 0.34, 0.3, 0.06, -0.2, -0.45],
    male: 0.06,
    brands: [["Blue Note Records", 0.9, 0.7, "Record label"], ["Rough Trade", 0.88, 0.62, "Record shop"], ["Fred Perry", 0.86, 0.74, "Apparel"], ["Beavertown", 0.85, 0.56, "Beer"], ["Aesop", 0.79, 0.57, "Skincare"], ["Margaret Howell", 0.77, 0.44, "Fashion"], ["Monocle", 0.75, 0.5, "Magazine"], ["Patagonia", 0.71, 0.87, "Outdoor apparel"]],
    places: [
      ["Café OTO", 0.92, "Dalston, London", "Venue & cafe", 51.5487, -0.0755],
      ["Brilliant Corners", 0.9, "Dalston, London", "Listening bar", 51.5485, -0.0753],
      ["Total Refreshment Centre", 0.86, "Stoke Newington, London", "Venue & studio", 51.5568, -0.0731],
      ["Rye Wax", 0.83, "Peckham, London", "Record shop & bar", 51.474, -0.0694],
      ["Phonica Records", 0.8, "Soho, London", "Record shop", 51.5137, -0.1376],
      ["Ridley Road Market", 0.74, "Dalston, London", "Market", 51.547, -0.073],
    ],
    clusters: [[51.546, -0.075, 0.94, 10], [51.545, -0.0553, 0.9, 7], [51.474, -0.069, 0.88, 8], [51.4613, -0.1156, 0.84, 6], [51.5265, -0.0786, 0.82, 6], [51.4787, -0.0262, 0.78, 5], [51.539, -0.1426, 0.7, 4]],
  },
];

for (const v of VENUES) {
  // Deterministic pseudo-random generator per venue.
  let seed = Math.floor(hashUnit(v.id) * 4294967296);
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  const search = {};
  for (const [q, hits] of Object.entries(v.search)) {
    search[q] = { results: hits.map(([n, pop, desc, tags, key]) => artistEntity(n, pop, desc, tags, key)) };
  }

  const artistEntities = v.artists.map(([name, aff, pop, desc, tags]) => ({
    ...artistEntity(name, pop, desc, tags),
    query: { affinity: aff },
  }));

  const demographics = v.artists.map(([name]) => {
    const m = +(v.male + (hashUnit(name + "g") - 0.5) * 0.2).toFixed(2);
    return {
      entity_id: id(name),
      query: {
        age: Object.fromEntries(AGE_KEYS.map((k, i) => [k, +(v.age[i] + (hashUnit(name + k) - 0.5) * 0.16).toFixed(2)])),
        gender: { male: m, female: -m },
      },
    };
  });

  const heat = [];
  for (const [lat, lng, base, n] of v.clusters) {
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

  const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, "_");
  const file = {
    _fixture: NOTE,
    search,
    tags: { keywords: v.genreKeywords, response: { results: { tags: v.genreTags.map((n) => tag(n)) } } },
    insights: {
      tag: {
        success: true,
        results: {
          tags: v.taste.map(([n, a]) => ({ tag_id: tag(n).id, name: n, types: ["urn:entity:artist"], subtype: "urn:tag:genre:music", query: { affinity: a } })),
        },
      },
      artist: { success: true, results: { entities: artistEntities } },
      demographics: { success: true, results: { demographics } },
      brand: {
        success: true,
        results: {
          entities: v.brands.map(([name, aff, pop, cat]) => ({
            name,
            entity_id: id(name),
            type: "urn:entity",
            subtype: "urn:entity:brand",
            popularity: pop,
            properties: { short_description: cat },
            tags: [{ id: `urn:tag:category:brand:${slug(cat)}`, name: cat, type: "urn:tag:category:brand" }],
            query: { affinity: aff },
          })),
        },
      },
      place: {
        success: true,
        results: {
          entities: v.places.map(([name, aff, addr, cat, lat, lng]) => ({
            name,
            entity_id: id(name),
            type: "urn:entity",
            subtype: "urn:entity:place",
            popularity: 0.5,
            location: { lat, lon: lng },
            properties: { address: addr, short_description: cat },
            tags: [{ id: `urn:tag:category:place:${slug(cat)}`, name: cat, type: "urn:tag:category:place" }],
            query: { affinity: aff },
          })),
        },
      },
      heatmap: { success: true, results: { heatmap: heat } },
    },
  };
  writeFileSync(join(outDir, `${v.id}.json`), JSON.stringify(file) + "\n");
  console.log("wrote", `${v.id}.json`, "artists:", v.artists.length, "heat:", heat.length);
}
