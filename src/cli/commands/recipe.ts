import type { Command } from "commander";

import { CangeCliUsageError } from "../../client/errors.js";
import { annotateCommand } from "../command-metadata.js";
import { createCommandAction } from "../context.js";

/**
 * `cange recipe <nome>` — receitas SOB DEMANDA (rodada 5, 01/10).
 *
 * O bloco do CLI que o runner põe no system prompt de todo agente é relido a cada
 * chamada à API. As receitas de escrita que o agente NÃO tem liberadas (e a receita
 * rara do anexo) saíram dele: quem precisa lê aqui, uma vez, no run em que precisa.
 * O caminho da pasta do run é o marcador `<PASTA_DO_RUN>`, como no system prompt;
 * com TMPDIR no ambiente (o runner aponta para a pasta do run), a 1ª linha diz qual é.
 *
 * O texto sai CRU (não JSON): é instrução para ler, não dado para processar.
 */
const RUN_FOLDER = "<PASTA_DO_RUN>";

export const RECIPES: Readonly<Record<string, { title: string; lines: readonly string[] }>> = Object.freeze({
  anexo: {
    title: "Ler um anexo do cartão (proposta, documento, comprovante)",
    lines: [
      `1) Baixe pelo comando (rota autenticada): \`cange attachment download --flow-id <id> --card-id <id> --out ${RUN_FOLDER}/anexos\`.`,
      "   O anexo vive num CAMPO do cartão (tipo anexo), não na colaboração nem no relacionamento.",
      "   NUNCA baixe com curl na URL do blob (Azure): dá 404 ou 403.",
      "2) PDF ou DOCX: NUNCA use `Read` no arquivo binário (vira base64 e explode o contexto; 1,5 MB num run real).",
      "   Extraia o TEXTO primeiro e leia o .txt:",
      `   - docx: \`textutil -convert txt <arquivo>.docx -output ${RUN_FOLDER}/doc.txt\``,
      `   - pdf: \`pdftotext <arquivo>.pdf ${RUN_FOLDER}/doc.txt\` (sem pdftotext: \`python3 -c "import pypdf; ..."\`)`,
      "3) Planilha (xlsx/csv): leia com python3 e imprima só o resumo que a tarefa pede, nunca o arquivo inteiro."
    ]
  },
  comentar: {
    title: "Comentar num cartão (só com \"Comentar\" liberado)",
    lines: [
      "Comando: `cange comment create --payload <caminho.json>`. O grupo é `comment` e o subcomando é `create`:",
      "não existe `cange comment` sozinho nem `cange card comment`.",
      "`--payload` é SEMPRE um caminho de arquivo .json, nunca JSON inline.",
      "Shape do arquivo: `{ \"cardId\": <id>, \"flowId\": <id>, \"description\": \"<texto em markdown>\", \"mentions\": [] }`.",
      `1) Grave \`${RUN_FOLDER}/comentario-20260930-1432.json\` (nome único por ação, com data e hora).`,
      `2) Em OUTRO comando, sozinho: \`cange comment create --payload ${RUN_FOLDER}/comentario-20260930-1432.json\`.`
    ]
  },
  "criar-card": {
    title: "Criar um cartão num fluxo (só com \"Criar card\" liberado)",
    lines: [
      "1) Fluxo: pelo id que você já tem, ou `cange my-flows` e escolha pelo nome (ambíguo: pergunte).",
      "2) `cange map --flow-id <id>`: use o `formInitId` do fluxo e os campos com `formId` igual a ele. A chave de cada",
      "   valor é o `id` numérico do campo, como texto (o kit traduz para o campo certo), ou o `name` (hash, no `map --full`).",
      `3) Grave \`${RUN_FOLDER}/novo-card-20260930-1432.json\` (nome único) com`,
      "   `{ \"flowId\": <id>, \"idForm\": <formInitId>, \"origin\": \"agente\", \"values\": { \"<id-do-campo>\": \"<valor>\" } }`.",
      `4) Confira: \`cange card create --payload ${RUN_FOLDER}/novo-card-20260930-1432.json --dry-run --validate-fields\`.`,
      "   Campo obrigatório sem valor: grave o arquivo corrigido e confira de novo.",
      `5) Só então, sozinho: \`cange card create --payload ${RUN_FOLDER}/novo-card-20260930-1432.json --validate-fields\` (devolve o cardId).`
    ]
  },
  "mover-card": {
    title: "Mover um cartão de etapa (só com \"Mover card\" liberado)",
    lines: [
      "1) Leia o cartão (`cange card read`) para saber a etapa ATUAL.",
      "2) `cange map --flow-id <id>`: da etapa de destino pegue o id (`steps[].id`) e o form (`steps[].formId`, que é o",
      "   `idForm` do mover).",
      `3) Grave \`${RUN_FOLDER}/mover-card-20260930-1432.json\` com`,
      "   `{ \"cardId\": <id>, \"flowId\": <id>, \"fromStepId\": <etapa atual>, \"toStepId\": <etapa destino>, \"idForm\": <formId da etapa destino>, \"values\": {} }`",
      "   (os nomes são `fromStepId` e `toStepId`; `stepId` sozinho não funciona; sem `idForm` a conferência falha).",
      "4) Confira: `cange card move-step-with-values --payload <arquivo> --dry-run --validate-fields`. Se ela responder",
      "   \"Nenhum field encontrado para o idForm\" com `values` {}, a etapa de destino não tem campos: confira de novo só",
      "   com `--dry-run` (sem `--validate-fields`).",
      "5) Rode o mesmo comando sem o `--dry-run` (e sem `--validate-fields` quando a etapa de destino não tem campos)."
    ]
  },
  "publicar-artefato": {
    title: "Publicar um artefato (página HTML; só com \"Publicar artefato\" liberado)",
    lines: [
      `1) Grave o HTML num arquivo da pasta do run (ex.: \`${RUN_FOLDER}/artefato-20260930-1432.html\`).`,
      "2) Em OUTRO comando, sozinho:",
      `   - no cartão do run: \`cange artifact publish --card-id <id> --type <slug> --title '<título por extenso>' --file ${RUN_FOLDER}/artefato-20260930-1432.html\`;`,
      `   - no chat sem cartão em foco: o mesmo comando SEM \`--card-id\` (o kit usa a conversa).`,
      "3) Republicar o mesmo `--type` no mesmo dono vira NOVA VERSÃO do mesmo artefato. Antes, confira com o MESMO",
      "   comando e `--dry-run`: aviso em `warnings` = aquele trecho NÃO entrou."
    ]
  }
});

