# AGENTS.md - cange-agent-kit

Este projeto existe para ser a camada segura entre agentes e a API do Cange.

## Regras operacionais obrigatórias

- Nunca chamar `curl` direto se houver comando da CLI disponível.
- Sempre preferir discovery antes de mutações.
- Para qualquer payload com `values`, consultar primeiro a estrutura de fields.
- A chave de `values` é sempre `field.name`.
- O valor enviado deve respeitar `field.type`.
- Na criação, preencher todos os campos com `required = "1"` do formulário-alvo.
- Para card create, usar `flow.form_init_id`.
- Para register create/update, usar `register.form_id`.
- Para register create, o payload precisa do `registerId` (id do cadastro) **na raiz**, além do `idForm`: o backend resolve a referência por `register_id` no body. Sem ele, 404 "não foi possível encontrar a referência do formulário" — que parece falta de acesso, mas é payload. No register update, mandar `registerId` junto do `formAnswerId`.
- Para mover etapa de card, usar `card move --card-id <id> --to <etapa>` (ou `card move-step-with-values`, que sem `--payload` é o mesmo).
- Quando não houver campos para preencher, enviar `values: {}`.
- Ao mover etapa com `--payload`, o `idForm` do payload deve ser o `form_id` da etapa atual (`flow_step.form_id`), não o `form_init_id` do fluxo, e os `values` só desse formulário (o `card move` separa os formulários sozinho).
- Ao mover etapa, preencher todos os campos com `required = "1"` do `form_id` da etapa atual antes de mover.
- Ao mover etapa, **preservar os campos já preenchidos** (read-before-move): o move grava um form_answer NOVO contendo só o que vier em `values` — campos do `form_id` da etapa não reenviados ficam vazios (perda de dados). Ler o card antes (`card get`) e incluir no `values` os campos já preenchidos, além dos obrigatórios. O kit detecta e avisa campos preenchidos ausentes do `values`; use `--allow-data-loss` para confirmar perda intencional ou `--fail-on-data-loss` para bloquear.
- **Nunca fazer self-move** (`fromStepId === toStepId`) para "criar"/preencher um form_answer: duplica o form_answer e o snapshot vazio mais recente sobrepõe o preenchido. Para apenas atualizar values sem mover, usar `card update-values`. O kit bloqueia self-move por padrão (`--allow-self-move` força).
- Usar `step-form --flow-id <id> --step-id <id>` para descobrir obrigatórios da etapa antes de montar payload.
- Para marcar notificação como lida/arquivada, usar `notification read`.
- Usar `template flow-create`, `template register-create` e `template step-move` antes de mutações quando necessário.
- Usar `--validate-fields` e `--dry-run` antes de mutações quando apropriado.
- Se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, omitir `--validate-fields` e executar apenas com `--dry-run`. Tipos não mapeados na validação local não impedem a mutação na API.
- `--payload` (avançado) sempre recebe caminho de arquivo JSON, nunca JSON inline. Valores inline: `--set` / `--values-json`.
- Inputs de mutação fora de `values` devem usar camelCase (`flowId`, `cardId`, `registerId` etc).
- Não inventar IDs.
- Não inventar chaves de `values`.
- Se houver falha de autenticação, revisar `CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` / `CANGE_APIKEY`.

## Formato da saída (padrão enxuto desde 01/10/2026)

- O padrão é a saída ENXUTA: JSON sem indentação (em pipe), sem campo nulo ou vazio, sem aliases snake_case
  (`id_card`, `flow_id`, `step_id`, `fields` duplicado), sem `raw` junto do resumo.
- `--full` (opção global, em qualquer posição) ou `CANGE_OUTPUT_PROFILE=full` devolve o formato COMPLETO de
  antes, byte a byte. `--raw`/`--raw-full` continuam crus.
- `CANGE_OUTPUT_PROFILE` e `CANGE_OUTPUT` valem tanto do ambiente do processo quanto do `.env` do diretório
  (o mesmo `.env` do token). Agente local ou script que lê o formato antigo (`raw` do `my-flows`,
  `summary.fields` do `card get`, `fieldValues` do `card read`) põe `CANGE_OUTPUT_PROFILE=full` no `.env` do
  clone ou no ambiente do processo. O ambiente do processo vence o `.env`.
