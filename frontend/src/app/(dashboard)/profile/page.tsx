"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2, User as UserIcon, Lock } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function ProfilePage() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [profile, setProfile] = useState({
    name: session?.user?.name ?? "",
    phone: "",
  });
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    await new Promise((r) => setTimeout(r, 600));
    setSavingProfile(false);
    toast("Profile updated", "success");
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.next.length < 8) {
      toast("New password must be at least 8 characters", "error");
      return;
    }
    if (pwd.next !== pwd.confirm) {
      toast("Passwords do not match", "error");
      return;
    }
    setSavingPwd(true);
    await new Promise((r) => setTimeout(r, 600));
    setSavingPwd(false);
    setPwd({ current: "", next: "", confirm: "" });
    toast("Password changed", "success");
  }

  const initials = (session?.user?.name ?? "U")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Profile settings</h1>
      <p className="mt-1 text-ink-soft">Manage your account details.</p>

      {/* Avatar + profile */}
      <div className="card mt-6">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-xl font-bold text-white">
            {initials}
          </div>
          <div>
            <p className="font-bold text-ink">{session?.user?.name}</p>
            <p className="text-sm text-ink-soft">{session?.user?.email}</p>
          </div>
        </div>

        <form onSubmit={saveProfile} className="mt-6 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <UserIcon className="h-4 w-4 text-primary" />
            Personal information
          </div>
          <div>
            <label className="label">Full name</label>
            <input
              className="field"
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              className="field bg-canvas"
              value={session?.user?.email ?? ""}
              disabled
            />
          </div>
          <div>
            <label className="label">Phone</label>
            <input
              className="field"
              placeholder="+961 70 000 000"
              value={profile.phone}
              onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
            />
          </div>
          <button type="submit" disabled={savingProfile} className="btn-primary">
            {savingProfile && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </button>
        </form>
      </div>

      {/* Password */}
      <div className="card mt-6">
        <form onSubmit={savePassword} className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Lock className="h-4 w-4 text-primary" />
            Change password
          </div>
          <div>
            <label className="label">Current password</label>
            <input
              type="password"
              className="field"
              value={pwd.current}
              onChange={(e) => setPwd({ ...pwd, current: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">New password</label>
              <input
                type="password"
                className="field"
                value={pwd.next}
                onChange={(e) => setPwd({ ...pwd, next: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Confirm</label>
              <input
                type="password"
                className="field"
                value={pwd.confirm}
                onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
              />
            </div>
          </div>
          <button type="submit" disabled={savingPwd} className="btn-secondary">
            {savingPwd && <Loader2 className="h-4 w-4 animate-spin" />}
            Update password
          </button>
        </form>
      </div>
    </div>
  );
}
