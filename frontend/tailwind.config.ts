import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "#0E7A5F", dark: "#0A5C48", light: "#E7F3EF" },
        volt: { DEFAULT: "#F5A524", light: "#FEF3DE" },
        ink: { DEFAULT: "#101915", soft: "#5B6B64" },
        surface: "#FFFFFF",
        canvas: "#F5F8F6",
        line: "#E3EAE6",
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        body: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"Space Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,25,21,0.05), 0 4px 16px rgba(16,25,21,0.04)",
        lift: "0 4px 12px rgba(16,25,21,0.08), 0 12px 32px rgba(16,25,21,0.07)",
      },
      borderRadius: { xl2: "1rem" },
    },
  },
  plugins: [],
};
export default config;
