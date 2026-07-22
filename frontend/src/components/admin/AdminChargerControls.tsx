"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { ChargerStatus } from "@/types";
import { useApi } from "@/lib/useApi";

const STATUSES: { value: ChargerStatus; label: string }[] = [
  { value: "available", label: "Available" },
  { value: "in_use", label: "In use" },
  { value: "maintenance", label: "Maintenance" },
  { value: "offline", label: "Offline" },
];

const STYLES: Record<ChargerStatus, string> = {
  available: "text-emerald-700 bg-emerald-50 border-emerald-200",
  in_use: "text-amber-700 bg-amber-50 border-amber-200",
  maintenance: "text-red-700 bg-red-50 border-red-200",
  offline: "text-gray-600 bg-gray-100 border-gray-200",
};

export function AdminChargerControls({
  chargerId,
  status,
}: {
  chargerId: string;
  status: ChargerStatus;
}) {
  const router = useRouter();
  const { call } = useApi();
  const [current, setCurrent] = useState<ChargerStatus>(status);
  const [saving, setSaving] = useState(false);

  async function update(next: ChargerStatus) {
    setSaving(true);
    setCurrent(next);
    await call("/api/chargers", {
      method: "PATCH",
      body: JSON.stringify({ id: chargerId, status: next }),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={current}
        disabled={saving}
        onChange={(e) => update(e.target.value as ChargerStatus)}
        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold outline-none ${STYLES[current]}`}
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value} className="bg-white text-ink">
            {s.label}
          </option>
        ))}
      </select>
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" />}
    </div>
  );
}
