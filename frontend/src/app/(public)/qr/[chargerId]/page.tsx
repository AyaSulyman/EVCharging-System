import { notFound } from "next/navigation";
import Link from "next/link";
import { Zap, MapPin, ArrowRight, Ban } from "lucide-react";
import { getChargerWithStation } from "@/lib/data";
import { ConnectorBadge, StatusDot, Logo } from "@/components/ui/Primitives";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function QrPage({
  params,
}: {
  params: { chargerId: string };
}) {
  const data = await getChargerWithStation(params.chargerId);
  if (!data) notFound();
  const { charger, station } = data;
  const available = charger.status === "available";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="flex items-center justify-center border-b border-line bg-white py-4">
        <Logo />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-8">
        <div className="w-full max-w-sm">
          {/* Charger header */}
          <div className="relative overflow-hidden rounded-xl2 bg-gradient-to-br from-primary via-primary-dark to-ink p-6 text-center">
            <Zap className="absolute -right-4 -top-4 h-24 w-24 text-white/10" />
            <div className="relative">
              <p className="text-xs font-medium uppercase tracking-wider text-white/70">
                You scanned
              </p>
              <h1 className="mt-1 text-2xl font-bold text-white">{charger.label}</h1>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-white/80">
                <MapPin className="h-4 w-4" />
                {station.name}
              </p>
            </div>
          </div>

          {/* Details */}
          <div className="card mt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-soft">Status</span>
              <StatusDot status={charger.status} />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-ink-soft">Connector</span>
              <ConnectorBadge type={charger.connectorType} />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-ink-soft">Power</span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Zap className="h-4 w-4 text-volt" />
                {charger.powerKW} kW
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-ink-soft">Price</span>
              <span className="text-sm font-semibold text-ink">
                {formatCurrency(charger.pricePerKWh)}/kWh
              </span>
            </div>
          </div>

          {/* Action */}
          {available ? (
            <Link
              href={`/book?station=${station._id}&charger=${charger._id}`}
              className="btn-primary mt-4 w-full py-3 text-base"
            >
              Reserve this charger
              <ArrowRight className="h-5 w-5" />
            </Link>
          ) : (
            <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-line bg-white py-3 text-sm font-medium text-ink-soft">
              <Ban className="h-4 w-4" />
              This charger is currently unavailable
            </div>
          )}

          <p className="mt-3 text-center text-xs text-ink-soft">
            You&apos;ll need to sign in to complete a reservation.
          </p>

          <div className="mt-6 text-center">
            <Link
              href={`/stations/${station._id}`}
              className="text-sm font-medium text-primary hover:underline"
            >
              View full station →
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
