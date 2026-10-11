"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { HeatPoint, PlacePick, VenueInput } from "@/lib/types";

interface Props {
  venue: VenueInput;
  points: HeatPoint[];
  places: PlacePick[];
}

const FRAME_KM = 25;

function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Colour ramp for affinity 0..1 (light yellow -> deep red), readable on the darkened basemap.
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

      const located = !venue.needsGeocode;
      // Frame the venue's metro: cells far out of town are still drawn but do not
      // zoom the map out (e.g. Ann Arbor cells for a Detroit venue).
      const near = located ? points.filter((p) => kmBetween(venue.lat, venue.lng, p.lat, p.lng) <= FRAME_KM) : points;
      const framed = near.length ? near : points;
      const bounds = located ? L.latLngBounds([[venue.lat, venue.lng]]) : L.latLngBounds(framed.map((p) => [p.lat, p.lng] as [number, number]));
      for (const p of framed) bounds.extend([p.lat, p.lng]);
      for (const p of points) {
        L.circle([p.lat, p.lng], {
          radius: 650,
          stroke: false,
          fillColor: affinityColor(p.affinity),
          fillOpacity: 0.6,
        })
          .bindTooltip(`Taste concentration ${Math.round(p.affinity * 100)}/100 (Qloo heatmap affinity)`)
          .addTo(map);
      }
      for (const pl of places) {
        if (pl.lat === undefined || pl.lng === undefined) continue;
        L.circleMarker([pl.lat, pl.lng], { radius: 6, color: "#ff5a36", weight: 3, fillColor: "#ffffff", fillOpacity: 1 })
          .bindTooltip(`${pl.name} (partner spot)`)
          .addTo(map);
      }
      if (located) {
        L.circleMarker([venue.lat, venue.lng], { radius: 9, color: "#ffffff", weight: 3, fillColor: "#22c55e", fillOpacity: 1 })
          .bindTooltip(venue.custom ? `${venue.city} city centre (venue address not given)` : `${venue.name} (venue)`, { permanent: false })
          .addTo(map);
      }
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
      aria-label={`Map of ${venue.city} showing ${points.length} areas shaded by how concentrated this taste is, the venue, and ${places.length} partner spots`}
    />
  );
}
