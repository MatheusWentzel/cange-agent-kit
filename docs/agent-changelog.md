# Agent Changelog

Este changelog é focado em quem mantém playbooks/agentes (Codex, Claude Code, etc.).

## 2026-10-07

### Mover igual à tela: rascunho da etapa, obrigatório da tela e check list (E2E do lote, EXTRA-06)

- **P0, perda de dado:** o kit decidia o que o cartão tem pelo `GET /card`, que não traz o rascunho da etapa
  (form_answer com `flow_step_id` NULL: autosave da tela, automações, e o `card update-values` quando o rascunho é a
  resposta mais recente). O `POST /card/v2/move-step` apaga o rascunho, e o que estava só nele sumia; e o mover cobrava
  "Falta" de campo que a tela mostra preenchido (cerca de 9,8 mil cartões ativos no `cange_local`). Agora a fonte é a da
  tela, `GET /form/pre-answer?card_id=&id_form=<form da etapa atual>` (rascunho, ou a última passagem confirmada), e
  tudo isso é reenviado no mover. Back sem a rota (404): `GET /card` como antes; outra falha da rota: não move.
- **Rascunho x resposta confirmada mais nova, por campo e pela LINHA** (revisão F1): vence a linha mais nova do campo
  (`form_answer_field.dt_last_update`, no empate o id da linha; campo de várias linhas: a maior entre elas), não a data
  do form_answer. O autosave da tela regrava as linhas do rascunho sem mudar o form_answer, e o kit gravava a confirmada
  antiga por cima do que a pessoa editou depois (cartão 1107439: 18:00 no lugar do 18:30; 39 cartões ativos e 78 campos
  no `cange_local`). A confirmada só vence quando a linha dela é a mais nova, que é o `card update-values` gravando na
  resposta mais recente.
- **Autocompletar da tela** (revisão F2): campo sem linha na pré-resposta recebe o valor do autocompletar dele, como a
  tela, e esse valor conta no obrigatório e vai no mover. O kit calcula o estático (`ac_type = 1`), a data atual, o
  criador do cartão e o valor de outro campo do cartão (a resposta mais recente que o traz; data em ISO). Acabou o falso
  "Falta" em cerca de 10,8 mil cartões (ex.: Prioridade "Média" no cartão 1120391). Saída nova: `autocompleted` (títulos).
  **Pendência:** o kit NÃO calcula o autocompletar de usuário atual (`-2`), de campo de vínculo (`ac_child_field_id`) e
  com destino lista de opções (a tela casa pelo rótulo). Obrigatório vazio com um desses não bloqueia: volta em `warning`
  (como o da condicional); mande o valor com `--set` no mover. Campo com esse autocompletar MANDADO vazio no mover
  (`--set`/`--values-json`/`values` do payload) é campo limpo e bloqueia, como na tela (o autocompletar só roda ao
  abrir o cartão).
- `card move-step` (deprecado) aceita `--allow-data-loss` (revisão F3): a mensagem de bloqueio do rascunho sugeria a
  flag e o comando a recusava.
- `card move-step-with-values --payload` (e `card move-step`) que grava a etapa atual reenvia o que o cartão tem nela,
  com o `values` por cima (antes bloqueava pedindo para o agente incluir). `--allow-data-loss` desliga o reenvio.
  Payload que grava OUTRO formulário com rascunho só na etapa atual: bloqueia (use `card move` ou `--allow-data-loss`).
- Saída do mover: `kept` e `keptFrom` (`rascunho` | `ultima-passagem` | `vazio` | `cartao`). `vazio`: a pré-resposta
  voltou sem nada (sem rascunho com linha e sem última passagem que o back remonte, como a que só tinha anexo) e a
  tela abre o formulário vazio, só com o autocompletar: o kit também, sem olhar o `GET /card`. `cartao` só quando o
  back não tem a rota.
- Rascunho x resposta confirmada mais nova (a régua da linha mais nova, revisão F1) só vale para campo que o mover
  reenvia. Anexo, fórmula e ID automático de uma confirmada mais nova que o rascunho (ex.: o formulário público da
  etapa) não contam como preenchidos: a tela só lê o rascunho e cobra esses campos, e o mover não os levaria.
