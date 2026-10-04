import { findCity, OTHER_CITY } from "./cities";
import type { CustomVenueRequest, VenueInput } from "./types";

// Preset venues for the demo. Venue names are fictional; the artist names are
// real public acts used only as taste signals for Qloo. Each preset has a
// labelled SAMPLE fixture file (fixtures/<id>.json) so it runs without a key.
export const SAMPLE_VENUES: VenueInput[] = [
  {
    id: "detroit-gasworks",
    name: "The Gasworks",
    city: "Detroit, MI",
    locationQuery: "Detroit",
    capacity: 650,
    lat: 42.3314,
    lng: -83.0662,
    headliners: ["Moodymann", "Floating Points", "Jamie xx"],
    genreHint: "deep house",
    blurb: "650-cap converted warehouse in Corktown. Deep house, Detroit techno and left-field electronic nights.",
    fixtureSet: "detroit-gasworks",
  },
  {
    id: "austin-lantern",
    name: "The Lantern Room",
    city: "Austin, TX",
    locationQuery: "Austin",
    capacity: 350,
    lat: 30.2685,
    lng: -97.736,
    headliners: ["Hovvdy", "Wednesday", "Ratboys"],
    genreHint: "indie rock",
    blurb: "350-cap club on Red River. Guitar-led indie rock, alt-country and slacker rock.",
    fixtureSet: "austin-lantern",
  },
  {
    id: "brooklyn-lowtide",
    name: "Low Tide Hall",
    city: "Brooklyn, NY",
    locationQuery: "Brooklyn",
    capacity: 500,
    lat: 40.6958,
    lng: -73.9262,
    headliners: ["MIKE", "Navy Blue", "billy woods"],
    genreHint: "underground hip hop",
    blurb: "500-cap Bushwick room. Underground, abstract and jazz-leaning hip-hop.",
    fixtureSet: "brooklyn-lowtide",
  },
  {
    id: "nashville-copperline",
    name: "Copperline",
    city: "Nashville, TN",
    locationQuery: "Nashville",
    capacity: 250,
    lat: 36.1768,
    lng: -86.7495,
    headliners: ["S.G. Goodman", "Joshua Hedley", "Kelsey Waldon"],
    genreHint: "americana",
    blurb: "250-cap East Nashville bar. Americana, honky-tonk and songwriter nights.",
    fixtureSet: "nashville-copperline",
  },
  {
    id: "london-basement",
    name: "Basement Nine",
    city: "London, UK",
    locationQuery: "London",
    capacity: 220,
    lat: 51.5465,
    lng: -0.0753,
    headliners: ["Nubya Garcia", "Alfa Mist", "Kokoroko"],
    genreHint: "jazz",
    blurb: "220-cap Dalston basement. The new London jazz scene, Afrobeat and broken beat.",
    fixtureSet: "london-basement",
  },
];

export const CAPACITY_MIN = 50;
export const CAPACITY_MAX = 20000;

/** Strips control characters and angle brackets, collapses whitespace, caps length. */
const clean = (v: unknown, max: number) =>
  typeof v === "string"
    ? Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "<" || c === ">" ? " " : c))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** Validates a custom venue from the browser. Returns the venue or a user-facing error. */
export function customVenue(raw: unknown): { venue?: VenueInput; error?: string } {
  const r = (raw ?? {}) as Partial<CustomVenueRequest>;
  const name = clean(r.name, 80);
  if (!name) return { error: "Give the venue a name." };
  const capacity = Math.round(Number(r.capacity));
  if (!Number.isFinite(capacity) || capacity < CAPACITY_MIN || capacity > CAPACITY_MAX)
    return { error: `Capacity must be a number between ${CAPACITY_MIN} and ${CAPACITY_MAX}.` };
  const headliners = (Array.isArray(r.headliners) ? r.headliners : [])
    .map((h) => clean(h, 80))
    .filter(Boolean)
    .slice(0, 3);
  if (!headliners.length) return { error: "Add at least one past headliner." };
  const genreHint = clean(r.genre, 40);

  const cityId = clean(r.cityId, 40);
  const city = findCity(cityId);
  let label: string, query: string, lat = 0, lng = 0, needsGeocode = false;
  if (city) {
    ({ label, query, lat, lng } = city);
  } else if (cityId === OTHER_CITY) {
    const other = clean(r.otherCity, 60);
    if (other.length < 2) return { error: "Type the city name." };
    label = other;
    query = other;
    needsGeocode = true;
  } else {
    return { error: "Pick a city from the list, or choose Other." };
  }

  return {
    venue: {
      id: "custom",
      name,
      city: label,
      locationQuery: query,
      capacity,
      lat,
      lng,
      headliners,
      genreHint,
      blurb: `${capacity}-cap venue in ${label} (entered by you).`,
      custom: true,
      needsGeocode,
    },
  };
}
