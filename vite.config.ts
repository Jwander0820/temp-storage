import { defineConfig } from "vite";

export default defineConfig({
  root: "public",
  publicDir: false,
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
});
