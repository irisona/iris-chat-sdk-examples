import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // api.irisona.net's WebSocket upgrade only allows a fixed Origin allowlist (the main app's
  // :3000 dev port included) — any other localhost port gets a 403 at the CDN edge.
  server: { port: 3000 }
});
