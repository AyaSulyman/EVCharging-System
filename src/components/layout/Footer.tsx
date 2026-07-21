import Link from "next/link";
import { MapPin, Phone, Mail } from "lucide-react";
import { Logo } from "@/components/ui/Primitives";

export function Footer() {
  return (
    <footer className="border-t border-line bg-ink text-white/70">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="[&_span]:text-white">
              <Logo />
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/60">
              Smart charging, simplified. Reserve a charger across any of our
              branches and drive on with confidence.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white">Explore</h4>
            <ul className="mt-4 space-y-2.5 text-sm">
              <FooterLink href="/stations" label="Stations" />
              <FooterLink href="/how-it-works" label="How it works" />
              <FooterLink href="/faq" label="FAQ" />
              <FooterLink href="/about" label="About us" />
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white">Account</h4>
            <ul className="mt-4 space-y-2.5 text-sm">
              <FooterLink href="/login" label="Log in" />
              <FooterLink href="/register" label="Create account" />
              <FooterLink href="/book" label="Book a charger" />
              <FooterLink href="/contact" label="Contact support" />
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white">Get in touch</h4>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                Zaitunay Bay, Beirut, Lebanon
              </li>
              <li className="flex items-center gap-2.5">
                <Phone className="h-4 w-4 shrink-0 text-primary" />
                +961 1 000 000
              </li>
              <li className="flex items-center gap-2.5">
                <Mail className="h-4 w-4 shrink-0 text-primary" />
                hello@chargehub.com
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs text-white/50 sm:flex-row">
          <p>© {new Date().getFullYear()} ChargeHub. All rights reserved.</p>
          <div className="flex gap-5">
            <Link href="/terms" className="hover:text-white">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-white">
              Privacy
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <Link href={href} className="text-white/60 transition-colors hover:text-white">
        {label}
      </Link>
    </li>
  );
}
