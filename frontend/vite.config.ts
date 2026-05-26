import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // Ports moved to 5174 (frontend) + 8001 (backend) because 5173/8000
    // are taken by something else on this dev box. Update the Azure app
    // registration's SPA redirect URI list to match if you change these.
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8001",
      "/assets/logo": "http://127.0.0.1:8001",
    },
  },
});
