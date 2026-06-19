import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
});
