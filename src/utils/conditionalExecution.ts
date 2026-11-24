/**
 * O que o avaliador da tela FAZ com uma condição, quando isso difere do que ela diz.
 *
 * A tela deixa criar regras que ela mesma executa errado. Quem cria pela tela testa e vê; um
 * agente não testa, então o kit recusa (`issues`) ou avisa (`warnings`). Cada caso saiu de rodar
 * os avaliadores reais (`getCheckConditionalField` e `getCheckConditionalStep`) offline, tipo a
 * tipo, comparador a comparador. Se a tela for corrigida, é aqui que o caso sai.
 *
 *  - `issues`: nunca casa, sempre casa ou sai invertida. Regra nova assim é RECUSADA.
 *  - `warnings`: erra só em parte das situações. Regra nova passa, com o aviso na resposta.
 */

export type ConditionalKind = "field" | "step";

export interface ConditionExecution {
  issues: string[];
  warnings: string[];
}

/** O bastante de um item de `conditions_items`, novo ou já gravado. */
export interface ExecutableCondition {
  idField?: number;
  type: string;
  title: string;
  comparator: string;
  value: string;
  valueOptions: readonly string[];
}

const TEXT_TYPES = new Set([
  "TEXT_SHORT_FIELD",
  "TEXT_LONG_FIELD",
  "MAIL_FIELD",
  "PHONE_FIELD",
  "DOC_FIELD",
  "LINK_FIELD",
  "ID_FIELD",
  "INPUT_RICH_TEXT_FIELD"
]);
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD"]);
/** Tipos cuja resposta, no formulário aberto, é uma LISTA. */
const LIST_ANSWER_TYPES = new Set([
  "CHECK_BOX_FIELD",
  "INPUT_LIST_FIELD",
  "COMBO_BOX_REGISTER_FIELD",
  "COMBO_BOX_FLOW_FIELD"
]);
/** Destes, os que guardam ids numéricos na lista (o valor da regra é texto). */
const NUMERIC_LIST_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"]);
const USER_TYPES = new Set(["COMBO_BOX_USER_FIELD", "REQUESTER_FIELD"]);

const BLANK = "Está em branco";
const NOT_BLANK = "Não está em branco";
const EQUAL = "Igual a";
const NOT_EQUAL = "Não é igual a";
const NOT_ONE_OF = "Não é uma das";
const ONE_OF = "É uma das";

const INVERSE: Readonly<Record<ConditionalKind, string>> = {
  field: "a ação inversa (exibir no lugar de esconder, e vice-versa)",
  step: "a ação inversa (permitir no lugar de bloquear, e vice-versa)"
};

function inverseOf(kind: ConditionalKind, comparator: string): string {
  return `Numa regra de uma condição só, use "${comparator}" com ${INVERSE[kind]}.`;
}

function isFiniteNumber(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text));
}

