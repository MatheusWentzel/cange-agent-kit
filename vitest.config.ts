import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    // Bloqueia rede real: teste que escapa do mock de fetch falha (nunca bate em produção).
    setupFiles: ["test/setup/no-real-network.ts"]
  }
});
