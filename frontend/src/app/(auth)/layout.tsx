import Link from "next/link";
import { Logo } from "@/components/ui/Primitives";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-6 sm:px-6">
        <Logo />
        <Link href="/" className="text-sm font-medium text-ink-soft hover:text-ink">
          ← Back to home
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        {children}
      </main>
    </div>
  );
}