- **Obrigatório = o que a tela cobra:** regra `required` do campo (`validations` do `GET /field/by-flow`), não a coluna
  `required`. Switch nunca é cobrado (92 de 92 sem regra), check list sem regra também não (32 de 190), e campo com
  regra e coluna 0 passa a ser cobrado. Sem a lista `validations` (back antigo), vale a coluna. Vale no mover, no
  `card create --validate-fields` e no `--validate-fields` do `card move-step`.
- **Rich text vazio:** a régua exata da tela (`isHtmlEmpty` do Texto Formatado): sem tags e com `&nbsp;` como espaço,
  sobrou só espaço = vazio. Vale para `<p></p>`, `<p><br></p>`, `<p>&nbsp;</p>` e também para HTML só com imagem ou
  tabela sem texto (a tela entrega "" ao formulário nesses casos e o obrigatório recusa).
- **Check list "exigir todos concluídos"** (`formula = '1'`): item sem marcar bloqueia o mover, como a tela. O check list
  e a lista de itens agora são reenviados no mover (antes ficavam vazios no snapshot novo).

### `cards count/sum` e `card list` no V1 com fluxo grande seguem o cursor (EXE-K1, EXE-K3)

- Fluxo V1 com `isLargeData = 'S'`: o `GET /card/by-flow` manda 150 por vez com `cursorKey`. O kit parava na 1ª página
  (`cards count` deu 150 num fluxo de 1815; `card list --engine v1` nunca mostrava o 151º). Agora segue `cursorKey` +
  `offset` até o total (teto de 20 mil), páginas de 500. `truncated` só quando a leitura parou antes do fim (teto ou
  cursor vencido). `card list` pede ao back só o que a página precisa e devolve `next` certo; com `--step-id` (o back
  ignora a etapa no fluxo grande) filtra aqui e segue lendo até completar a página.

## 2026-10-06

### Mover exige os obrigatórios da etapa atual, sempre (decisão 1 do Matheus)

**Regra para playbooks e agentes: mover exige os obrigatórios da etapa atual; peça os valores ao usuário se não
estiverem no pedido.** É a regra base da plataforma (a tela só move depois de validar o formulário da etapa atual).

- **Todo caminho de mover cobra, sempre:** `card move`, `card move-step-with-values` (com e sem `--payload`) e
  `card move-step` (deprecado). Antes o kit só cobrava com `--validate-fields` ou `--dry-run`, e o back
  (`POST /card/v2/move-step`) não cobra: agente que movia com obrigatório vazio passa a receber exit `2`, nada gravado.
- **Caminho certo em 1 passo:** o erro diz quais campos faltam e termina com a regra e o comando pronto, com os `--set`
  que faltam (o `card move` grava os campos da etapa atual dentro do próprio mover):
  `cange card move --card-id 55 --to "Agendamento" --set "Horas=<número>" --set "Qualificado=<Sim | Não>"`.
  Com `--set` já no pedido, a dica pede para repeti-los; no `--payload`, lembra que dá para pôr no `values`.
- O que o cartão já tem na etapa atual conta (o `card move` reenvia). No `--payload`, o mover regrava o formulário da
  etapa atual só com o `values`: obrigatório preenchido no cartão e fora do `values` bloqueia (ficaria vazio), com a
  dica de incluir ou usar `card move`. Payload com `idForm` de outro formulário não toca a etapa atual.
- No `--payload`, a etapa cobrada é a REAL do cartão (o kit lê o cartão); `fromStepId` diferente dela é erro.
- Obrigatórios da etapa de DESTINO não são cobrados ao entrar (a tela também não pede): valem quando o cartão sair.
- Exceção, igual à tela: voltar etapa num fluxo com "pular obrigatórios ao voltar" (`skipRequiredOnBackwardMove`).
- `--validate-fields` segue aceito: no `card move` não muda nada; no `--payload`, continua recusando chave
  desconhecida e cobrando também os obrigatórios do `idForm` quando ele é de outro formulário.
- `CANGE_FORCE_DRY_RUN` (conferência do gate do runner): a mesma cobrança aparece em `validation` (exit `2`), sem gravar.
- O caminho por `--payload` agora lê o fluxo e o cartão também em `--dry-run` (antes podia sair sem ler nada).
- Igual à tela (revisão K-D1): campo oculto no formulário (`show_on_form = "S"`) não é cobrado, em nenhum caminho
  (mover e `card create --validate-fields`). A tela zera o obrigatório dele antes de validar; costuma ser preenchido por
  automação. No `cange_local` eram 68 campos em 49 fluxos que travavam o mover.
