import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:3456",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3456",
      },
    },
  },
});
