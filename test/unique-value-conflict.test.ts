import { describe, expect, it } from "vitest";

import { CangeApiError } from "../src/client/errors.js";
import { createCangeClient, UNIQUE_VALUE_CONFLICT_HINT } from "../src/client/http.js";
import { EXIT_CODES, exitCodeForError } from "../src/cli/exit-codes.js";

/**
 * Card #1533188: o back recusa valor repetido em campo de "valor único" com 422 e o corpo
 * { status, code: "UNIQUE_VALUE_CONFLICT", message, conflicts }. O kit tem de devolver um erro
 * legível (código, mensagem do back e hint), sair com exit 4 e NÃO repetir a escrita.
 */
const BODY = {
  status: "error",
  code: "UNIQUE_VALUE_CONFLICT",
  message: "O valor 123.456.789-09 do campo CPF já existe no cartão #1514700.",
  conflicts: [
    {
      field_id: 4410,
      field_name: "a1b2c3",
      field_title: "CPF",
      value: "123.456.789-09",
      card_id: 1514700,
      form_answer_id: 998877,
      message: "O valor 123.456.789-09 do campo CPF já existe no cartão #1514700."
    }
  ]
};

function clientReturning(status: number, body: unknown, calls: { n: number }) {
  const fetchFn: typeof globalThis.fetch = async () => {
    calls.n += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return createCangeClient({
    baseUrl: "https://api.cange.me",
    appOrigin: "https://app.cange.me",
    accessToken: "token",
    fetchFn,
    retryDelayMs: 0
  });
}

describe("422 UNIQUE_VALUE_CONFLICT", () => {
  it("vira CangeApiError com code, mensagem do back, hint e conflitos em details", async () => {
    const calls = { n: 0 };
    const client = clientReturning(422, BODY, calls);
    const error = await client.put("/form/answer", { body: { values: {} } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CangeApiError);
    const apiError = error as CangeApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("UNIQUE_VALUE_CONFLICT");
    expect(apiError.message).toBe(BODY.message);
    expect(apiError.hint).toBe(UNIQUE_VALUE_CONFLICT_HINT);
    expect((apiError.details as typeof BODY).conflicts[0]).toMatchObject({ field_title: "CPF", card_id: 1514700 });
    expect(apiError.toJSON()).toMatchObject({ code: "UNIQUE_VALUE_CONFLICT", hint: UNIQUE_VALUE_CONFLICT_HINT, status: 422 });
  });

  it("não entra no retry: uma chamada só, mesmo em método com retry", async () => {
    const calls = { n: 0 };
    const client = clientReturning(422, BODY, calls);
    await client.get("/form/check").catch(() => undefined);
    await client.post("/card/v2/move-step", { body: {} }).catch(() => undefined);
    expect(calls.n).toBe(2);
  });

  it("exit code 4 (EXIT_CODES.API)", async () => {
    const client = clientReturning(422, BODY, { n: 0 });
    const error = await client.post("/form/new-answer", { body: {} }).catch((e: unknown) => e);
    expect(exitCodeForError(error as Error)).toBe(EXIT_CODES.API);
    expect(EXIT_CODES.API).not.toBe(0);
  });

  it("erro sem code de primeiro nível segue igual (sem code nem hint novos)", async () => {
    const client = clientReturning(400, { status: "error", message: "Erro na validação", complement: { code: "X" } }, { n: 0 });
    const error = (await client.post("/form/new-answer", { body: {} }).catch((e: unknown) => e)) as CangeApiError;
    expect(error.code).toBeUndefined();
    expect(error.hint).toBeUndefined();
  });
});
