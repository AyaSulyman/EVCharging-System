"use client";

import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";
import { BoltMark } from "@/components/ui/Primitives";
import { useApi } from "@/lib/useApi";

interface Msg {
  role: "user" | "bot";
  text: string;
}

const SUGGESTIONS = [
  "What are my bookings?",
  "Which is the nearest station?",
  "Should I charge?",
  "How many chargers are free?",
];

export function ChatWidget() {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "bot",
      text: "Hi! I'm your ChargeHub assistant. Ask me about stations, chargers, your bookings, or charging recommendations.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setLoading(true);
    try {
      const res = await call("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "bot", text: data.reply ?? "Sorry, I couldn't process that." }]);
    } catch {
      setMessages((m) => [...m, { role: "bot", text: "Something went wrong. Please try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Launcher */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lift transition-transform hover:scale-105"
        aria-label="Open assistant"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-40 flex h-[520px] w-[calc(100vw-3rem)] max-w-sm flex-col overflow-hidden rounded-xl2 border border-line bg-white shadow-lift">
          {/* Header */}
          <div className="flex items-center gap-3 bg-gradient-to-r from-primary to-primary-dark px-4 py-3.5 text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
              <BoltMark className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-bold">ChargeHub Assistant</p>
              <p className="text-xs text-white/70">Grounded in your data</p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 space-y-3 overflow-y-auto bg-canvas p-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-sm ${
                    m.role === "user"
                      ? "rounded-br-sm bg-primary text-white"
                      : "rounded-bl-sm bg-white text-ink shadow-card"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-white px-3.5 py-2.5 shadow-card">
                  <Loader2 className="h-4 w-4 animate-spin text-ink-soft" />
                </div>
              </div>
            )}
            {messages.length === 1 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="chip bg-white text-primary shadow-card hover:bg-primary-light"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-line bg-white p-3"
          >
            <input
              className="field"
              placeholder="Ask something…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
