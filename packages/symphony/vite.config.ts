import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/zod/")) return "validation";
          if (id.includes("/@tanstack/")) return "query";
          if (/\/(framer-motion|motion-dom|motion-utils|motion)\//.test(id))
            return "motion";
          if (id.includes("/@radix-ui/")) return "dialog";
          return "core";
        },
      },
    },
  },
});
