# Agent Changelog

Este changelog é focado em quem mantém playbooks/agentes (Codex, Claude Code, etc.).

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
