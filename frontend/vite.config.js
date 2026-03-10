import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8000,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        // target: "https://streamforge-api.altariahub.com",
        changeOrigin: true,
      },
    },
  },
});