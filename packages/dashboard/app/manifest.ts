import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PerpParrot",
    short_name: "PerpParrot",
    description: "Copy the best Hyperliquid traders, picked by quant screens and an AI agent, mirrored every ten minutes.",
    start_url: "/",
    display: "standalone",
    background_color: "#efe3d0",
    theme_color: "#efe3d0",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
