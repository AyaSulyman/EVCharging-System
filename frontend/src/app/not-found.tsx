import Link from "next/link";
import { BatteryWarning, Home, Search } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 text-center">
      <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-volt-light text-volt">
        <BatteryWarning className="h-10 w-10" />
      </span>
      <h1 className="mt-6 font-mono text-6xl font-bold text-ink">404</h1>
      <h2 className="mt-2 text-xl font-bold text-ink">Page not found</h2>
      <p className="mt-2 max-w-sm text-ink-soft">
        Looks like this charger is off the grid. The page you&apos;re looking for
        doesn&apos;t exist or has moved.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="btn-primary">
          <Home className="h-4 w-4" />
          Go home
        </Link>
        <Link href="/stations" className="btn-secondary">
          <Search className="h-4 w-4" />
          Browse stations
        </Link>
      </div>
    </div>
  );
}
