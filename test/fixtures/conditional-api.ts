import { flow } from "./conditional-flow.js";

type Rec = Record<string, unknown>;

export interface ApiCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Rec;
}

/**
 * Cange de mentira com as rotas que a condicional usa, nas formas reais de resposta.
 * Cada busca responde pelo PARÂMETRO certo: perguntar com outro campo devolve outra coisa.
 */
export class FakeConditionalApi {
  public rules: Rec[] = [];
  public stepRules: Rec[] = [];
  public calls: ApiCall[] = [];
  /** O que o back guarda do corpo enviado (`undefined` = não achou a linha). */
  public persist: (body: Rec) => Rec | undefined = (body) => ({ ...body });
  /** Falha por rota (`"POST /conditional"`): status HTTP, ou `network` para a conexão cair. */
  public failures: Record<string, number | "network"> = {};
  public newId: unknown = 555;

  public posts(): ApiCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  public readonly fetch = async (input: unknown, init?: { method?: string; body?: unknown }): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const query = Object.fromEntries(url.searchParams);
    const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : undefined;
    this.calls.push({ method, path: url.pathname, query, ...(body ? { body } : {}) });
    const route = `${method} ${url.pathname}`;
    const failure = this.failures[route];
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure !== undefined) return this.json({ message: "falhou" }, failure);

    switch (route) {
      case "GET /flow":
        return this.json(flow(this.rules, query.removeStepsCondicionals === "false" ? this.stepRules : []));
      case "GET /conditional/by-field":
        return this.json(this.rules.filter((rule) => String(rule.field_id) === query.field_id));
      case "GET /conditional/by-step":
        return this.json(
          this.stepRules.filter(
            (rule) =>
              String(rule.flow_step_id) === query.flow_step_id && String(rule.flow_step_parent_id) === query.flow_step_parent_id
          )
        );
      case "GET /user/by-flow":
        return this.json(
          query.form_id === "200"
            ? [
                { id_user: 41, id: 9041, name: "Ana Teste", email: "ana@example.com", flow_user_type: "M" },
                { id_user: 42, id: 9042, name: "Bia Teste", email: "bia@example.com", flow_user_type: "V" }
              ]
            : []
        );
      case "GET /form/answer":
        if (query.id_form_answer === "700") return this.json({ id_form_answer: 700, register_id: 70, card_id: 71 });
        if (query.id_form_answer === "701") return this.json({ id_form_answer: 701, register_id: 71, card_id: 70 });
        return this.json({ message: "não encontrada" }, 404);
      case "GET /card/locate":
        if (query.id_card === "800") return this.json({ id_card: 800, flow_id: 80, flow_name: "Pedidos" });
        if (query.id_card === "801") return this.json({ id_card: 801, flow_id: 81, flow_name: "Outro" });
        return this.json({ message: "não encontrado" }, 404);
      case "POST /conditional":
        return this.save(body!);
      default:
        return this.json({ message: `rota inesperada ${route}` }, 404);
    }
  };

  private save(body: Rec): Response {
    const stored = this.persist(body);
    const list = body.type === "step" ? this.stepRules : this.rules;
    if (body.id_conditional !== undefined) {
      const at = list.findIndex((rule) => rule.id_conditional === body.id_conditional);
      if (stored && at >= 0) {
        list[at] = { ...list[at], action: stored.action, conditions_items: stored.conditions_items, name: stored.name };
      }
      // Como o back: no update responde 200 com o objeto enviado, mesmo sem achar a linha.
      return this.json(body);
    }
    const row = { id_conditional: this.newId, index: null, ...(stored ?? body) };
    if (stored) list.push(row);
    return this.json(row);
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }
}
