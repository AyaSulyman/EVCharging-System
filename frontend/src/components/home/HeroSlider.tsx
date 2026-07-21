"use client";

import { useEffect, useCallback, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft, ChevronRight, BatteryCharging } from "lucide-react";
import type { Banner } from "@/lib/backend";

const AUTOPLAY_MS = 6000;

export function HeroSlider({ slides }: { slides: Banner[] }) {
  const [index, setIndex] = useState(0);
  const hasSlides = slides.length > 0;

  const next = useCallback(() => {
    if (!hasSlides) return;
    setIndex((i) => (i + 1) % slides.length);
  }, [hasSlides, slides.length]);

  const prev = () => {
    if (!hasSlides) return;
    setIndex((i) => (i - 1 + slides.length) % slides.length);
  };

  useEffect(() => {
    if (slides.length < 2) return;
    const id = setInterval(next, AUTOPLAY_MS);
    return () => clearInterval(id);
  }, [next, slides.length]);

  if (!hasSlides) {
    // Graceful fallback if the backend is unreachable or has no active banners yet.
    return (
      <div className="relative">
        <div className="max-w-2xl">
          <span className="chip bg-white/10 text-white ring-1 ring-white/20">
            <BatteryCharging className="h-3.5 w-3.5 text-volt" />
            Live availability across every branch
          </span>
          <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Smart charging,
            <br />
            <span className="text-volt">simplified.</span>
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/80">
            Find a station, check which chargers are free right now, and lock in
            your slot in seconds. No queues, no guesswork.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/stations" className="btn-primary bg-white text-primary hover:bg-white/90">
              Find a station
            </Link>
            <Link href="/register" className="btn-secondary border-white/40 text-white hover:bg-white/10">
              Get started
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Slides */}
      <div className="relative h-[440px] overflow-hidden rounded-2xl sm:h-[480px] lg:h-[520px]">
        {slides.map((slide, i) => (
          <div
            key={slide._id}
            aria-hidden={i !== index}
            className={`absolute inset-0 transition-opacity duration-1000 ease-in-out ${
              i === index ? "z-10 opacity-100" : "z-0 opacity-0"
            }`}
          >
            <Image
              src={slide.imageUrl}
              alt={slide.title}
              fill
              priority={i === 0}
              sizes="100vw"
              className={`object-cover ${i === index ? "scale-105" : "scale-100"} transition-transform duration-[6000ms] ease-out`}
            />
            {/* Readability gradient */}
            <div className="absolute inset-0 bg-gradient-to-t from-ink/90 via-ink/40 to-ink/10" />
            <div className="absolute inset-0 bg-gradient-to-r from-ink/70 via-ink/10 to-transparent" />

            <div className="relative z-10 flex h-full flex-col justify-end p-6 sm:p-10 lg:p-14">
              <div className="max-w-xl">
                {slide.tag && (
                  <span className="chip bg-white/10 text-white ring-1 ring-white/20">
                    <BatteryCharging className="h-3.5 w-3.5 text-volt" />
                    {slide.tag}
                  </span>
                )}
                <h1 className="mt-4 text-3xl font-bold leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-5xl">
                  {slide.title}
                </h1>
                {slide.subtitle && (
                  <p className="mt-4 max-w-lg text-base leading-relaxed text-white/85 sm:text-lg">
                    {slide.subtitle}
                  </p>
                )}
                {slide.ctaLabel && slide.ctaHref && (
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Link
                      href={slide.ctaHref}
                      className="btn-primary bg-white text-primary hover:bg-white/90"
                    >
                      {slide.ctaLabel}
                    </Link>
                    <Link
                      href="/register"
                      className="btn-secondary border-white/40 text-white hover:bg-white/10"
                    >
                      Get started
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Arrows */}
        {slides.length > 1 && (
          <>
            <button
              onClick={prev}
              aria-label="Previous slide"
              className="absolute left-3 top-1/2 z-20 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-white/20 sm:left-5"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={next}
              aria-label="Next slide"
              className="absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-white/20 sm:right-5"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}

        {/* Dots */}
        {slides.length > 1 && (
          <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 gap-2">
            {slides.map((s, i) => (
              <button
                key={s._id}
                onClick={() => setIndex(i)}
                aria-label={`Go to slide ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? "w-7 bg-volt" : "w-1.5 bg-white/50 hover:bg-white/70"
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
