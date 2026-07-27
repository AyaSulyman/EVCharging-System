import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { ToastProvider } from "@/components/Toast";
import { App as AntdApp } from "antd";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: "ChargeHub — Smart EV Charging Reservations",
    template: "%s · ChargeHub",
  },
  description:
    "Discover charging stations, check live availability, and reserve your slot. ChargeHub makes EV charging simple across all our branches.",
  keywords: [
    "EV charging",
    "charging station",
    "reserve charger",
    "electric vehicle",
    "ChargeHub",
  ],
  openGraph: {
    title: "ChargeHub — Smart EV Charging Reservations",
    description:
      "Reserve EV charging slots in seconds. Live availability across every branch.",
    type: "website",
    siteName: "ChargeHub",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AntdApp>
            <ToastProvider>{children}</ToastProvider>
          </AntdApp>
        </Providers>
      </body>
    </html>
  );
}