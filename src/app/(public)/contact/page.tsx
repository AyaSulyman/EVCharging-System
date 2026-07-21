"use client";

import { useState } from "react";
import { MapPin, Phone, Mail, Clock, Loader2, Send } from "lucide-react";
import { contactSchema } from "@/lib/validations";
import { useToast } from "@/components/Toast";

export default function ContactPage() {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = contactSchema.safeParse(form);
    if (!parsed.success) {
      toast(parsed.error.errors[0]?.message ?? "Please check the form", "error");
      return;
    }
    setLoading(true);
    // Simulated send (no backend email in this build)
    await new Promise((r) => setTimeout(r, 700));
    setLoading(false);
    toast("Thanks! We'll get back to you shortly.", "success");
    setForm({ name: "", email: "", subject: "", message: "" });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-10 text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Get in touch
        </p>
        <h1 className="mt-1 text-3xl font-bold text-ink sm:text-4xl">
          We&apos;d love to hear from you
        </h1>
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        {/* Form */}
        <div className="card lg:col-span-3">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="name" className="label">Name</label>
                <input
                  id="name"
                  className="field"
                  placeholder="Your name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="email" className="label">Email</label>
                <input
                  id="email"
                  type="email"
                  className="field"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label htmlFor="subject" className="label">Subject</label>
              <input
                id="subject"
                className="field"
                placeholder="How can we help?"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="message" className="label">Message</label>
              <textarea
                id="message"
                rows={5}
                className="field resize-none"
                placeholder="Tell us more…"
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {loading ? "Sending…" : "Send message"}
            </button>
          </form>
        </div>

        {/* Info */}
        <div className="space-y-4 lg:col-span-2">
          <div className="card space-y-4">
            <InfoRow icon={MapPin} title="Visit us" line="Zaitunay Bay, Beirut, Lebanon" />
            <InfoRow icon={Phone} title="Call us" line="+961 1 000 000" />
            <InfoRow icon={Mail} title="Email us" line="hello@chargehub.com" />
            <InfoRow icon={Clock} title="Hours" line="Mon–Sun, 8:00 AM – 10:00 PM" />
          </div>
          <div className="card">
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line bg-canvas text-center text-xs text-ink-soft">
              <div>
                <MapPin className="mx-auto mb-1 h-6 w-6 text-primary" />
                Map placeholder
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  title,
  line,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  line: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-sm text-ink-soft">{line}</p>
      </div>
    </div>
  );
}