export function inspectExecution(kind: ConditionalKind, condition: ExecutableCondition): ConditionExecution {
  const { idField, type, comparator } = condition;
  const blankComparator = comparator === BLANK || comparator === NOT_BLANK;
  const issues: string[] = [];
  const warnings: string[] = [];
  const where = `campo "${condition.title}"`;

  if (!blankComparator && condition.value === "" && condition.valueOptions.length === 0) {
    issues.push(`${where}: condição sem valor, o avaliador a pula (conta como verdadeira).`);
    return { issues, warnings };
  }

  if (idField === -9) {
    issues.push(`${where}: o avaliador ignora a Data de Conclusão (-9); a condição não depende da data. Use um campo de data do formulário.`);
    return { issues, warnings };
  }

  if (idField === -1 || idField === -2) {
    if (comparator === BLANK) {
      issues.push(`${where}: "${BLANK}" nunca casa nesta data padrão. ${inverseOf(kind, NOT_BLANK)}`);
    } else if (comparator === NOT_EQUAL) {
      issues.push(
        `${where}: "${NOT_EQUAL}" ignora o valor e casa com qualquer data preenchida. Se a intenção é "preenchida", use "${NOT_BLANK}"; para comparar, use um campo de data do formulário.`
      );
    } else if (comparator !== NOT_BLANK) {
      issues.push(
        `${where}: "${comparator}" nunca casa, o avaliador não consegue ler a data padrão do cartão. Use um campo de data ou de vencimento do formulário.`
      );
    }
    return { issues, warnings };
  }

  if (DATE_TYPES.has(type)) {
    if (comparator === NOT_EQUAL) {
      issues.push(`${where}: "${NOT_EQUAL}" em data sempre casa (compara dia com dia e hora). ${inverseOf(kind, EQUAL)}`);
    } else if (comparator === NOT_BLANK) {
      if (kind === "field") {
        issues.push(
          `${where}: "${NOT_BLANK}" em data casa também com a data vazia (apagada, ou de outro formulário do cartão). ${inverseOf(kind, BLANK)}`
        );
      }
    } else if (comparator !== BLANK) {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(condition.valueOptions[0] ?? "")) {
        issues.push(`${where}: o valor não é uma data dd/MM/yyyy (atalho relativo, como hoje, nunca casa).`);
      } else if (kind === "field") {
        warnings.push(`${where}: "${comparator}" casa também com a data vazia (apagada, ou de outro formulário do cartão).`);
      }
    }
    return { issues, warnings };
  }

  if (!blankComparator && (type === "NUMBER_FIELD" || type === "CURRENCY_FIELD") && !isFiniteNumber(condition.value)) {
    issues.push(`${where}: "${condition.value}" não é lido como número. Use ponto decimal (ex.: 1500.5).`);
    return { issues, warnings };
  }

  if (kind === "step" && comparator === NOT_EQUAL && (TEXT_TYPES.has(type) || type === "FORMULA_FIELD")) {
    issues.push(`${where}: em condicional de etapa, "${NOT_EQUAL}" sai invertido (casa quando é igual). ${inverseOf(kind, EQUAL)}`);
    return { issues, warnings };
  }

  if (kind === "step" && type === "FORMULA_FIELD" && !blankComparator) {
    if (!isFiniteNumber(condition.value)) {
      issues.push(
        `${where}: em condicional de etapa, fórmula só compara número com ponto decimal; "${condition.value}" nunca casa. Percentual é fração: 50% é 0.5.`
      );
    } else if (comparator === EQUAL) {
      const canonical = String(Number(condition.value));
      if (canonical !== condition.value) {
        issues.push(
          `${where}: em condicional de etapa, "${EQUAL}" de fórmula compara texto; "${condition.value}" nunca casa. Use "${canonical}".`
        );
      } else {
        warnings.push(`${where}: em condicional de etapa, "${EQUAL}" de fórmula compara texto (10 não casa com 10.00).`);
      }
    }
    return { issues, warnings };
  }

  if (type === "INPUT_RICH_TEXT_FIELD" && (comparator === EQUAL || comparator === NOT_EQUAL)) {
    const effect = comparator === EQUAL ? "nunca" : "sempre";
    if (condition.value.trim().startsWith("<")) {
      warnings.push(`${where}: "${comparator}" compara o HTML inteiro do texto formatado; qualquer marca a mais muda o resultado.`);
    } else {
      issues.push(
        `${where}: o texto formatado é comparado com as marcas HTML (<p>...</p>), então "${comparator}" com texto puro ${effect} casa. Use "${comparator === EQUAL ? "Contém" : "Não contém"}".`
      );
    }
  }

  if (LIST_ANSWER_TYPES.has(type) && !blankComparator) {
    const negative = comparator === NOT_EQUAL || comparator === NOT_ONE_OF;
    if (kind === "step" && (negative || comparator === ONE_OF)) {
      warnings.push(
        `${where}: em condicional de etapa, com o campo no formulário aberto, "${comparator}" ${negative ? "sempre" : "nunca"} casa (só acerta com a resposta já gravada em outro formulário).`
      );
    } else if (negative || kind === "step" || NUMERIC_LIST_TYPES.has(type)) {
      warnings.push(`${where}: "${comparator}" erra quando a resposta tem mais de um item.`);
    }
  }

  if (kind === "step" && USER_TYPES.has(type) && (comparator === NOT_EQUAL || comparator === ONE_OF || comparator === NOT_ONE_OF)) {
    if (idField === undefined || idField > 0) {
      warnings.push(
        `${where}: em condicional de etapa, com o campo no formulário aberto, "${comparator}" ${comparator === ONE_OF ? "nunca" : "sempre"} casa (só acerta com a resposta já gravada em outro formulário). "${EQUAL}" funciona.`
      );
    }
  }

  return { issues, warnings };
}
