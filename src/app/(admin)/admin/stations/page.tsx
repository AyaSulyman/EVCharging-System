import { MapPin, Zap } from "lucide-react";
import { getStationsWithChargers } from "@/lib/data";
import { formatCurrency } from "@/lib/utils";
import { ConnectorBadge } from "@/components/ui/Primitives";
import { AdminChargerControls } from "@/components/admin/AdminChargerControls";

export const dynamic = "force-dynamic";

export default async function AdminStationsPage() {
  const stations = await getStationsWithChargers();

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Stations &amp; chargers</h1>
      <p className="mt-1 text-ink-soft">
        Manage charger availability across all branches.
      </p>

      <div className="mt-6 space-y-6">
        {stations.map((s) => (
          <div key={s._id} className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-ink">{s.name}</h2>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-soft">
                  <MapPin className="h-4 w-4" />
                  {s.address}
                </p>
              </div>
              <div className="flex gap-2">
                <span className="chip bg-emerald-50 text-emerald-700">
                  {s.availableCount} available
                </span>
                <span className="chip bg-canvas text-ink-soft">
                  {s.chargerCount} total
                </span>
              </div>
            </div>

            {/* Chargers table */}
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th className="pb-2 pr-4 font-medium">Charger</th>
                    <th className="pb-2 pr-4 font-medium">Connector</th>
                    <th className="pb-2 pr-4 font-medium">Power</th>
                    <th className="pb-2 pr-4 font-medium">Price</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.chargers.map((c) => (
                    <tr key={c._id} className="text-ink">
                      <td className="py-3 pr-4 font-semibold">{c.label}</td>
                      <td className="py-3 pr-4">
                        <ConnectorBadge type={c.connectorType} />
                      </td>
                      <td className="py-3 pr-4">
                        <span className="flex items-center gap-1">
                          <Zap className="h-3.5 w-3.5 text-volt" />
                          {c.powerKW} kW
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-ink-soft">
                        {formatCurrency(c.pricePerKWh)}/kWh
                      </td>
                      <td className="py-3">
                        <AdminChargerControls
                          chargerId={c._id}
                          status={c.status}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
