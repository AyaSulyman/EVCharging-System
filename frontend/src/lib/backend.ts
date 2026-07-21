const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export interface Banner {
  _id: string;
  title: string;
  subtitle: string;
  tag: string;
  imageUrl: string;
  ctaLabel: string;
  ctaHref: string;
  order: number;
  isActive: boolean;
}

/**
 * Fetches the active homepage banners/slides from the real backend.
 * Returns [] on any failure so the UI can fall back gracefully instead of crashing.
 */
export async function getBanners(): Promise<Banner[]> {
  try {
    const res = await fetch(`${API_URL}/api/banners`, {
      next: { revalidate: 60 }, // refresh at most once a minute
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.banners ?? [];
  } catch {
    return [];
  }
}
