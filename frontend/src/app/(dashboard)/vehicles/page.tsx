"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Plus,
  Car,
  Trash2,
  RefreshCw,
  Link2,
  X,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { ConnectorBadge, BatteryGauge } from "@/components/ui/Primitives";
import { useToast } from "@/components/Toast";
import { vehicleSchema } from "@/lib/validations";
import type { ConnectorType, ProviderKey } from "@/types";
import { useApi } from "@/lib/useApi";

interface VehicleRow {
  _id: string;
  make: string;
  model: string;
  year: number;
  licensePlate: string;
  connectorType: ConnectorType;
  batteryCapacity: number;
  currentBatteryLevel?: number;
  estimatedRange?: number;
  connection?: { provider: string; isConnected: boolean } | null;
}

const MAKES = ["Tesla", "Hyundai", "Kia", "BMW", "Mercedes", "Nissan", "BYD", "Volkswagen", "Other"];
const PROVIDERS: { key: ProviderKey; label: string; note: string }[] = [
  { key: "tesla", label: "Tesla", note: "Connect via Tesla Fleet API" },
  { key: "hyundai", label: "Hyundai", note: "Connect via Hyundai Bluelink" },
  { key: "bmw", label: "BMW", note: "Connect via BMW ConnectedDrive" },
  { key: "mock", label: "Demo mode", note: "Instant demo connection" },
];

