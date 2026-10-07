import type { Metadata, Viewport } from "next";
import "./globals.css";

// Absolute base for the share-image URLs: the production domain Vercel gives the build, else the public deployment.
const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://perpparrot.vercel.app";
const TITLE = "PerpParrot";
const DESCRIPTION = "Copy the best Hyperliquid traders, picked by quant screens and an AI agent, mirrored every ten minutes.";

// The icons, favicon, manifest and share images are the files next to this one (icon.svg, favicon.ico,
// apple-icon.png, manifest.ts, opengraph-image.png; X uses the Open Graph image); `bun scripts/make-meta-assets.ts` rebuilds them.
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: `%s · ${TITLE}` },
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: { type: "website", siteName: TITLE, title: TITLE, description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = { themeColor: "#efe3d0", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
