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
    expect(commandNames).toContain("my-tasks");
    expect(commandNames).toContain("notifications");
    expect(commandNames).toContain("notification");
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

  it("runs card move-step-with-values in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-card-move-step-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          flowId: 192,
          cardId: 7,
          fromStepId: 11,
          toStepId: 12,
          idForm: 662,
          values: {
            customer_name: "ACME LTDA"
          },
          complete: "S",
          isFromCurrentStep: true,
          isTestMode: false
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
        "move-step-with-values",
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
    expect(output).toContain("\"flowId\": 192");
  });

  it("runs deprecated card move-step alias with idForm and values", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-card-move-step-alias-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          flowId: 192,
          cardId: 7,
          fromStepId: 11,
          toStepId: 12,
          idForm: 662,
          values: {},
          complete: "S",
          isFromCurrentStep: true,
          isTestMode: false
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
        "move-step",
        "--payload",
        payloadPath,
        "--dry-run"
      ]);
    } finally {
      await unlink(payloadPath);
    }

    const output = writes.join("");
    expect(output).toContain("\"dryRun\": true");
    expect(output).toContain("deprecated");
  });

  it("runs notification read in dry-run without mutating", async () => {
    process.env.CANGE_ACCESS_TOKEN = "token";

    const payloadPath = join(tmpdir(), `cange-notification-read-${Date.now()}.json`);
    await writeFile(
      payloadPath,
      JSON.stringify(
        {
          id_notification: 48107,
          archived: "S"
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
        "notification",
        "read",
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
    expect(output).toContain("\"notificationId\": 48107");
  });
});