export default function VehiclesPage() {
  const { toast } = useToast();
  const { call } = useApi();
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [connectFor, setConnectFor] = useState<VehicleRow | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  async function load() {
    const res = await call("/api/vehicles");
    const data = await res.json();
    setVehicles(data.vehicles ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function sync(id: string) {
    setSyncing(id);
    const res = await call("/api/vehicles/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicleId: id }),
    });
    setSyncing(null);
    if (res.ok) {
      toast("Battery data synced", "success");
      load();
    } else {
      toast("Sync failed — is the vehicle connected?", "error");
    }
  }

  async function remove() {
    if (!deleteId) return;
    const res = await call("/api/vehicles", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteId }),
    });
    setDeleteId(null);
    if (res.ok) {
      toast("Vehicle removed", "success");
      load();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">My vehicles</h1>
          <p className="mt-1 text-ink-soft">
            Add your EVs and connect them for smart recommendations.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="h-4 w-4" />
          Add vehicle
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : vehicles.length === 0 ? (
        <div className="card mt-6 flex flex-col items-center py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Car className="h-6 w-6" />
          </span>
          <p className="mt-3 font-semibold text-ink">No vehicles yet</p>
          <p className="mt-1 text-sm text-ink-soft">
            Add your first EV to unlock recommendations.
          </p>
          <button onClick={() => setShowAdd(true)} className="btn-primary mt-4">
            <Plus className="h-4 w-4" />
            Add vehicle
          </button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {vehicles.map((v) => {
            const connected = v.connection?.isConnected;
            return (
              <div key={v._id} className="card">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-ink">
                      {v.make} {v.model}
                    </h3>
                    <p className="text-sm text-ink-soft">
                      {v.year} · {v.licensePlate || "No plate"}
                    </p>
                  </div>
                  <ConnectorBadge type={v.connectorType} />
                </div>

                {/* Battery */}
                <div className="mt-4">
                  {v.currentBatteryLevel != null ? (
                    <>
                      <div className="mb-1 flex items-center justify-between text-xs text-ink-soft">
                        <span>Battery</span>
                        <span>{v.estimatedRange} km range</span>
                      </div>
                      <BatteryGauge level={v.currentBatteryLevel} />
                    </>
                  ) : (
                    <p className="text-sm text-ink-soft">
                      Connect to see live battery level.
                    </p>
                  )}
                </div>

                {/* Connection status */}
                <div className="mt-4 flex items-center gap-2">
                  {connected ? (
                    <span className="chip bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" />
                      Connected · {v.connection?.provider}
                    </span>
                  ) : (
                    <span className="chip bg-gray-100 text-gray-500">Not connected</span>
                  )}
                </div>

                {/* Actions */}
                <div className="mt-4 flex gap-2 border-t border-line pt-4">
                  {connected ? (
                    <button
                      onClick={() => sync(v._id)}
                      disabled={syncing === v._id}
                      className="btn-ghost text-primary hover:bg-primary-light"
                    >
                      {syncing === v._id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Sync
                    </button>
                  ) : (
                    <button
                      onClick={() => setConnectFor(v)}
                      className="btn-ghost text-primary hover:bg-primary-light"
                    >
                      <Link2 className="h-4 w-4" />
                      Connect
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteId(v._id)}
                    className="btn-ghost text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && <AddVehicleModal onClose={() => setShowAdd(false)} onDone={load} />}
      {connectFor && (
        <ConnectModal
          vehicle={connectFor}
          onClose={() => setConnectFor(null)}
          onDone={load}
        />
      )}
      {deleteId && (
        <ConfirmModal
          title="Remove vehicle?"
          text="This deletes the vehicle and its provider connection."
          confirmLabel="Remove"
          onCancel={() => setDeleteId(null)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}

function AddVehicleModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { call } = useApi();
  const [form, setForm] = useState({
    make: "Tesla",
    model: "",
    year: new Date().getFullYear(),
    licensePlate: "",
    connectorType: "CCS" as ConnectorType,
    batteryCapacity: 60,
  });
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = vehicleSchema.safeParse(form);
    if (!parsed.success) {
      toast(parsed.error.errors[0]?.message ?? "Check the form", "error");
      return;
    }
    setSaving(true);
    const res = await call("/api/vehicles", {
      method: "POST",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) {
      toast("Vehicle added", "success");
      onDone();
      onClose();
    } else {
      const d = await res.json();
      toast(d.error ?? "Could not add vehicle", "error");
    }
  }

  return (
    <ModalShell title="Add vehicle" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Make</label>
          <select
            className="field"
            value={form.make}
            onChange={(e) => setForm({ ...form, make: e.target.value })}
          >
            {MAKES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Model</label>
          <input
            className="field"
            placeholder="Model 3"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Year</label>
            <input
              type="number"
              className="field"
              value={form.year}
              onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="label">License plate</label>
            <input
              className="field"
              placeholder="B 123456"
              value={form.licensePlate}
              onChange={(e) => setForm({ ...form, licensePlate: e.target.value })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Connector</label>
            <select
              className="field"
              value={form.connectorType}
              onChange={(e) =>
                setForm({ ...form, connectorType: e.target.value as ConnectorType })
              }
            >
              <option>CCS</option>
              <option>CHAdeMO</option>
              <option>Type2</option>
            </select>
          </div>
          <div>
            <label className="label">Battery (kWh)</label>
            <input
              type="number"
              className="field"
              value={form.batteryCapacity}
              onChange={(e) =>
                setForm({ ...form, batteryCapacity: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <button type="submit" disabled={saving} className="btn-primary w-full">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Add vehicle
        </button>
      </form>
    </ModalShell>
  );
}

function ConnectModal({
  vehicle,
  onClose,
  onDone,
}: {
  vehicle: VehicleRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { call } = useApi();
  const [provider, setProvider] = useState<ProviderKey>("mock");
  const [connecting, setConnecting] = useState(false);

  async function connect() {
    setConnecting(true);
    const res = await call("/api/vehicles/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicleId: vehicle._id, provider }),
    });
    setConnecting(false);
    if (res.ok) {
      toast(`${vehicle.make} connected!`, "success");
      onDone();
      onClose();
    } else {
      toast("Connection failed", "error");
    }
  }

  return (
    <ModalShell title={`Connect ${vehicle.make} ${vehicle.model}`} onClose={onClose}>
      <p className="text-sm text-ink-soft">
        Choose a provider. Real manufacturer integrations use each brand&apos;s own
        secure OAuth; demo mode connects instantly with sample data.
      </p>
      <div className="mt-4 space-y-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => setProvider(p.key)}
            className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
              provider === p.key
                ? "border-primary bg-primary-light"
                : "border-line hover:border-primary/50"
            }`}
          >
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                provider === p.key ? "bg-primary text-white" : "bg-canvas text-primary"
              }`}
            >
              <Zap className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">{p.label}</p>
              <p className="text-xs text-ink-soft">{p.note}</p>
            </div>
          </button>
        ))}
      </div>

      {provider === "tesla" && (
        <p className="mt-3 rounded-lg bg-canvas p-3 text-xs text-ink-soft">
          You&apos;ll be redirected to Tesla to authorize access. Architecture is
          production-ready; final validation requires a real Tesla account.
        </p>
      )}

      <button
        onClick={connect}
        disabled={connecting}
        className="btn-primary mt-5 w-full"
      >
        {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
        {connecting ? "Connecting…" : "Connect"}
      </button>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl2 bg-white p-6 shadow-lift">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="h-5 w-5 text-ink-soft hover:text-ink" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  text,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl2 bg-white p-6 shadow-lift">
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        <p className="mt-2 text-sm text-ink-soft">{text}</p>
        <div className="mt-6 flex gap-2">
          <button onClick={onCancel} className="btn-secondary flex-1">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
