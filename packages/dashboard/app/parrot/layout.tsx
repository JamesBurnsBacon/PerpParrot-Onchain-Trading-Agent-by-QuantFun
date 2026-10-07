import type { Metadata } from "next";

// The page itself is a client component, so its title and share text live here.
const TITLE = "Talk to the Parrot";
const SHARE_ALT = "PerpParrot: a clay parrot mascot in a rainbow propeller cap, with the line \"Copy the best Hyperliquid traders\"";
const DESCRIPTION = "Tell the parrot what kind of wallets you want to copy; it checks its facts and sketches a plan. Nothing is traded.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "PerpParrot", title: `${TITLE} · PerpParrot`, description: DESCRIPTION, url: "/parrot", images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: SHARE_ALT }] },
  twitter: { card: "summary_large_image", title: `${TITLE} · PerpParrot`, description: DESCRIPTION, images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: SHARE_ALT }] },
};

export default function ParrotLayout({ children }: { children: React.ReactNode }) {
  return children;
}
