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

import { hasScreenFormat, screenFormattedValue, typedFormatError } from "./screenFormat.js";
import { PERCENT_FRACTION_LIMIT, isPercentField, percentSuspectText } from "./valueResolver.js";

export type ConditionalKind = "field" | "step";

export interface ConditionExecution {
  issues: string[];
  warnings: string[];
}

/** O bastante de um item de `conditions_items`, novo ou já gravado. */
export interface ExecutableCondition {
  idField?: number;
  type: string;
  /** `variation` do campo: percentual (número "2", fórmula "3") e tipo de documento. */
  variation?: string;
  title: string;
  comparator: string;
  value: string;
  valueOptions: readonly string[];
}

const TEXT_TYPES = new Set(["TEXT_SHORT_FIELD", "TEXT_LONG_FIELD", "MAIL_FIELD", "PHONE_FIELD", "DOC_FIELD", "LINK_FIELD", "ID_FIELD"]);
const DATE_TYPES = new Set(["DATE_PICKER_FIELD", "DUE_DATE_FIELD"]);
const NUMBER_TYPES = new Set(["NUMBER_FIELD", "CURRENCY_FIELD"]);
/** Tipos cuja resposta, no formulário aberto, é uma LISTA. */
const LIST_ANSWER_TYPES = new Set(["CHECK_BOX_FIELD", "COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"]);
/** Destes, os que guardam ids numéricos na lista (o valor da regra é texto). */
const NUMERIC_LIST_TYPES = new Set(["COMBO_BOX_REGISTER_FIELD", "COMBO_BOX_FLOW_FIELD"]);
const USER_TYPES = new Set(["COMBO_BOX_USER_FIELD", "REQUESTER_FIELD"]);

const BLANK = "Está em branco";
const NOT_BLANK = "Não está em branco";
const EQUAL = "Igual a";
const NOT_EQUAL = "Não é igual a";
const ONE_OF = "É uma das";
const NOT_ONE_OF = "Não é uma das";
const CONTAINS = "Contém";
const NOT_CONTAINS = "Não contém";

const INVERSE: Readonly<Record<ConditionalKind, string>> = {
  field: "a ação inversa (exibir no lugar de esconder, e vice-versa)",
  step: "a ação inversa (permitir no lugar de bloquear, e vice-versa)"
};

/**
 * A saída que funciona, provada no avaliador. Só vale na ÚLTIMA regra do alvo: regra que casa
 * encerra a avaliação, regra que não casa passa a vez para a seguinte.
 */
function inverseOf(kind: ConditionalKind, comparator: string): string {
  return (
    `Saída, se for a última regra do alvo: "${comparator}" com ${INVERSE[kind]}. ` +
    `Com outras condições na regra: primeiro uma regra só com "${comparator}" e a ação inversa, depois outra com as demais condições e a ação original.`
  );
}

function isFiniteNumber(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text));
}