- O que muda no enxuto:
  - `my-flows`: `summaries` [{id, title, formInitId, totalCards, access}] (sem `raw`);
  - `card read`: `fields` [{id, title, value}] com o título do campo; vínculo em `cards` [{cardId, label}] e
    cadastro em `entries` [{entryId, label}] dentro do campo; rich text em markdown, com `format: "markdown"`
    no campo convertido (`--field-ids` devolve o valor original, para reescrever);
  - `card list`: título real e `stepName` em cada cartão;
  - `comment list`: os 15 mais recentes, em markdown (`--limit <n>` traz mais; `total` diz quantos existem);
  - `map`: campos sem o hash `name` (o `values` aceita o id numérico do campo como chave em card create,
    update-values, move, add-child (também no `linkField`) e register create/update; o kit traduz para o hash
    antes de gravar e id inexistente falha sem gravar nada; `map --full` mostra o hash).
- Receitas sob demanda: `cange recipe <anexo|comentar|mencionar|criar-card|mover-card|gravar-campos|publicar-artefato|cadastro-por-nome>` (texto cru).

## Escrita em 1 passo (padrão desde 06/10/2026)

O caminho padrão de toda escrita é UM comando, sem arquivo de rascunho. O `--payload <arquivo>` virou opção avançada.

- Criar: `cange card create --flow-id <id> --set "Título=Pedido ACME" --set "Valor=R$ 2.500,00"`
- Gravar campos sem mover: `cange card update-values --card-id <id> --set "Data da ligação=06/10/2026"`
  (o fluxo vem do link do cartão ou do ambiente do run; fora dele, `--flow-id`).
- Mover: `cange card move --card-id <id> --to "<etapa por nome ou id>" [--set "Campo=valor"]`
  (origem = etapa atual do cartão, lida pelo kit; `card move-step-with-values` sem `--payload` faz o mesmo).
- Comentar e mencionar: `cange comment create --card-id <id> --text "<texto>" [--mention <id|e-mail|nome>]...`
  (a menção vai em `mentions`, que gera a notificação, E vira `@[Nome](id)` no texto).
- Cadastro: `cange register create --register-id <id> --set ...` e
  `cange register update --register-id <id> --form-answer-id <entrada> --set ...`.
- Valores inline: `--set "Campo=valor"` (repetível, o primeiro `=` separa) ou `--values-json '{"Campo": valor}'`.
  Com `--payload` junto, o inline vence.
- Chave do campo (todas as escritas, inclusive `--payload`): hash (`name`), id numérico ou TÍTULO do campo
  (sem diferença de maiúscula/acento). Título repetido: vale a etapa atual, depois o formulário inicial; empate é erro
  listando as opções (use o id).
- Valor como na tela: número e moeda em texto ("2500", "2.500,00", "R$ 2.500,00", "2500.5"; "2.500" é ambíguo e dá
  erro), percentual "90%", data "06/10/2026" ou ISO, opção pelo rótulo, checkbox "A, B", interruptor sim/não,
  usuário por id, e-mail ou nome (único na empresa), cadastro por id, lista de ids ou nome da entrada (busca no
  cadastro; 0 ou 2+ resultados = erro com os candidatos).
- `card move`: cada campo é procurado na etapa atual, no destino e no formulário inicial e vai para a chamada certa
  (o back aceita UM formulário por chamada): inicial = `PUT /form/answer` antes; etapa atual = no próprio mover (com os
  campos que o cartão já tem nessa etapa, para nada sumir); destino = `PUT /form/answer` depois. No caso comum é UMA
  chamada. Falha depois de uma escrita = exit `5` com `done` (o que foi gravado).
- `--dry-run` em qualquer escrita imprime o payload RESOLVIDO (chave hash, valor no tipo do campo) e `validation`
  (`{valid}` ou `{valid:false, message}`), sem gravar. Exit `0` válido, `2` inválido.
- `--validate-fields` também cobra os obrigatórios (na criação e na etapa atual, ao mover).
- Erro de validação vem numa mensagem só, curta, com tudo que falta ou está errado:
  `Falta para a etapa Agendamento: Data da ligação (data), Agendamento (Sim | Não)`. Exit `2`, nada gravado.
- Sucesso: uma linha em `summary` (cartão, campos, etapa) e os ids.
- Nunca mova o cartão para a própria etapa para gravar campo: o `PUT /form/answer` cria a resposta da etapa atual
  quando falta. O kit trata sozinho o 409 `STEP_FORM_ANSWER_BUSY` (1 nova tentativa) e o 422 `FIELD_FORM_MISMATCH`
  (refaz com o formulário certo); o 422 `STEP_FORM_NOT_CURRENT` (campo de outra etapa) volta em 1 linha com o
  `cange card move --to "<etapa>"` certo. Cartão excluído: 404 `CARD_DELETED`, mensagem repassada como veio.
- Receitas: `cange recipe criar-card | gravar-campos | mover-card | comentar | mencionar`.

## Sinônimos e ids flexíveis (desde 05/10/2026)