- Obrigatório com condicional ("Exibir/Esconder campo") vazio não bloqueia: a tela só o exige quando a condicional
  exibe o campo, e o kit ainda não avalia condicionais. Ele volta em `warning` no resultado (e no `--dry-run`); quando
  outro obrigatório bloqueia, a dica cita os com condicional sem pedir `--set` deles. As condicionais vêm do
  `GET /flow` (`flow_steps[].form.fields[].conditionals`), sem chamada a mais.
- `--payload` com `isTestMode: true` (cartão de modo teste) lê o cartão com `isTestMode` e não falha mais com 404.
- No `--payload`, a dica do `card move` manda repetir como `--set` o que já ia no payload (values e `--set`): o
  `card move` só grava o que vier nele.
- A dica do comando troca para hash/id o campo ou a etapa com `$`, crase, `\` ou aspas no nome, e escapa o
  placeholder: o comando segue seguro para colar no Bash.

### Sem o fluxo, o kit descobre pelo número do cartão (F6, runs 357 e 362)

- Comando de cartão com `--card-id` numérico, sem `--flow-id` e sem `RUNNER_FLOW_ID`/`CANGE_CARD_FLOW_ID` no ambiente,
  chama `GET /card/locate?id_card=N` (back: mesmo acesso da leitura, 404 genérico) e usa o fluxo devolvido. A saída
  ganha `resolved: { flow_id, flow_name, via: "card-locate" }`. É leitura: vale também com `CANGE_FORCE_DRY_RUN`.
- Back sem a rota (404) ou cartão sem acesso: o comando dá o erro de sempre, agora com a dica do link do cartão.
- Fluxo no ambiente, mas `--card-id` diferente de `RUNNER_CARD_ID`/`CANGE_CARD_ID`: o kit consulta o locate em vez de
  presumir o fluxo do run; 404 cai no fluxo do ambiente (como antes). `--flow-id` explícito sempre vence.
- `comment create` lê `RUNNER_FLOW_ID` (antes só `CANGE_CARD_FLOW_ID`), como os outros comandos de cartão.
- `--payload` continua com o `flowId` do arquivo (o kit não consulta o cartão nesse modo).

### Listas e contas: página de 20 vale para todo agente; `truncated` também no V1 (3ª revisão da F2c)

- **`card list` no enxuto devolve 20 cartões por página para QUALQUER agente** (antes da F2c vinham todos). Playbook que
  lia a lista inteira de uma vez precisa seguir o `next` (ou usar `--full`). Agora o V1 também diz que há mais:
  `truncated: true` junto do `next`, igual ao V2. Página do V1 traz `next` com `--engine v1` (o cursor dela é número).
- **`--limit` acima de 500** (ex.: 700) devolve `next` com o cursor que continua de onde parou (antes saía
  `truncated` sem cursor).
- **Cursor do V2 não cai mais no V1:** com `--cursor`, falha do V2 vira erro (antes recomeçava do zero e o agente relia
  em laço). Cursor que não é número no V1 é erro de uso (exit 2).
- **`cards count/sum`:** só caem no `/card/by-flow` em falha do motor (rede, 5xx); 401/403/429/4xx propagam. Fluxo
  grande no V1 sai com `truncated: true`. Valor lido do banco com 3 casas (`1.500`, `12,345`) entra na soma no formato
  do back (1,5 e 12,345), não sai mais como "ambíguo".

### Leitura menor (card #1367459, C4): `cards count/sum`, `card read --fields`, listas paginadas, `map` resumido, TOON

- **Novos:** `cange cards count --flow-id N [--by etapa|campo:"<título>"] [--where "<campo>=<valor>"]` e
  `cange cards sum --flow-id N --field "<título>" [--by ...] [--where ...]` → `{total, groups}` (só ativos, com o acesso
  do token). Substituem listar + python/jq. Também como `card count` / `card sum`; `cards list` = `card list`.
- **`card read --fields "<títulos, ids ou hashes>"`:** só esses campos, inteiros. Sem `--fields`, valor acima de 600
  caracteres sai cortado com a dica (antes: 2.000).
- **Listas (enxuto):** `card list`, `register entries` e `my-flows` em páginas de 20 com total e `next` (comando pronto
  com `--cursor`). `register entries` sem `raw`. `--full` igual a antes.
- **`map` (enxuto):** campos agrupados em `startFields` e `steps[].fields`, sem `formId` por campo, `required` só quando
  obrigatório, opções em linha até 8 (`optionsCount` acima). Playbook que lia `flows[].fields[].formId` passa a ler os
  grupos (ou usa `map --full`).
- **TOON experimental:** `--format toon` / `CANGE_OUTPUT_FORMAT=toon` nas listas. Desligado por padrão.
- Medido nos fixtures grandes do teste (`test/leitura-enxuta-c4.test.ts`): `card read` 13.742 → 6.671 caracteres;
  `map` 7.638 → 6.422 (já com as opções curtas que antes não vinham).

## 2026-09-15

### `register create` volta a funcionar (payload agora leva `registerId`)

**O que acontecia:** `cange register create` devolvia **404 em `POST /form/new-answer`**
("Parâmetros inválidos, não foi possível encontrar a referência do formulário!") para
**qualquer** cadastro, com qualquer chave de API. O contrato montava o body com o id do
cadastro aninhado em `registerContext`, e o backend não lê essa chave: a rota decide por
`register_id`/`flow_id` no nível **raiz** do body e, sem nenhum dos dois, devolve 404 antes
de olhar o `id_form`. Por isso o erro era idêntico para um `id_form` inexistente e para o
form de um fluxo onde o bot escreve todo dia — parecia falta de permissão no cadastro e não
era. O `card create` sempre esteve correto (manda `flow_id` achatado); só a criação de
registro divergia. Pior: o `template register-create` gerava um `payloadSkeleton` **sem** o
id do cadastro, então seguir o template levava direto ao erro.

**O que mudou no kit:**

- `createRegister` manda **`register_id` achatado** na raiz do body.
- `createRegisterPayloadSchema` troca `registerContext` (opcional, ignorado) por
  **`registerId` obrigatório** — payload sem o id do cadastro falha na validação local,
  com mensagem clara, em vez de virar 404 da API.
- `template register-create` passa a incluir `registerId` no `payloadSkeleton`: o skeleton
  é copiável sem retoque.
- `register create` com payload no formato antigo (`registerContext`) morre com instrução de
  migração, não com erro genérico de schema.
- Testes de regressão em `test/register-create.test.ts` + asserção do `createRegister` no
  `test/contracts-mapping.test.ts` (a criação de registro era o único contrato de mutação
  sem cobertura do shape do body — foi assim que o bug passou).

**Migração:** no payload de `register create`, troque

```json
{ "registerContext": { "registerId": 175 } }
```

por

```json
{ "registerId": 175 }
```

no nível raiz. O `--register-id` da CLI continua servindo só para a validação local de fields.

**Nota que vale documentar:** `register update` exige `registerId` **junto** de
`formAnswerId` — só o `formAnswerId` cai no mesmo 404, porque `PUT /form/answer` despacha
pela mesma regra.

## 2026-09-09

### Criação em lote + throttle de rate limit (corrige perda silenciosa de dados)

**O que aconteceu:** o agente Comprador criou 28 cards numa rajada de shell
(`for f in *.json; do cange card create …`), estourou o teto de escrita da API
(20 req/s), a chave foi bloqueada por 5 minutos e 8 creates falharam. Como cada
invocação era independente e o retorno não era conferido, o agente vinculou os 28
ids que **esperava** — 8 nunca existiram — e fechou a tarefa como sucesso
(runs 34/35, company 6728; perda de ~29%, reproduzida 2 de 2 vezes).

**O que mudou no kit:**

- `card create` ganhou modo **LOTE**: `--payload-dir <dir>` ou `--payloads <a.json,b.json>`,
  com `--rps` (default 8/s) e `--max-retries` (default 3).
  - valida TODOS os payloads antes de mutar (payload inválido ⇒ nada é criado, exit 2);
  - throttle abaixo do teto + backoff/retry **só em 429** (5xx/timeout não são
    repetidos: `POST /form/new-answer` não é idempotente e o backend não tem chave de
    idempotência — repetir criaria card duplicado; o item vira falha com o aviso de
    conferir se o card existe antes de reprocessar);
  - **para o lote** ao detectar bloqueio por rate limit (429) — enquanto o bloqueio
    dura (~5 min) toda tentativa falha — e também no 403 do gate de agente
    (`APPROVAL_*`/`PERMISSION_REQUIRED`), que é one-shot por requisição;
  - resumo explícito: `created` / `failed` / `notAttempted` + `cardIds` reais + `warning`
    (200 sem `cardId` conta como FALHA, nunca como criado).
- **Exit code 5 = lote PARCIAL** (parte processada, parte não). Antes, um lote
  incompleto era indistinguível de sucesso. Quando **nada** passa, sai a categoria do
  erro (4/3/2/1), não 5.
- `card read --card-ids` passou a respeitar o teto de GET (10 req/s) — a
  concorrência de 5 sozinha podia disparar ~80 req/s — e devolve
  `{ count, ok, errors, notAttempted?, aborted?, cards }`: exit 5 quando parte falha,
  categoria do erro quando nada é lido, e no 429 o lote PARA (o resto volta como
  `notAttempted` em vez de queimar requisição contra chave bloqueada).
- Erros de API agora carregam `retryAfterSeconds`; o retry interno do cliente
  usa backoff maior em 429 e desiste (em vez de dormir) quando a espera passa de 5s.

**Para playbooks/agentes:** 2+ cards ⇒ sempre lote; conferir `created`/`failed`
antes de montar vínculos ou concluir; nunca deduzir id que não foi devolvido.

## 2026-05-12

### Novos comandos: Flow V2 Build API (`/flow/v2/build`)

Agentes agora podem **construir fluxos completos** (fluxo, etapas, campos, relacionamentos) via CLI. Todos os comandos sob `cange flow-build ...`. Playbook: `docs/playbooks/06-build-flow.md`.

Bodies são **strict** (Zod): qualquer chave extra → `VALIDATION_FAILED`. Rotas com `:id_flow` exigem que o token seja administrador do fluxo (`flow_user.type = 'A'`); 404 com `FLOW_NOT_FOUND` indica falta de permissão.

Read-only:

- `flow-build ping` — health do router.
- `flow-build field-types list` — catálogo de tipos de campo aceitos.
- `flow-build field-types get --type <TIPO>` — descritor (`properties[]`, `valueType`, `enumValues`, etc.).
- `flow-build step-relationship list --id-flow <id>` — todas as etapas com `relationship_steps` e `conditionals`.
- `flow-build step-relationship from --id-flow <id> --id-step <parent>` — vista a partir da etapa pai.

Mutações (todas com `--dry-run` para validação offline):

- `flow-build flow create --payload <path>`
- `flow-build flow update --id-flow <id> --payload <path>`
- `flow-build step create --id-flow <id> --payload <path>`
- `flow-build step update --id-flow <id> --id-step <id> --payload <path>`
- `flow-build step reorder --id-flow <id> --payload <path>` (`{ id_step, upDown: 'up' | 'down' }`)
- `flow-build field create --id-flow <id> (--id-step <id> | --form-id <id>) --payload <path>`
- `flow-build field update --id-flow <id> [--id-step <id> | --form-id <id>] --id-field <id> --payload <path>`
- `flow-build step-relationship set --id-flow <id> --payload <path>` (`{ flow_step_id, step_available_id, isActive: '0'|'1' }`)

Regras especiais para campos:

- Tipos sem resposta (`BUTTON_FIELD`, `TITLE_FIELD`, `DESCRIPTION_FIELD`, `DIVIDER_FIELD`): `required` deve ser `'0'` (não `'N'`); sem validações `type: "required"`.
- `FORMULA_FIELD`: `formula` não pode conter `[` nem `]`; placeholders usam `{nome_do_campo}`.
- `COMBO_BOX_FIELD`, `RADIO_BOX_FIELD`, `CHECK_BOX_FIELD`: `options[]` obrigatório e não vazio.
- `type` é imutável após criação (não enviar em `field update`).
- Tipos rejeitados pelo catálogo da API: `PASSWORD_FIELD`, `COMBO_BOX_REGISTER_FIELD`, `COMBO_BOX_FLOW_FIELD`.

Exemplos em `examples/flow-build-*.example.json`.

## 2026-05-07

### Novos comandos

- `card add-label` (mutação):
  - `cange card add-label --payload <path-to-json> [--dry-run]`
  - vincula uma etiqueta (flow_tag) a um card via `POST /flow-tag/card`
  - payload: `flowId`, `cardId`, `flowTagId` (todos `number`, camelCase como demais mutações)
  - resposta `raw` traz `card_id`, `flow_tag_id` e `id_card_flow_tag` (id da relação criada)

### Mudanças de comportamento

- `--dry-run` agora pula `ensureAuth` em **todos** os comandos de mutação. Permite validar payload offline (sem `CANGE_ACCESS_TOKEN`/`CANGE_EMAIL`+`CANGE_APIKEY`) — útil em CI e geração de payload em pipeline.
- `CangeError.toJSON()` omite campos `undefined` (`status`, `endpoint`, `method`, `code`, `details`). Saída fica enxuta — `name` e `message` em destaque, sem `details: undefined` poluindo o output.

## 2026-05-02

### Novos comandos

- `comment list` (read-only):
  - `cange comment list --flow-id <id> --card-id <id> [--summary-only]`
  - lê comentários de um card via `GET /card-comment/by-card`
  - retorna `raw`, `summaries[]` (id, cardId, userId, userName, description, dtCreated, dtCreatedFormatted, fixed, attachmentsCount) e `total`
  - útil em playbooks para checar se uma dúvida já foi respondida antes de bloquear

- `time-tracking create` (mutação):
  - `cange time-tracking create --payload <path-to-json> [--dry-run]`
  - cria registro de time tracking via `POST /time-tracking`
  - **obrigatório** antes de mover cartões de etapas com `flow_step.isRequiredTrack="1"` (ex: etapa Em execução do `[CNG] Roadmap`, step 486)
  - payload: `flowId`, `cardId`, `flowStepId`, `source` (string, ex: `"manual"`), `dtStart`/`dtEnd` (ISO 8601), `duration` (em **segundos**), `billable` (`"S"`/`"N"`), `title`/`description` opcionais
  - sem o track, `card move-step-with-values` falha com `404 — Nesta etapa é obrigatório rastreamento de tempo`

## 2026-03-17

### Novos comandos e flags

- `my-tasks` agora suporta filtros nativos:
  - `--flow-id <id>`
  - `--step-id <id>`
- Novo comando `step-form`:
  - `cange step-form --flow-id <id> --step-id <id>`
  - retorna contexto da etapa + required/optional com tipos e opções
- `card get` ganhou:
  - `--field-ids <id1,id2,...>` para projeção de fields
  - `--summary-only` para retornar só `summary`
- `card move-step-with-values` ganhou:
  - `--discover-required` para pré-descoberta de obrigatórios por `flowId + formId`

### Melhorias de summary

- `card get` passa a expor:
  - `summary.fieldValues` (map flat por `field_id`)
  - `summary.fields` (alias de compatibilidade)
- Quando `--field-ids` é usado, ids não encontrados retornam `null` no mapa.
- `summaries` de card/task agora expõem aliases em snake_case:
  - `id_card`
  - `flow_id`
  - `step_id`

### Melhorias de validação

- Validação de `RADIO_BOX_FIELD` e `COMBO_BOX_FIELD` agora verifica valores reais de `options` (não só tipo).
- Novos erros de validação:
  - `INVALID_OPTION` com lista de opções válidas.
- Erros de validação passam a incluir `fieldTitle` quando disponível.
- Mensagens de required agora priorizam formato humano:
  - `"Título do Campo" (field_name_hash)`

## Como atualizar playbooks

1. Trocar pós-processamento em Python de `card get` por:
   - `card get --field-ids ... --summary-only`
2. Trocar filtro local de `my-tasks` por:
   - `my-tasks --flow-id ... --step-id ...`
3. Antes de mover etapa:
   - usar `step-form` ou `card move-step-with-values --discover-required`
4. Em validação de seleção:
   - tratar `INVALID_OPTION` como erro de payload e ajustar para os valores reais das opções.
