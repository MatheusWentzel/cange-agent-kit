# Agent Changelog

Este changelog é focado em quem mantém playbooks/agentes (Codex, Claude Code, etc.).

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
  - throttle abaixo do teto + backoff/retry em 429/5xx/rede, honrando `Retry-After`;
  - **para o lote** ao detectar bloqueio por rate limit (429) em vez de martelar;
  - resumo explícito: `created` / `failed` / `notAttempted` + `cardIds` reais + `warning`.
- **Exit code 5 = lote PARCIAL** (parte processada, parte não). Antes, um lote
  incompleto era indistinguível de sucesso.
- `card read --card-ids` passou a respeitar o teto de GET (10 req/s) — a
  concorrência de 5 sozinha podia disparar ~80 req/s — e devolve
  `{ count, ok, errors, cards }`, com exit 5 quando algum card falha.
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
