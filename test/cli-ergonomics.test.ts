import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  CangeApiError,
  CangeAuthError,
  CangeCliUsageError,
  CangeValidationError
} from "../src/client/errors.js";
import { annotateCommand, buildManifest } from "../src/cli/command-metadata.js";
import { EXIT_CODES, exitCodeForError } from "../src/cli/exit-codes.js";
import { resolveOutputMode } from "../src/cli/output-mode.js";

describe("exitCodeForError", () => {
  it("mapeia cada categoria para um code estável e distinto", () => {
    expect(exitCodeForError(new CangeAuthError("x"))).toBe(EXIT_CODES.AUTH);
    expect(exitCodeForError(new CangeApiError("x"))).toBe(EXIT_CODES.API);
    expect(exitCodeForError(new CangeCliUsageError("x"))).toBe(EXIT_CODES.USAGE);
    expect(exitCodeForError(new CangeValidationError("x"))).toBe(EXIT_CODES.USAGE);
    expect(exitCodeForError(new Error("x"))).toBe(EXIT_CODES.UNEXPECTED);
    // auth é subclasse distinta de api — não pode colidir
    expect(EXIT_CODES.AUTH).not.toBe(EXIT_CODES.API);
  });
});

describe("resolveOutputMode (caminho feliz por default)", () => {
  const originalEnv = process.env.CANGE_OUTPUT;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANGE_OUTPUT;
    } else {
      process.env.CANGE_OUTPUT = originalEnv;
    }
  });

  it("--output explícito vence", () => {
    expect(resolveOutputMode("json", { isTTY: true })).toBe("json");
    expect(resolveOutputMode("pretty", { isTTY: false })).toBe("pretty");
  });

  it("sem flag: json em pipe (não-TTY) e pretty em TTY", () => {
    delete process.env.CANGE_OUTPUT;
    expect(resolveOutputMode(undefined, { isTTY: false })).toBe("json");
    expect(resolveOutputMode(undefined, { isTTY: true })).toBe("pretty");
  });

  it("CANGE_OUTPUT é respeitado quando não há flag", () => {
    process.env.CANGE_OUTPUT = "json";
    expect(resolveOutputMode(undefined, { isTTY: true })).toBe("json");
  });

  it("flag inválida é erro de uso", () => {
    expect(() => resolveOutputMode("xml", { isTTY: false })).toThrow(CangeCliUsageError);
  });
});

describe("buildManifest (gerado do registry)", () => {
  function makeProgram(): Command {
    const program = new Command();
    program.name("cange").version("9.9.9").option("--output <mode>", "saída");
    const group = program.command("card").description("Operações de card");
    const list = group
      .command("list")
      .description("Lista cartões")
      .requiredOption("--flow-id <id>", "ID do flow")
      .option("--limit <n>", "limite");
    annotateCommand(list, {
      envelope: "{ summaries[], total }",
      example: "card list --flow-id 1"
    });
    const legacy = group.command("move-step").description("dep");
    annotateCommand(legacy, { mutates: true, deprecatedInFavorOf: "card move-step-with-values" });
    return program;
  }

  it("percorre a árvore inteira e injeta os metadados anexados", () => {
    const manifest = buildManifest(makeProgram());
    expect(manifest.cli).toBe("cange");
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.globalOptions.map((o) => o.flags)).toContain("--output <mode>");

    const card = manifest.commands.find((c) => c.name === "card");
    expect(card).toBeDefined();
    const list = card!.subcommands.find((c) => c.name === "list");
    expect(list!.path).toBe("card list");
    expect(list!.envelope).toBe("{ summaries[], total }");
    expect(list!.example).toBe("card list --flow-id 1");

    const flowIdOpt = list!.options.find((o) => o.flags.startsWith("--flow-id"));
    expect(flowIdOpt!.mandatory).toBe(true);
    expect(flowIdOpt!.takesValue).toBe(true);

    const legacy = card!.subcommands.find((c) => c.name === "move-step");
    expect(legacy!.deprecatedInFavorOf).toBe("card move-step-with-values");
    expect(legacy!.mutates).toBe(true);
  });

  it("expõe a convenção de envelope e a rota de discovery", () => {
    const manifest = buildManifest(makeProgram());
    expect(manifest.envelopeConvention).toMatch(/raw/i);
    expect(manifest.discovery).toMatch(/manifest/);
  });
});
