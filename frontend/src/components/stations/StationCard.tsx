import Link from "next/link";
import Image from "next/image";
import { MapPin, Zap, ArrowRight } from "lucide-react";
import type { StationWithChargers } from "@/types";
import { amenityInfo } from "@/lib/amenities";

export function StationCard({ station }: { station: StationWithChargers }) {
  const photo = station.images?.[0];

  return (
    <Link
      href={`/stations/${station._id}`}
      className="group flex flex-col overflow-hidden rounded-xl2 border border-line bg-surface shadow-card transition-shadow hover:shadow-lift"
    >
      {/* Visual header — real photo when the station has one, CSS pattern otherwise */}
      <div className="relative h-44 overflow-hidden bg-gradient-to-br from-primary via-primary-dark to-ink">
        {photo ? (
          <>
            <Image
              src={photo}
              alt={station.name}
              fill
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/10 to-transparent" />
          </>
        ) : (
          <>
            <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:16px_16px]" />
            <Zap className="absolute -right-3 -top-3 h-28 w-28 text-white/10" />
          </>
        )}
        <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between">
          <span className="chip bg-white/15 text-white ring-1 ring-white/20 backdrop-blur-sm">
            {station.availableCount} of {station.chargerCount} free
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-base font-bold text-ink">{station.name}</h3>
        <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-soft">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
          {station.address}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {station.amenities.slice(0, 4).map((a) => {
            const { icon: Icon, label } = amenityInfo(a);
            return (
              <span
                key={a}
                title={label}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-canvas text-ink-soft"
              >
                <Icon className="h-4 w-4" />
              </span>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Zap className="h-4 w-4 text-volt" />
            {station.chargerCount} chargers
          </span>
          <span className="flex items-center gap-1 text-sm font-semibold text-primary transition-transform group-hover:translate-x-0.5">
            View station
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}
