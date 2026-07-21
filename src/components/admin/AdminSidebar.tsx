"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import {
  LayoutDashboard,
  Zap,
  CalendarCheck,
  Clock,
  Users,
  BarChart3,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { Logo } from "@/components/ui/Primitives";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/stations", label: "Stations", icon: Zap },
  { href: "/admin/bookings", label: "Bookings", icon: CalendarCheck },
  { href: "/admin/slots", label: "Slots", icon: Clock },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/reports", label: "Reports", icon: BarChart3 },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="px-5 py-5 [&_span]:text-white">
        <Logo />
        <p className="mt-1 pl-11 text-xs font-medium text-white/40">Admin</p>
      </div>
      <div className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const active =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-white"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
      <div className="border-t border-white/10 p-3">
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
        <Link
          href="/dashboard"
          className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/40 hover:text-white"
        >
          ← Back to app
        </Link>
      </div>
    </nav>
  );

  return (
    <>
      {/* Desktop */}
      <aside className="hidden w-64 shrink-0 bg-ink lg:block">{nav}</aside>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between bg-ink px-4 py-3 lg:hidden">
        <div className="[&_span]:text-white">
          <Logo />
        </div>
        <button onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu className="h-6 w-6 text-white" />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 bg-ink">
            <button
              onClick={() => setOpen(false)}
              className="absolute right-3 top-4 text-white/60"
              aria-label="Close"
            >
              <X className="h-6 w-6" />
            </button>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}
