import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R5-KR-01 (01/10): o createContext resolvia o perfil de saída (e o CANGE_OUTPUT)
// ANTES de carregar o `.env` do diretório. Os agentes locais configuram o kit
// por esse `.env`; com CANGE_OUTPUT_PROFILE=full nele, o my-flows saía enxuto e
// os scripts que leem `raw` (build-casca, verify-casca, preflight-tenant) viam
// uma lista vazia. Aqui o `.env` é REAL, num diretório temporário: o dotenv o lê
// de process.cwd(), que aponta para lá.
//
// `loadEnv` carrega uma vez por processo: cada teste reimporta os módulos
// (`vi.resetModules`) para começar com o carregamento zerado.

const KEYS = ["CANGE_OUTPUT_PROFILE", "CANGE_OUTPUT", "CANGE_ACCESS_TOKEN"] as const;
const envBackup = { ...process.env };
let dir = "";
const stdout: string[] = [];
const requests: Array<{ path: string; auth: string | null }> = [];

const MY_FLOWS = [
  { id_flow: 316, name: "CNG CRM", form_init_id: 900, company_id: 6728, total_cards: 42, typeUserAccess: "A" }
];

beforeEach(async () => {
  vi.resetModules();
  for (const key of KEYS) delete process.env[key];
  dir = await mkdtemp(join(tmpdir(), "kit-dotenv-profile-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  stdout.length = 0;
  requests.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, auth: headers.get("authorization") });
    if (url.pathname === "/flow/my-flows") {
      return new Response(JSON.stringify(MY_FLOWS), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "rota não mockada" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  });
});

afterEach(async () => {
  process.env = { ...envBackup };
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function writeDotenv(content: string): Promise<void> {
  await writeFile(join(dir, ".env"), content, "utf8");
}

async function run(args: string[]): Promise<string> {
  const { createProgram } = await import("../src/cli/index.js");
  await createProgram().parseAsync(["node", "cange", ...args]);
  return stdout.join("");
}

describe("CANGE_OUTPUT_PROFILE e CANGE_OUTPUT vindos do .env do diretório", () => {
  it("CANGE_OUTPUT_PROFILE=full no .env devolve o formato completo (raw + summaries, indentado)", async () => {
    await writeDotenv("CANGE_ACCESS_TOKEN=token-do-dotenv\nCANGE_OUTPUT_PROFILE=full\n");
    const out = await run(["--output", "json", "my-flows"]);

    // o .env foi mesmo lido (o token dele chegou na chamada)
    expect(requests[0]?.auth).toContain("token-do-dotenv");
    const parsed = JSON.parse(out);
    expect(parsed.raw).toEqual(MY_FLOWS);
    expect(parsed.summaries[0]).toMatchObject({ id: 316, title: "CNG CRM" });
    expect(out).toContain('\n  "raw": [');
  });

  it("sem a variável no .env, o padrão continua enxuto", async () => {
    await writeDotenv("CANGE_ACCESS_TOKEN=token-do-dotenv\n");
    const parsed = JSON.parse(await run(["--output", "json", "my-flows"]));
    expect(parsed).not.toHaveProperty("raw");
    expect(parsed.summaries).toEqual([{ id: 316, title: "CNG CRM", formInitId: 900, totalCards: 42, access: "A" }]);
  });

  it("o ambiente de quem chamou vence o .env (o runner fixa o perfil do filho)", async () => {
    process.env.CANGE_OUTPUT_PROFILE = "lean";
    await writeDotenv("CANGE_ACCESS_TOKEN=token-do-dotenv\nCANGE_OUTPUT_PROFILE=full\n");
    const parsed = JSON.parse(await run(["--output", "json", "my-flows"]));
    expect(parsed).not.toHaveProperty("raw");
  });

  it("CANGE_OUTPUT do .env também vale (sem --output): pretty no lugar do json de pipe", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await writeDotenv("CANGE_ACCESS_TOKEN=token-do-dotenv\nCANGE_OUTPUT=pretty\n");
      const out = await run(["my-flows"]);
      expect(() => JSON.parse(out)).toThrow();
      expect(out).toContain("summaries:");
      expect(out).toContain("'CNG CRM'");
    } finally {
      if (original) Object.defineProperty(process.stdout, "isTTY", original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