- Busca: `--q` e `--search` são sinônimos em toda listagem com busca (`catalog`, `register entries`, `flow query`,
  `card list`, `my-flows`, `my-registers`; nos dois últimos, `--name` também).
- Ids: `--flow-id`/`--id-flow`/`--flow`, `--register-id`/`--id-register`/`--register` e `--card-id`/`--card`/`--card-ids`
  aceitam o número, o link do Cange (`https://app.cange.me/register/<hash>`, `.../flow/<hash>/card/<id>`,
  `cange://card/<id>`) ou o hash do link (fluxo e cadastro). O kit troca pelo id; o link do cartão também preenche o
  `--flow-id` ausente. Hash sem acesso: erro de uso com o caminho (`cange my-registers` / `cange catalog`).
- `register entries` e `register get` aceitam `--register` (como o `access request`). `card update` aceita
  `--validate-fields` sem efeito (ele não grava `values`; para campos use `card update-values`).
- Comando inexistente responde com a sugestão: `cange search` aponta `register entries --search` e `catalog --q`;
  `register-entries` vira `register entries`. Exit `2` como todo erro de uso.

## Acesso do agente a fluxos e cadastros (desde 02/10/2026, só com token de run)

- `cange catalog [--type flow|register|all] [--q texto] [--limit n]`: NOMES dos fluxos e cadastros que o agente
  pode ver, com `access` "sim"/"não" e o papel (`items` [{id, name, type, access, role}]). No chat e na rotina a
  visão é a de quem conversa (ou do dono da rotina) somada à do agente; numa automação sem conversa, só o que o
  agente já vê. Nunca traz conteúdo. `--full` traz o `raw`; `--raw` devolve a resposta crua.
