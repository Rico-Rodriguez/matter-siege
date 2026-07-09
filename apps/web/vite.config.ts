import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/matter-siege/" : "/",
  server: { port: 5173 },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2200,
  },
});
