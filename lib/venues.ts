import type { VenueInput } from "./types";

// Sample venues for the demo. Venue names are fictional; the artist names are
// real public acts used only as taste signals for Qloo.
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
    blurb:
      "650-cap converted warehouse in Corktown. Deep house, Detroit techno and left-field electronic nights.",
  },
];

/** Venues that have recorded sample data, so they work without a Qloo key. */
export const FIXTURE_VENUE_IDS = new Set(["detroit-gasworks"]);
