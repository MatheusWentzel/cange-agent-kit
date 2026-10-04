import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/index.js";

/**
 * R5-KR-09 (01/10): a promessa "`--full` ou CANGE_OUTPUT_PROFILE=full devolvem o
 * formato anterior byte a byte" era testada só comparando um caminho com o outro
 * (os dois podiam ter mudado juntos). Aqui a referência é FIXA: o `golden.json`
 * saiu do kit f3e4810 (o pin do runner, antes da saída enxuta), rodado com os
 * mesmos cenários e as mesmas respostas da API de `scenarios.json`. Cada variante
 * do formato completo (flag global, flag no subcomando, variável de ambiente)
 * tem de imprimir exatamente a mesma string.
 */

interface Variant {
  args: string[];
  env?: Record<string, string>;
}
interface Scenario {
  name: string;
  routes: Record<string, unknown>;
  oldArgs: string[];
  variants: Variant[];
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "full-format");
const { scenarios } = JSON.parse(readFileSync(join(FIXTURES, "scenarios.json"), "utf8")) as { scenarios: Scenario[] };
const golden = JSON.parse(readFileSync(join(FIXTURES, "golden.json"), "utf8")) as Record<string, string>;

const envBackup = { ...process.env };
const stdout: string[] = [];
let routes: Record<string, unknown> = {};

beforeEach(() => {
  process.env.CANGE_ACCESS_TOKEN = "token";
  delete process.env.CANGE_OUTPUT_PROFILE;
  delete process.env.CANGE_OUTPUT;
  stdout.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const known = key in routes;
    return new Response(JSON.stringify(known ? routes[key] : { message: `rota não mockada: ${key}` }), {
      status: known ? 200 : 404,
      headers: { "content-type": "application/json" }
    });
  });
});

afterEach(() => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("formato completo = formato de antes da rodada 5, byte a byte (golden do kit f3e4810)", () => {
  it("todo cenário tem referência gravada", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(9);
    for (const scenario of scenarios) {
      expect(golden[scenario.name], scenario.name).toEqual(expect.any(String));
      expect(golden[scenario.name]!.length, scenario.name).toBeGreaterThan(0);
    }
  });

  for (const scenario of scenarios) {
    for (const variant of scenario.variants) {
      const label = `${scenario.name}: ${variant.env ? "CANGE_OUTPUT_PROFILE=full " : ""}${variant.args.join(" ")}`;
      it(label, async () => {
        routes = scenario.routes;
        for (const [key, value] of Object.entries(variant.env ?? {})) process.env[key] = value;
        await createProgram().parseAsync(["node", "cange", "--output", "json", ...variant.args]);
        expect(process.exitCode ?? 0).toBe(0);
        expect(stdout.join("")).toBe(golden[scenario.name]);
      });
    }
  }

  it("o padrão (enxuto) NÃO é o formato de antes nos comandos que mudaram", async () => {
    for (const name of ["my-flows", "card-read", "map", "card-list-v2", "comment-list-digest"]) {
      const scenario = scenarios.find((s) => s.name === name)!;
      routes = scenario.routes;
      stdout.length = 0;
      await createProgram().parseAsync(["node", "cange", "--output", "json", ...scenario.oldArgs]);
      expect(stdout.join(""), name).not.toBe(golden[name]);
    }
  });
});
