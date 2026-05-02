# Agent Changelog

Este changelog é focado em quem mantém playbooks/agentes (Codex, Claude Code, etc.).

## 2026-05-02

### Novos comandos

- `comment list` (read-only):
  - `cange comment list --flow-id <id> --card-id <id> [--summary-only]`
  - lê comentários de um card via `GET /card-comment/by-card`
  - retorna `raw`, `summaries[]` (id, cardId, userId, userName, description, dtCreated, dtCreatedFormatted, fixed, attachmentsCount) e `total`
  - útil em playbooks para checar se uma dúvida já foi respondida antes de bloquear

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
