// Small bundled city list for the custom-venue form. No geocoding service is
// needed for these. Any other city is located through Qloo's own /search
// (types=urn:entity:locality) in live mode.
// `query` is the free-text location handed to Qloo (signal/filter.location.query).

export interface City {
  id: string;
  label: string;
  query: string;
  region: "US" | "Europe";
  lat: number;
  lng: number;
}

export const CITIES: City[] = [
  { id: "atlanta", label: "Atlanta, GA", query: "Atlanta", region: "US", lat: 33.749, lng: -84.388 },
  { id: "austin", label: "Austin, TX", query: "Austin", region: "US", lat: 30.2672, lng: -97.7431 },
  { id: "boston", label: "Boston, MA", query: "Boston", region: "US", lat: 42.3601, lng: -71.0589 },
  { id: "brooklyn", label: "Brooklyn, NY", query: "Brooklyn", region: "US", lat: 40.6782, lng: -73.9442 },
  { id: "chicago", label: "Chicago, IL", query: "Chicago", region: "US", lat: 41.8781, lng: -87.6298 },
  { id: "denver", label: "Denver, CO", query: "Denver", region: "US", lat: 39.7392, lng: -104.9903 },
  { id: "detroit", label: "Detroit, MI", query: "Detroit", region: "US", lat: 42.3314, lng: -83.0458 },
  { id: "los-angeles", label: "Los Angeles, CA", query: "Los Angeles", region: "US", lat: 34.0522, lng: -118.2437 },
  { id: "miami", label: "Miami, FL", query: "Miami", region: "US", lat: 25.7617, lng: -80.1918 },
  { id: "minneapolis", label: "Minneapolis, MN", query: "Minneapolis", region: "US", lat: 44.9778, lng: -93.265 },
  { id: "nashville", label: "Nashville, TN", query: "Nashville", region: "US", lat: 36.1627, lng: -86.7816 },
  { id: "new-orleans", label: "New Orleans, LA", query: "New Orleans", region: "US", lat: 29.9511, lng: -90.0715 },
  { id: "new-york", label: "New York, NY", query: "New York", region: "US", lat: 40.7128, lng: -74.006 },
  { id: "philadelphia", label: "Philadelphia, PA", query: "Philadelphia", region: "US", lat: 39.9526, lng: -75.1652 },
  { id: "portland", label: "Portland, OR", query: "Portland, Oregon", region: "US", lat: 45.5152, lng: -122.6784 },
  { id: "san-francisco", label: "San Francisco, CA", query: "San Francisco", region: "US", lat: 37.7749, lng: -122.4194 },
  { id: "seattle", label: "Seattle, WA", query: "Seattle", region: "US", lat: 47.6062, lng: -122.3321 },
  { id: "washington-dc", label: "Washington, DC", query: "Washington, D.C.", region: "US", lat: 38.9072, lng: -77.0369 },
  { id: "amsterdam", label: "Amsterdam, NL", query: "Amsterdam", region: "Europe", lat: 52.3676, lng: 4.9041 },
  { id: "barcelona", label: "Barcelona, ES", query: "Barcelona", region: "Europe", lat: 41.3874, lng: 2.1686 },
  { id: "berlin", label: "Berlin, DE", query: "Berlin", region: "Europe", lat: 52.52, lng: 13.405 },
  { id: "brussels", label: "Brussels, BE", query: "Brussels", region: "Europe", lat: 50.8503, lng: 4.3517 },
  { id: "copenhagen", label: "Copenhagen, DK", query: "Copenhagen", region: "Europe", lat: 55.6761, lng: 12.5683 },
  { id: "dublin", label: "Dublin, IE", query: "Dublin", region: "Europe", lat: 53.3498, lng: -6.2603 },
  { id: "glasgow", label: "Glasgow, UK", query: "Glasgow", region: "Europe", lat: 55.8642, lng: -4.2518 },
  { id: "lisbon", label: "Lisbon, PT", query: "Lisbon", region: "Europe", lat: 38.7223, lng: -9.1393 },
  { id: "london", label: "London, UK", query: "London", region: "Europe", lat: 51.5072, lng: -0.1276 },
  { id: "manchester", label: "Manchester, UK", query: "Manchester", region: "Europe", lat: 53.4808, lng: -2.2426 },
  { id: "madrid", label: "Madrid, ES", query: "Madrid", region: "Europe", lat: 40.4168, lng: -3.7038 },
  { id: "milan", label: "Milan, IT", query: "Milan", region: "Europe", lat: 45.4642, lng: 9.19 },
  { id: "paris", label: "Paris, FR", query: "Paris", region: "Europe", lat: 48.8566, lng: 2.3522 },
  { id: "prague", label: "Prague, CZ", query: "Prague", region: "Europe", lat: 50.0755, lng: 14.4378 },
  { id: "stockholm", label: "Stockholm, SE", query: "Stockholm", region: "Europe", lat: 59.3293, lng: 18.0686 },
  { id: "vienna", label: "Vienna, AT", query: "Vienna", region: "Europe", lat: 48.2082, lng: 16.3738 },
];

export const OTHER_CITY = "__other";

export function findCity(id: string): City | undefined {
  return CITIES.find((c) => c.id === id);
}