/** `parseFormulaConditionValue` da tela: "0,5", "0.5" e "50%" (fração). */
function formulaNumber(text: string): number {
  let normalized = text.replace(/\s/g, "");
  const percent = normalized.endsWith("%");
  if (percent) normalized = normalized.slice(0, -1);
  if (normalized.includes(",")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  return Math.round((percent ? Number(normalized) / 100 : Number(normalized)) * 1e9) / 1e9;
}

/** Resposta em branco de outro formulário chega como "" e a tela faz `Number("")`, que é 0. */
function matchesZero(comparator: string, value: number): boolean {
  switch (comparator) {
    case EQUAL:
      return value === 0;
    case NOT_EQUAL:
      return value !== 0;
    case "Menor que":
      return 0 < value;
    case "Maior que":
      return 0 > value;
    case "Igual a ou menor que":
      return 0 <= value;
    case "Igual a ou maior que":
      return 0 >= value;
    default:
      return false;
  }
}

function blankNumberWarning(kind: ConditionalKind, where: string, comparator: string, text: string, value: number): string | undefined {
  const matches = matchesZero(comparator, value);
  if (comparator === NOT_EQUAL) {
    return matches ? undefined : `${where}: sem resposta a tela conta 0, então "${comparator} ${text}" NÃO casa com o campo em branco.`;
  }
  if (!matches) return undefined;
  const risk =
    kind === "step"
      ? " Numa regra que libera a etapa, o cartão passa sem o número preenchido."
      : "";
  return `${where}: sem resposta a tela conta 0, então "${comparator} ${text}" casa com o campo em branco.${risk} Some a condição "${NOT_BLANK}" no mesmo campo.`;
}

export function inspectExecution(kind: ConditionalKind, condition: ExecutableCondition): ConditionExecution {
  const { idField, type, comparator, value } = condition;
  const blankComparator = comparator === BLANK || comparator === NOT_BLANK;
  const issues: string[] = [];
  const warnings: string[] = [];
  const where = `campo "${condition.title}"`;
  const done = (): ConditionExecution => ({ issues, warnings });

  if (!blankComparator && value === "" && condition.valueOptions.length === 0) {
    issues.push(`${where}: condição sem valor, o avaliador a pula (conta como verdadeira).`);
    return done();
  }

  if (idField === -9) {
    issues.push(`${where}: o avaliador ignora a Data de Conclusão (-9); a condição não depende da data. Use um campo de data do formulário.`);
    return done();
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
    return done();
  }

  if (DATE_TYPES.has(type)) {
    if (comparator === NOT_EQUAL) {
      const blank =
        kind === "field"
          ? ` Com a data vazia o efeito muda (a tela trata vazia como igual); em regra de uma condição só, ponha antes uma regra com "${BLANK}" e a ação original.`
          : "";
      issues.push(`${where}: "${NOT_EQUAL}" em data sempre casa (compara dia com dia e hora). ${inverseOf(kind, EQUAL)}${blank}`);
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
    return done();
  }

  if (type === "INPUT_RICH_TEXT_FIELD") {
    if (comparator === CONTAINS || comparator === NOT_CONTAINS) {
      warnings.push(
        `${where}: "${comparator}" procura no HTML do texto formatado. Negrito no meio, &, espaço especial e nome de marca (p, strong) mudam o resultado; use um trecho curto e sem formatação.`
      );
    } else if (comparator === EQUAL || comparator === NOT_EQUAL) {
      if (!value.trim().startsWith("<")) {
        const effect = comparator === NOT_EQUAL && kind === "field" ? "sempre" : "nunca";
        issues.push(
          `${where}: o texto formatado é comparado com as marcas HTML (<p>...</p>), então "${comparator}" com texto puro ${effect} casa. Use "${comparator === EQUAL ? CONTAINS : NOT_CONTAINS}".`
        );
      } else if (kind === "step" && comparator === NOT_EQUAL) {
        issues.push(`${where}: em condicional de etapa, "${NOT_EQUAL}" sai invertido (casa quando é igual). ${inverseOf(kind, EQUAL)}`);
      } else {
        warnings.push(`${where}: "${comparator}" compara o HTML inteiro do texto formatado; qualquer marca a mais muda o resultado.`);
      }
    }
    return done();
  }

  if (NUMBER_TYPES.has(type)) {
    if (blankComparator) return done();
    if (!isFiniteNumber(value)) {
      issues.push(`${where}: "${value}" não é lido como número. Use ponto decimal (ex.: 1500.5); em percentual, a fração (10% é 0.1).`);
      return done();
    }
    const number = Number(value);
    if (isPercentField({ type, ...(condition.variation !== undefined ? { variation: condition.variation } : {}) })) {
      if (Math.abs(number) > PERCENT_FRACTION_LIMIT) {
        issues.push(`${where} (percentual, guarda fração): ${percentSuspectText(number)}.`);
        return done();
      }
      if (Math.abs(number) > 1) warnings.push(`${where} (percentual, guarda fração): confira, ${percentSuspectText(number)}.`);
    }
    const blank = blankNumberWarning(kind, where, comparator, value, number);
    if (blank) warnings.push(blank);
    return done();
  }

  if (kind === "step" && comparator === NOT_EQUAL && (TEXT_TYPES.has(type) || type === "FORMULA_FIELD")) {
    issues.push(`${where}: em condicional de etapa, "${NOT_EQUAL}" sai invertido (casa quando é igual). ${inverseOf(kind, EQUAL)}`);
    return done();
  }

  if (type === "FORMULA_FIELD") {
    if (blankComparator) return done();
    if (kind === "step" && !isFiniteNumber(value)) {
      issues.push(
        `${where}: em condicional de etapa, fórmula só compara número com ponto decimal; "${value}" nunca casa. Percentual é fração: 50% é 0.5.`
      );
      return done();
    }
    const number = formulaNumber(value);
    if (!Number.isFinite(number)) {
      issues.push(`${where}: "${value}" não é lido como número.`);
      return done();
    }
    if (condition.variation === "3" && !value.trim().endsWith("%") && Math.abs(number) > PERCENT_FRACTION_LIMIT) {
      issues.push(`${where} (fórmula percentual, guarda fração): use a fração; ${number / 100} é ${number}%.`);
      return done();
    }
    if (kind === "step" && comparator === EQUAL) {
      const canonical = String(Number(value));
      if (canonical !== value) {
        issues.push(
          `${where}: em condicional de etapa, "${EQUAL}" de fórmula compara texto; "${value}" nunca casa. Use "${canonical}".`
        );
      } else {
        warnings.push(`${where}: em condicional de etapa, "${EQUAL}" de fórmula compara texto (10 não casa com 10.00).`);
      }
      return done();
    }
    const blank = blankNumberWarning(kind, where, comparator, value, number);
    if (blank) warnings.push(blank);
    return done();
  }

  if (type === "ID_FIELD") {
    warnings.push(`${where}: com o campo no formulário aberto a resposta é sempre "#"; só acerta com o ID já gravado (o número, sem "#").`);
    return done();
  }

  if (hasScreenFormat(type) && !blankComparator) {
    const complete = typedFormatError(type, condition.variation, value) === undefined;
    const masked = screenFormattedValue(type, condition.variation, value);
    if (complete && masked.toLowerCase() !== value.toLowerCase()) {
      const effect = comparator === NOT_EQUAL || comparator === NOT_CONTAINS ? "sempre" : "nunca";
      issues.push(`${where}: a resposta vem com a máscara da tela, então "${comparator} ${value}" ${effect} casa. Use "${masked}".`);
    } else if (!complete && (comparator === EQUAL || comparator === NOT_EQUAL)) {
      warnings.push(`${where}: "${value}" não é um documento ou telefone válido e completo para este campo; a tela só aceita válido, com máscara.`);
    } else if (!complete && /[0-9a-z]{3}/i.test(value) && !/[^0-9a-z]/i.test(value)) {
      warnings.push(`${where}: a resposta vem com a máscara da tela; um trecho sem a pontuação pode não ser achado.`);
    }
    return done();
  }

  if (type === "CHECK_BOX_ONE_FIELD") {
    const effect = comparator === NOT_EQUAL || comparator === NOT_ONE_OF || comparator === NOT_BLANK ? "sempre" : "nunca";
    issues.push(`${where}: a resposta da caixa única é verdadeiro ou falso, nunca o código da opção, então "${comparator}" ${effect} casa. Use um campo Switch.`);
    return done();
  }

  if (type === "INPUT_LIST_FIELD") {
    if (!blankComparator) {
      const effect = comparator === NOT_EQUAL || comparator === NOT_ONE_OF ? "sempre" : "nunca";
      issues.push(`${where}: a lista de itens responde com textos livres, não com o código da opção, então "${comparator}" ${effect} casa. Só "${BLANK}" e "${NOT_BLANK}" funcionam.`);
    }
    return done();
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

  // O responsável padrão (-3) vem do cartão, como texto: não sofre disto.
  const formUser = USER_TYPES.has(type) && (idField === undefined || idField > 0);
  if (kind === "step" && formUser && (comparator === NOT_EQUAL || comparator === ONE_OF || comparator === NOT_ONE_OF)) {
    warnings.push(
      `${where}: em condicional de etapa, com o campo no formulário aberto, "${comparator}" ${comparator === ONE_OF ? "nunca" : "sempre"} casa (só acerta com a resposta já gravada em outro formulário). "${EQUAL}" funciona.`
    );
  }

  return done();
}
