"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { HeatPoint, PlacePick, VenueInput } from "@/lib/types";

interface Props {
  venue: VenueInput;
  points: HeatPoint[];
  places: PlacePick[];
}

// Colour ramp for affinity 0..1 (light yellow -> deep red), readable on a light basemap.
export function affinityColor(a: number): string {
  if (a >= 0.9) return "#a50026";
  if (a >= 0.8) return "#d73027";
  if (a >= 0.7) return "#f46d43";
  if (a >= 0.6) return "#fdae61";
  return "#fee08b";
}

export default function AffinityMap({ venue, points, places }: Props) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let map: import("leaflet").Map | undefined;
    (async () => {
      const L = (await import("leaflet")).default;
      if (disposed || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      const bounds = L.latLngBounds([[venue.lat, venue.lng]]);
      for (const p of points) {
        L.circle([p.lat, p.lng], {
          radius: 650,
          stroke: false,
          fillColor: affinityColor(p.affinity),
          fillOpacity: 0.55,
        })
          .bindTooltip(`Affinity ${Math.round(p.affinity * 100)}`)
          .addTo(map);
        bounds.extend([p.lat, p.lng]);
      }
      for (const pl of places) {
        if (pl.lat === undefined || pl.lng === undefined) continue;
        L.circleMarker([pl.lat, pl.lng], { radius: 6, color: "#3b1f8f", weight: 2, fillColor: "#ffffff", fillOpacity: 1 })
          .bindTooltip(`${pl.name} (partner spot)`)
          .addTo(map);
      }
      L.circleMarker([venue.lat, venue.lng], { radius: 9, color: "#111", weight: 3, fillColor: "#22c55e", fillOpacity: 1 })
        .bindTooltip(`${venue.name} (venue)`, { permanent: false })
        .addTo(map);
      map.fitBounds(bounds.pad(0.1));
    })();
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [venue, points, places]);

  return (
    <div
      ref={el}
      className="map"
      role="img"
      aria-label={`Map of ${venue.city} showing ${points.length} areas shaded by taste affinity, the venue, and ${places.length} partner spots`}
    />
  );
}