- `cange access request --flow <id> | --register <id> [--role M] --reason "..."`: cria o PEDIDO de acesso no
  servidor (não dá acesso sozinho e não pausa a execução). A aprovação concede sempre Membro (`--role A` dá erro de
  uso: Administrador só pelo bloco Ferramentas > Cange). Quem pode convidar pessoas para o recurso decide. A
  saída traz `approvalId`, `whoCanApprove` e `message` (a frase pronta para a resposta, ex.: "Pedi acesso ao
  fluxo Compras. Quem pode liberar: Ana, Bruno.").
- Fluxo: não achou no `my-flows` ou tomou 404 de acesso → `cange catalog --q <nome>` → `cange access request`.
  Nunca diga que um fluxo não existe sem olhar o catálogo; nunca grave nomes do catálogo na cabeça.
- Tarefa seguinte (desde 03/10/2026): quando o acesso (ou a mudança na cabeça, `cange agent head propose`) é um
  MEIO para o que pediram numa conversa, passe `--then "<o que falta fazer>"`. O kit manda `then` no corpo; o
  Cange guarda (uma linha, até 1.000 caracteres) só se o run é de conversa e, aprovado o pedido, retoma a conversa
  sozinho uma vez com essa tarefa. A saída traz `continuation`: `combinada` (com `then`, a tarefa guardada),
  `pedido anterior` (o pedido já estava aberto e o `--then` novo não vale) ou `sem conversa` (nada fica guardado).
  Com `combinada`, diga que segue sozinho depois da aprovação; não peça ao usuário para avisar. Na cabeça, sem
  `--then` aprovar só avisa na conversa.

## Sequência recomendada para mutações com values (modo avançado, `--payload`)

1. `cange my-flows`, `cange my-registers`, `cange my-tasks` e `cange notifications --is-archived N`
2. `cange flow get ...` ou `cange register get ...`
3. `cange fields by-flow ...` ou `cange fields by-register ...`
4. `cange template flow-create ...` ou `cange template register-create ...`
5. mutação com `--validate-fields --dry-run`
6. mutação final sem `--dry-run`

## Sugestões operacionais importantes

- Antes de executar tarefa ou mover card:
  - obter o card completo para identificar a etapa atual (`flow_step_id`) e o formulário dela (`flow_step.form_id`).
  - quando precisar de campos específicos do card, usar `card get --field-ids <id1,id2,...> --summary-only`.
  - obter os fields do flow e filtrar pelo `form_id` da etapa atual para identificar campos obrigatórios (`required = "1"`).
  - usar `card move-step-with-values --discover-required` para listar requireds do `form_id` antes de montar o payload final.
  - preencher todos os obrigatórios da etapa atual no `values` do payload de movimentação.
  - o `idForm` do payload deve ser o `form_id` da etapa atual, não o `form_init_id` do fluxo.
  - chamadas sugeridas:
    - `cange --output json my-tasks --flow-id <flowId> --step-id <stepId>`
    - `cange --output json card get --flow-id <flowId> --card-id <cardId> --field-ids <fieldId1,fieldId2> --summary-only`
    - `cange --output json step-form --flow-id <flowId> --step-id <stepId>`
    - `cange --output json fields by-flow --flow-id <flowId>`
    - `cange card move-step-with-values --discover-required --flow-id <flowId> --form-id <formId>`
    - mutação com `card move-step-with-values --validate-fields --dry-run` (se falhar com `UNKNOWN_FIELD_TYPE`, usar só `--dry-run`)
- Ao executar/mover:
  - comentar o que foi feito e por quê.
  - chamadas sugeridas:
    - `cange comment create --payload ./payloads/execution-note.json --dry-run`
    - `cange comment create --payload ./payloads/execution-note.json`
- Ao ler/responder comentário:
  - marcar notificação relacionada como lida/arquivada.
  - chamadas sugeridas:
    - `cange --output json notifications --is-archived N`
    - `cange notification read --payload ./examples/notification-read.example.json --dry-run`
    - `cange notification read --payload ./examples/notification-read.example.json`

## Saída e previsibilidade

- Use `--output json` quando o resultado for consumido por automação.
- **Não precisa de `--silent`**: o stdout já sai limpo (banner do pnpm silenciado no `.npmrc`). Sem `--output`, o modo é json em pipe e pretty em terminal.
- **stdout = só o dado; stderr = logs/avisos/erros.** `... 2>/dev/null | jq .` funciona em qualquer leitura.
- Exit codes por categoria: `0` ok · `2` uso/validação · `3` auth · `4` rede/API · `5` **lote parcial** · `1` inesperado.
- **Exit `5` = a operação em lote saiu INCOMPLETA.** Use só os ids que o resumo devolveu, reprocesse o que está em `failures`/`notAttemptedPayloads` e reporte a tarefa como parcial se não fechar. Nunca deduza id que não foi retornado.

## Criação/leitura em lote (rate limit)

A API limita **por chave**: 10 req/s em leitura, 20 req/s em escrita — e estourar
**bloqueia a chave por ~5 minutos**. Foi o que transformou um lote de 28 cards em
20 sem ninguém perceber (o agente vinculou 8 ids que nunca existiram).

- 2+ cards para criar → `cange card create --payload-dir <dir>` ou `--payloads a.json,b.json`.
  **Nunca** `for f in *.json; do cange card create …; done`.
- 2+ cards para ler → `cange card read --card-ids <a,b,c>`.
- Sempre confira `created`/`failed`/`notAttempted` no retorno antes de montar
  vínculos, contagens ou conclusão.
- O lote **não repete** create que falhou por 5xx/timeout (POST não idempotente,
  sem chave de idempotência no backend): o item vira falha com o aviso de
  **conferir se o card existe** antes de reprocessar. Só 429 é repetido.
- **Rodando dentro do `cange-agent-runner`:** o gate de aprovação deriva o alvo de
  `--payload <arquivo>` e ainda **não** entende `--payload-dir`/`--payloads`. O lote
  é pausado para aprovação normalmente, mas o pedido chega sem o flow derivado e
  rotulado como "Criar **um** card" (mesmo sendo N). Quem aprova precisa ler a
  linha de comando do pedido.

## Discovery antes de adivinhar

- **`pnpm cli manifest --output json`** é a fonte de verdade: todos os comandos, flags (required/tipo), envelope de saída e 1 exemplo por comando — gerado do registry, nunca desatualiza.
- Para um comando: `pnpm cli <comando> --help` já traz o envelope que ele retorna e onde vivem os campos-chave.
- Comando/flag inválido responde com a mensagem + a rota de discovery e exit `2` — leia e corrija, não chute de novo.

## Loop de feedback (quando um agente se perde no kit)

Todo episódio de "agente errou o comando/flag/envelope" deve gerar **duas** saídas:
1. **Correção na ferramenta**: melhorar a mensagem de erro, o `manifest`/`--help` ou o metadado do comando (`annotateCommand`) — a ferramenta deve ensinar o próximo passo.
2. **Registro reutilizável**: anotar o aprendizado onde os agentes leem (memória/playbook), citando o comando.

Sem esse loop, o mesmo buraco reabre a cada evolução do kit.

## Base de conhecimento MCP-style

- Guia principal: `docs/agent-mcp-kb.md`
- Changelog para atualização de playbooks: `docs/agent-changelog.md`
- Playbooks por cenário: `docs/playbooks/`
  - tarefas pendentes
  - notificações
  - resposta por comentários
  - execução + conclusão/movimentação
  - criação de novos cards
