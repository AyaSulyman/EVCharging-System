"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import {
  Menu,
  X,
  Bell,
  LayoutDashboard,
  Car,
  CalendarCheck,
  Sparkles,
  User as UserIcon,
  LogOut,
  Shield,
} from "lucide-react";
import { Logo } from "@/components/ui/Primitives";
import { cn } from "@/lib/utils";

const PUBLIC_LINKS = [
  { href: "/", label: "Home" },
  { href: "/stations", label: "Stations" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export function Navbar() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const isAuthed = status === "authenticated";
  const isAdmin = session?.user?.role === "admin";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isAuthed) return;
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : { notifications: [] }))
      .then((d) => setUnread((d.notifications ?? []).filter((n: { isRead: boolean }) => !n.isRead).length))
      .catch(() => {});
  }, [isAuthed, pathname]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b bg-canvas/85 backdrop-blur-md transition-shadow",
        scrolled ? "border-line shadow-sm" : "border-transparent"
      )}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Logo />

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 lg:flex">
          {PUBLIC_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                pathname === l.href
                  ? "bg-primary-light text-primary"
                  : "text-ink-soft hover:bg-line/60 hover:text-ink"
              )}
            >
              {l.label}
            </Link>
          ))}
        </div>

        {/* Right side */}
        <div className="hidden items-center gap-2 lg:flex">
          {isAuthed ? (
            <>
              <Link
                href="/notifications"
                className="relative rounded-lg p-2 text-ink-soft transition-colors hover:bg-line/60 hover:text-ink"
                aria-label="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unread > 0 && (
                  <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-volt px-1 text-[10px] font-bold text-ink">
                    {unread}
                  </span>
                )}
              </Link>
              <Link href="/book" className="btn-primary">
                Book now
              </Link>

              {/* Avatar dropdown */}
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white"
                  aria-label="Account menu"
                >
                  {session.user?.name?.charAt(0).toUpperCase() ?? "U"}
                </button>
                {menuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-white py-1.5 shadow-lift">
                      <div className="border-b border-line px-4 py-2.5">
                        <p className="truncate text-sm font-semibold text-ink">
                          {session.user?.name}
                        </p>
                        <p className="truncate text-xs text-ink-soft">
                          {session.user?.email}
                        </p>
                      </div>
                      <MenuLink href="/dashboard" icon={LayoutDashboard} label="Dashboard" />
                      <MenuLink href="/bookings" icon={CalendarCheck} label="My bookings" />
                      <MenuLink href="/vehicles" icon={Car} label="My vehicles" />
                      <MenuLink href="/recommendations" icon={Sparkles} label="Recommendations" />
                      <MenuLink href="/profile" icon={UserIcon} label="Profile" />
                      {isAdmin && (
                        <MenuLink href="/admin" icon={Shield} label="Admin panel" />
                      )}
                      <button
                        onClick={() => signOut({ callbackUrl: "/" })}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
                      >
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <Link href="/login" className="btn-ghost">
                Log in
              </Link>
              <Link href="/register" className="btn-primary">
                Get started
              </Link>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg p-2 text-ink lg:hidden"
          aria-label="Toggle menu"
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-line bg-white lg:hidden">
          <div className="space-y-1 px-4 py-4">
            {PUBLIC_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "block rounded-lg px-3 py-2.5 text-sm font-medium",
                  pathname === l.href
                    ? "bg-primary-light text-primary"
                    : "text-ink-soft hover:bg-line/60"
                )}
              >
                {l.label}
              </Link>
            ))}
            <div className="my-2 h-px bg-line" />
            {isAuthed ? (
              <>
                <MobileLink href="/dashboard" label="Dashboard" />
                <MobileLink href="/book" label="Book now" />
                <MobileLink href="/bookings" label="My bookings" />
                <MobileLink href="/vehicles" label="My vehicles" />
                <MobileLink href="/recommendations" label="Recommendations" />
                <MobileLink href="/notifications" label={`Notifications${unread ? ` (${unread})` : ""}`} />
                <MobileLink href="/profile" label="Profile" />
                {isAdmin && <MobileLink href="/admin" label="Admin panel" />}
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="mt-1 block w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-red-600"
                >
                  Sign out
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-2 pt-1">
                <Link href="/login" className="btn-secondary w-full">
                  Log in
                </Link>
                <Link href="/register" className="btn-primary w-full">
                  Get started
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function MenuLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 px-4 py-2 text-sm text-ink transition-colors hover:bg-line/50"
    >
      <Icon className="h-4 w-4 text-ink-soft" />
      {label}
    </Link>
  );
}

function MobileLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg px-3 py-2.5 text-sm font-medium text-ink hover:bg-line/60"
    >
      {label}
    </Link>
  );
}
