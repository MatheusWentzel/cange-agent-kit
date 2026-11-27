import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCangeAgentKit } from "../src/index.js";
import { createProgram } from "../src/cli/index.js";

const envBackup = { ...process.env };

/**
 * Leitura leve do GET /card/ (opt-in): `withRelationObjects=false` faz o back devolver os
 * vínculos só com value/valueString/relatedId, sem o cartão ou a entrada apontada inteira
 * (carregada em cascata). Caso real (26/11/2026): cartão de virada com 5 SIs passou de
 * 15 s e o agente nunca começava. O contrato só manda o parâmetro quando o chamador pede;
 * os comandos que só leem value/valueString pedem; `card get --raw`/`--raw-full` não.
 */
describe("GET /card/ com leitura leve", () => {
  const urls: URL[] = [];
  const stdout: string[] = [];

  beforeEach(() => {
    process.env.CANGE_ACCESS_TOKEN = "token";
    urls.length = 0;
    stdout.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(new URL(String(input)));
      return new Response(
        JSON.stringify({ id_card: 1563504, flow_id: 25198, flow_step_id: 133291, title: "2027", form_answers: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
  });

  afterEach(() => {
    process.env = { ...envBackup };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function cardReads(): URL[] {
    return urls.filter((url) => url.pathname === "/card/");
  }

  async function cli(args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "cange", "--output", "json", ...args]);
  }

  describe("contrato getCard", () => {
    const kit = () => createCangeAgentKit({ skipEnvLoad: true, configOverrides: { accessToken: "token" } });

    it("withRelationObjects: false manda o parâmetro", async () => {
      await kit().contracts.getCard({ cardId: 1563504, flowId: 25198, withRelationObjects: false });
      expect(cardReads()).toHaveLength(1);
      expect(cardReads()[0]!.searchParams.get("withRelationObjects")).toBe("false");
    });

    it("omitido: não manda nada (GET /card/ de sempre)", async () => {
      await kit().contracts.getCard({ cardId: 1563504, flowId: 25198 });
      expect(cardReads()[0]!.searchParams.has("withRelationObjects")).toBe(false);
    });

    it("withRelationObjects: true também não manda nada (o padrão do back já é completo)", async () => {
      await kit().contracts.getCard({ cardId: 1563504, flowId: 25198, withRelationObjects: true });
      expect(cardReads()[0]!.searchParams.has("withRelationObjects")).toBe(false);
    });
  });

  describe("CLI", () => {
    it("card read pede a leitura leve", async () => {
      await cli(["card", "read", "--flow-id", "25198", "--card-id", "1563504"]);
      expect(cardReads()).toHaveLength(1);
      expect(cardReads()[0]!.searchParams.get("withRelationObjects")).toBe("false");
    });

    it("card read em lote pede a leitura leve em cada cartão", async () => {
      await cli(["card", "read", "--flow-id", "25198", "--card-ids", "1,2", "--rps", "10"]);
      expect(cardReads()).toHaveLength(2);
      for (const url of cardReads()) expect(url.searchParams.get("withRelationObjects")).toBe("false");
    });

    it("card get (summary, padrão) pede a leitura leve", async () => {
      await cli(["card", "get", "--flow-id", "25198", "--card-id", "1563504"]);
      expect(cardReads()[0]!.searchParams.get("withRelationObjects")).toBe("false");
    });

    it("card get --raw e --raw-full seguem com a resposta completa", async () => {
      await cli(["card", "get", "--flow-id", "25198", "--card-id", "1563504", "--raw"]);
      await cli(["card", "get", "--flow-id", "25198", "--card-id", "1563504", "--raw-full"]);
      expect(cardReads()).toHaveLength(2);
      for (const url of cardReads()) expect(url.searchParams.has("withRelationObjects")).toBe(false);
    });
  });
});
