import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PerpParrot",
  description: "Copy the best Hyperliquid traders, picked by quant screens and an AI agent, mirrored every ten minutes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
