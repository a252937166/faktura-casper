import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served under https://axiqo.xyz/faktura/ on the public showcase; overridable for local dev.
  base: process.env.VITE_BASE ?? "/faktura/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4020", changeOrigin: true },
    },
  },
});
