import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.restoreAllMocks();
});

describe("cli parsing", () => {
  it("registers required top-level commands", () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain("my-flows");
    expect(commandNames).toContain("my-registers");
    expect(commandNames).toContain("card");
    expect(commandNames).toContain("register");
  });

  it("runs card create in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-card-create-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          idForm: 662,
          flowId: 192,
          origin: "/cange-agent-kit",
          values: {
            customer_name: "ACME LTDA"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "cange",
        "--output",
        "json",
        "card",
        "create",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\": true");
    expect(output).toContain("\"executed\": false");
  });
});
