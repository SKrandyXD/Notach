import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolveLocalServices } from "@notach/shared";

const services = resolveLocalServices(process.env);

export default defineConfig({
  plugins: [react()],
  define: { __NOTACH_LOCAL_SERVICES__: JSON.stringify(services) },
  server: {
    host: services.browserHost,
    port: services.webPort,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    // Keep concurrent JSDOM processes within local development memory budgets.
    maxWorkers: 2,
  },
});
