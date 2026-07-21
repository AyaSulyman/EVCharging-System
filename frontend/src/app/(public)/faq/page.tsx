"use client";

import { useState } from "react";
import { Search, ChevronDown } from "lucide-react";

const FAQS: { category: string; q: string; a: string }[] = [
  { category: "Booking", q: "How do I reserve a charging slot?", a: "Browse to a station, pick an available charger, choose a date and 30-minute time slot, select your vehicle, and confirm. Your slot is locked in immediately." },
  { category: "Booking", q: "Can I cancel or reschedule my booking?", a: "Yes. Go to My Bookings, open the reservation, and cancel it. The slot is released back for others. To reschedule, cancel and book a new slot." },
  { category: "Booking", q: "What happens if I don't show up?", a: "No-shows are marked automatically after your slot window passes. Repeated no-shows may affect your ability to reserve peak slots." },
  { category: "Booking", q: "How far in advance can I book?", a: "You can reserve any available slot up to 14 days ahead." },
  { category: "Charging", q: "What connector types do you support?", a: "Our chargers support CCS, CHAdeMO, and Type 2. Each charger's connector is shown on its card." },
  { category: "Charging", q: "How long does a charging session take?", a: "It depends on your battery size and the charger's power. A 150 kW charger can add significant range in 20–30 minutes for most EVs." },
  { category: "Charging", q: "Can I extend my session?", a: "If the next slot on that charger is free, you can book it back-to-back. Otherwise the charger becomes available for the next reservation." },
  { category: "Charging", q: "What power levels are available?", a: "We offer 22 kW (Type 2), 50 kW (CHAdeMO), and 150–350 kW (CCS) chargers across our branches." },
  { category: "Account", q: "How do I add my vehicle?", a: "Go to My Vehicles and add your make, model, connector type, and battery capacity. This unlocks personalized recommendations." },
  { category: "Account", q: "Can I connect my Tesla account?", a: "Yes — we support a provider connection flow. Tesla integration is built on our provider architecture; connect it from the vehicle card." },
  { category: "Account", q: "How do recommendations work?", a: "When your vehicle is connected, we combine your battery level, estimated range, and your location with live charger availability to suggest the best option." },
  { category: "Payment", q: "How much does charging cost?", a: "Pricing is per kWh and varies by charger, shown on each charger's card (typically $0.25–$0.45/kWh)." },
  { category: "Payment", q: "What payment methods are accepted?", a: "Payment is handled at checkout when you confirm a booking. In this version, confirmation completes the reservation." },
  { category: "Payment", q: "How do refunds work?", a: "Cancelled bookings that were paid are refunded to the original method. You'll see the status update in My Bookings." },
];

const CATEGORIES = ["All", "Booking", "Charging", "Account", "Payment"];

export default function FaqPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [open, setOpen] = useState<number | null>(0);

  const filtered = FAQS.filter((f) => {
    const matchCat = category === "All" || f.category === category;
    const matchQuery =
      !query ||
      f.q.toLowerCase().includes(query.toLowerCase()) ||
      f.a.toLowerCase().includes(query.toLowerCase());
    return matchCat && matchQuery;
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Help center
        </p>
        <h1 className="mt-1 text-3xl font-bold text-ink sm:text-4xl">
          Frequently asked questions
        </h1>
      </div>

      {/* Search */}
      <div className="relative mt-8">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
        <input
          className="field pl-10"
          placeholder="Search questions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Categories */}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`chip transition-colors ${
              category === c
                ? "bg-primary text-white"
                : "bg-white text-ink-soft hover:bg-line"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-8 space-y-3">
        {filtered.length === 0 && (
          <p className="py-10 text-center text-ink-soft">
            No questions match your search.
          </p>
        )}
        {filtered.map((f, i) => (
          <div key={f.q} className="overflow-hidden rounded-xl2 border border-line bg-surface">
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
            >
              <span className="font-semibold text-ink">{f.q}</span>
              <ChevronDown
                className={`h-5 w-5 shrink-0 text-ink-soft transition-transform ${
                  open === i ? "rotate-180" : ""
                }`}
              />
            </button>
            {open === i && (
              <div className="border-t border-line px-5 py-4 text-sm leading-relaxed text-ink-soft">
                {f.a}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