export function recipeNames(): string[] {
  return Object.keys(RECIPES);
}

/** Texto da receita (com a pasta do run na 1ª linha quando o TMPDIR existe). */
export function renderRecipe(name: string, env: Record<string, string | undefined> = process.env): string {
  const recipe = RECIPES[name];
  if (!recipe) {
    throw new CangeCliUsageError(
      `Receita "${name}" não existe. Receitas: ${recipeNames().join(", ")} (ex.: \`cange recipe anexo\`).`
    );
  }
  const scratch = env.TMPDIR?.trim();
  return [
    `# ${recipe.title}`,
    ...(scratch && scratch.startsWith("/")
      ? [`PASTA_DO_RUN = ${scratch.replace(/\/+$/, "")} (troque ${RUN_FOLDER} por este caminho, escrito por extenso)`]
      : []),
    ...recipe.lines
  ].join("\n");
}

export function registerRecipeCommand(program: Command): void {
  const command = program
    .command("recipe")
    .description("Receita pronta de uma ação sob demanda (anexo, comentar, criar-card, mover-card, publicar-artefato)")
    .argument("[nome]", `Nome da receita: ${recipeNames().join(" | ")}`)
    .action(
      createCommandAction(
        async (_ctx, name: string | undefined) => {
          const text = name
            ? renderRecipe(name.trim().toLowerCase())
            : `Receitas: ${recipeNames().join(", ")}. Uso: \`cange recipe <nome>\`.`;
          process.stdout.write(`${text}\n`);
          return undefined;
        },
        { requiresAuth: false }
      )
    );

  annotateCommand(command, {
    envelope: "texto cru (não JSON): a receita, com a pasta do run na 1ª linha quando o TMPDIR existe",
    fieldsLocation: "stdout inteiro é a receita",
    example: "cange recipe anexo"
  });
}
