import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site from /<repo>/, not /. The workflow sets
// BASE_PATH; locally it stays "/" so `npm run dev` is unaffected.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  build: { target: "es2022" },
  worker: { format: "es" },
  server: { port: 5173 },
});
