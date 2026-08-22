# Agent KB: CLI como MCP

Este guia capacita agentes a usarem a CLI `cange` como se fosse um conjunto de tools MCP.

## Modelo operacional

- Cada comando da CLI é uma chamada de tool.
- `read-only`:
  - consulta estado/contexto
  - não altera dados
- `mutation`:
  - altera dados no Cange
  - sempre executar com validação e dry-run quando aplicável

Comando base recomendado para agentes:

```bash
pnpm cli --output json <comando>
```

> **Fonte de verdade em runtime:** antes de adivinhar de memória, rode
> `pnpm cli manifest --output json`. Ele lista TODOS os comandos, flags (com
> required/tipo), o envelope de saída e um exemplo por comando — gerado do
> registry, sempre atualizado com o kit. Para um comando específico:
> `pnpm cli <comando> --help` já documenta o envelope que ele retorna.
>
> **stdout é só o dado.** O JSON sai limpo em pipe **sem `--silent`** (o banner
> do pnpm foi silenciado via `.npmrc`). Sem `--output`, o modo é **json quando
> a saída é um pipe** e pretty no terminal. Logs/avisos/erros vão para **stderr**.

## Exit codes (categoria do erro)

Estáveis e distintos — roteie retry/correção pelo code, sem parsear a mensagem:

| code | categoria |
|---|---|
| 0 | sucesso |
| 1 | erro inesperado / não categorizado |
| 2 | uso ou validação (comando/flag inválido, payload inválido) |
| 3 | autenticação (credenciais ausentes/inválidas) |
| 4 | rede ou API do Cange |

Comando/flag desconhecido retorna a mensagem + a rota de discovery
(`cange manifest` / `cange <grupo> --help`) e exit `2`.

## Setup resiliente (pnpm)

- Rodar `pnpm install`.
- Se ocorrer `ERR_PNPM_IGNORED_BUILDS`:
  - `pnpm approve-builds`
  - aprovar apenas `esbuild`
  - rodar `pnpm install` novamente
- Nunca apagar `pnpm-lock.yaml` como workaround.

## Convenções de input (crítico)

- `--payload` sempre recebe caminho de arquivo JSON (ex: `--payload ./payloads/comment.json`).
- Não enviar JSON inline em `--payload`.
- Em mutações, chaves de input fora de `values` usam camelCase (`flowId`, `cardId`, `registerId`, `formAnswerId`).
- Exceção: dentro de `values`, a chave deve ser exatamente `field.name` (pode ser hash/string não legível).

## Contrato padrão de saída

Convenção (também exposta em `manifest.envelopeConvention` e no `--help` de cada comando):

- leituras de lista:
  - coleção primária enriquecida para decisão: `summaries` (ou `views`, `fields`)
  - `total`: quantidade
  - `raw`: payload original da API (quando presente; pode ser pesado)
- leitura unitária:
  - `summary` (enriquecido) + `raw`
- query V2 (`flow query`, `card list` no motor V2): `summaries[]` + `engine`, `total`, `totalCount`, `truncated`, `executionStats`
- mutações com `--dry-run`:
  - `dryRun: true`, `executed: false`, `payload`, `note`

> **Regra:** campos legíveis (ex.: `stepName`, `fieldValues`) vivem SEMPRE na
> coleção enriquecida (`summaries`/`summary`), NUNCA em `raw`. Confirme o envelope
> exato de qualquer comando em `pnpm cli <comando> --help`.

## Catálogo de tools (comandos)

### Discovery/contexto (read-only)

- `pnpm cli manifest` — **fonte de verdade**: todos os comandos, flags, envelope e exemplos (gerado do registry)
- `pnpm cli my-flows`
- `pnpm cli my-registers`
- `pnpm cli my-tasks`
- `pnpm cli notifications --is-archived N`
- `pnpm cli flow get --id-flow <id>`
- `pnpm cli register get --id-register <id>`
- `pnpm cli fields by-flow --flow-id <id> [--form-id <id>] [--raw]`
  - Default é digest: `{ summaries[], total }` (era emitido 4× — raw/fields/summaries/summary). `--raw` devolve o envelope antigo completo.
- `pnpm cli fields by-register --register-id <id>`
- `pnpm cli template flow-create --flow-id <id>`
- `pnpm cli template register-create --register-id <id>`
- `pnpm cli template step-move --flow-id <id> --from-step-id <id> --to-step-id <id>`
- `pnpm cli card get --flow-id <id> --card-id <id> [--field-ids <id1,id2>] [--raw] [--raw-full]`
  - Default devolve SÓ `{ summary }` (leve). `--raw` inclui a resposta crua com vínculos compactados (`valueCardFlow` → `{id_card,title}`); `--raw-full` = raw intocado (**pesado**, 8MB+ em card com muitos vínculos — evite). `--summary-only` é legado/no-op (o default já é o summary). Em automação, `--flow-id`/`--card-id` defaultam de `RUNNER_FLOW_ID`/`RUNNER_CARD_ID`.
- `pnpm cli card list --flow-id <id> [--step-id <id>] [--view-id <id>] [--engine auto|v1|v2] [--limit <n>]`
  - Por padrão (`auto`) prioriza o motor **V2** (mais rápido) com fallback V1; retorna `engine`/`totalCount`/`truncated`/`executionStats` além de `summaries`/`total`.
  - `--with-pre-answer/--with-time-tracking/--test-model` só existem no V1 e forçam o caminho legado.
- `pnpm cli flow query --flow-id <id> [--view-id <id>] [--search <txt>] [--step-id <id>] [--engine auto|v1|v2] [--limit <n>]`
  - Busca priorizando V2, aceita **visualização salva** e busca textual (scope `flow` automático sem view).
- `pnpm cli flow views list --flow-id <id> [--include-schema]`
  - Lista as **visualizações (views salvas)** do flow com resumo de filtros/colunas/ordenação (usar `.views`; `raw` é pesado).
- `pnpm cli comment list --flow-id <id> --card-id <id> [--full]`
  - Default é digest: `{ summaries[], total }` com `description` capada em 800 chars (marcador ensina o caminho de volta). `--full` devolve `{raw, summaries[], total}` com o teor COMPLETO (pesado — comentários com transcrição chegam a 100KB+). `--summary-only` é legado (o digest já é o default). `--flow-id` defaulta de `CANGE_CARD_FLOW_ID`.
- `pnpm cli my-registers [--name <search>]`

### Mutações

- `pnpm cli card create --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli card update --payload <path-to-json> [--dry-run]`
- `pnpm cli card update-values --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli card move-step --payload <path-to-json> [--dry-run]`
- `pnpm cli card move-step-with-values --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli comment create --payload <path-to-json> [--dry-run]`
- `pnpm cli notification read --payload <path-to-json> [--dry-run]`
- `pnpm cli time-tracking create --payload <path-to-json> [--dry-run]`
- `pnpm cli attachment upload --file <path>`
- `pnpm cli attachment link-card --payload <path-to-json> [--dry-run]`
- `pnpm cli register create --payload <path-to-json> [--validate-fields] [--register-id <id>] [--dry-run]`
- `pnpm cli register update --payload <path-to-json> [--validate-fields] [--register-id <id>] [--dry-run]`

### Construção de fluxos (Flow V2 Build API — `/flow/v2/build`)

Pré-requisito: para qualquer comando com `--id-flow`, o token precisa ser administrador do fluxo (`flow_user.type = 'A'`). 404 com `FLOW_NOT_FOUND` indica falta de permissão. Bodies são **strict**: chaves extras causam `VALIDATION_FAILED`.

Read-only:

- `pnpm cli flow-build ping`
- `pnpm cli flow-build field-types list`
- `pnpm cli flow-build field-types get --type <TIPO>`
- `pnpm cli flow-build step-relationship list --id-flow <id>`
- `pnpm cli flow-build step-relationship from --id-flow <id> --id-step <parent>`

Mutações:

- `pnpm cli flow-build flow create --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build flow update --id-flow <id> --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build step create --id-flow <id> --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build step update --id-flow <id> --id-step <id> --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build step reorder --id-flow <id> --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build field create --id-flow <id> (--id-step <id> | --form-id <id>) --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build field update --id-flow <id> [--id-step <id> | --form-id <id>] --id-field <id> --payload <path-to-json> [--dry-run]`
- `pnpm cli flow-build step-relationship set --id-flow <id> --payload <path-to-json> [--dry-run]`

Ordem recomendada de construção:

1. `flow create` → guardar `id_flow` e `form_init_id`.
2. (opcional) `flow update` para nome/cor/privacidade.
3. `step create` por etapa → guardar `id_step` e `form_id` da etapa.
4. (opcional) `step reorder` para ajustar índices.
5. `step-relationship set` por aresta (`isActive: '1'` permite; `'0'` bloqueia).
6. `field create` em cada `form_init_id` ou em cada `step` (use somente um entre `--form-id` e `--id-step`).
7. Verificar com `step-relationship list --id-flow <id>`.

Regras especiais:

- Tipos sem resposta (`BUTTON_FIELD`, `TITLE_FIELD`, `DESCRIPTION_FIELD`, `DIVIDER_FIELD`): `required` deve ser `'0'` (não `'N'`) e sem `validations` `type: "required"`.
- `FORMULA_FIELD`: `formula` não pode conter `[` nem `]`; placeholders usam `{nome_do_campo}`.
- `COMBO_BOX_FIELD`, `RADIO_BOX_FIELD`, `CHECK_BOX_FIELD`: `options[]` obrigatório e não vazio (`{ value, label, hide?, order?, id_field_option? }`).
- Tipos fora do catálogo (rejeitados): `PASSWORD_FIELD`, `COMBO_BOX_REGISTER_FIELD`, `COMBO_BOX_FLOW_FIELD`.

## Payloads de mutação (exemplos em camelCase)

Exemplos prontos no repositório:

- `examples/create-card.example.json`
- `examples/update-card.example.json`
- `examples/update-card-values.example.json`
- `examples/move-card-step.example.json`
- `examples/move-card-step-with-values.example.json`
- `examples/comment-create.example.json`
- `examples/notification-read.example.json`
- `examples/create-register.example.json`
- `examples/flow-build-create-flow.example.json`
- `examples/flow-build-update-flow.example.json`
- `examples/flow-build-create-step.example.json`
- `examples/flow-build-update-step.example.json`
- `examples/flow-build-reorder-step.example.json`
- `examples/flow-build-create-field-text.example.json`
- `examples/flow-build-create-field-combo.example.json`
- `examples/flow-build-create-field-formula.example.json`
- `examples/flow-build-create-field-title.example.json`
- `examples/flow-build-update-field.example.json`
- `examples/flow-build-step-relationship.example.json`

`comment create`:

```json
{
  "flowId": 19263,
  "cardId": 827730,
  "description": "Recebido. Vou executar e retorno em seguida.",
  "mentions": [76]
}
```

`card create`:

```json
{
  "idForm": 133863,
  "flowId": 19263,
  "origin": "/cange-agent-kit",
  "values": {
    "922df39637824f9830d705afcf7f632ac2295938": "Novo card via agente"
  }
}
```

`card update`:

```json
{
  "flowId": 19263,
  "cardId": 827730,
  "complete": "S"
}
```

`card move-step-with-values`:

```json
{
  "flowId": 14531,
  "cardId": 479486,
  "fromStepId": 81690,
  "toStepId": 81691,
  "idForm": 102905,
  "values": {
    "3ea5e3e99267205d33776ac435467527dc4fa681": "Tesdoiasjio0219381290"
  },
  "complete": "S",
  "isFromCurrentStep": true,
  "isTestMode": false
}
```

`notification read`:

```json
{
  "notificationId": 48107,
  "archived": "S"
}
```

Compatibilidade: também aceita `id_notification`.

## Estruturas de objeto (summaries)

### Task summary (`my-tasks`)

```ts
{
  cardId?: number | string;
  title?: string;
  flowId?: number | string;
  flowName?: string;
  flowHash?: string;
  companyId?: number | string;
  currentStepId?: number | string;
  stepName?: string;
  dueDate?: string;          // ISO
  createdAt?: string;        // ISO
  responsibleUserId?: number | string;
  responsibleName?: string;
  statusDue?: number | string;
  archived?: boolean;
  complete?: boolean;
}
```

### Notification summary (`notifications`)

```ts
{
  id?: number | string;
  title?: string;
  description?: string;      // foco em comentário
  type?: string;             // ex: comment_mention
  link?: string;
  cardId?: number | string;
  cardTitle?: string;
  flowId?: number | string;
  flowName?: string;
  currentStepId?: number | string;
  stepName?: string;
  responsibleUserId?: number | string;
  responsibleName?: string;
  commentId?: number | string;
  commentText?: string;
  commentAuthorId?: number | string;
  commentAuthorName?: string;
  archived?: boolean;
  read?: boolean;
  createdAt?: string;        // ISO
}
```

### Field summary (`fields by-flow` / `fields by-register`)

```ts
{
  id?: number | string;
  name: string;              // chave obrigatória em values
  title?: string;
  description?: string;      // contexto para agente
  type: string;
  required: boolean;
  formId?: number | string;
}
```

## Regras críticas para `values`

- Chave de `values` deve ser sempre `field.name`.
- Nunca inventar chaves.
- Sempre respeitar `field.type`.
- Para criação:
  - preencher todos os campos obrigatórios
  - usar formulário correto:
    - card: `flow.form_init_id`
    - register: `register.form_id`

## Protocolo de segurança para mutação

1. Descobrir contexto e estrutura.
2. Montar payload.
3. Rodar `--validate-fields` quando disponível.
4. Rodar `--dry-run`.
5. Executar mutação real.
6. Verificar estado final com comando de leitura.

## Sugestões operacionais (tarefas, movimentos e comentários)

### Antes de executar tarefa ou mover cartão

- Verificar contexto: `my-tasks` + `card get`.
- Verificar estrutura: `fields by-flow` (e `idForm` alvo).
- Em movimentação com `values`, usar `idForm = flow_step.form_id` da etapa atual.
- `flow.form_init_id` é apenas para criação (`card create`), não para mover etapa.
- Se houver `values`, preencher obrigatórios (`required = 1`) do formulário alvo.
- Validar antes de mutar:
  - `card update-values --validate-fields --dry-run`
  - `card move-step-with-values --validate-fields --dry-run`
  - se falhar com `UNKNOWN_FIELD_TYPE`, repetir com `--dry-run` sem `--validate-fields`

### Após executar ou mover cartão

- Registrar comentário objetivo com o que foi feito e o porquê:
  - `comment create --payload <path-to-json> --dry-run`
  - `comment create --payload <path-to-json>`

### Ao ler/responder comentário

- Após tratar a notificação, marcar como lida/arquivada:
  - `notification read --payload <path-to-json> --dry-run`
  - `notification read --payload <path-to-json>`

Referência rápida: [Playbook 00](./playbooks/00-agent-operational-suggestions.md).

## Limites conhecidos

- O comando `card move-step`/`card move-step-with-values` depende de `fromStepId` e `toStepId` corretos.
- Se o fluxo tiver regras adicionais fora do endpoint, a movimentação pode exigir intervenção no app.
- **`card list --engine v1` em fluxos grandes (`largeData`) retorna 0 cartões** — o `/card/by-flow` devolve só `ids` (sem `cards`). Por isso o default `auto` prioriza o V2. Só force `--engine v1` quando precisar dos enriquecimentos V1 (`--with-*`) e o fluxo não for grande.

## Playbooks

- [00 - Sugestões operacionais para agentes](./playbooks/00-agent-operational-suggestions.md)
- [01 - Consultar tarefas pendentes](./playbooks/01-pending-tasks.md)
- [02 - Consultar notificações](./playbooks/02-notifications.md)
- [03 - Responder notificações via comentários](./playbooks/03-reply-notifications.md)
- [04 - Executar tarefa e concluir/mover cartão](./playbooks/04-execute-and-move-card.md)
- [05 - Criar novo cartão](./playbooks/05-create-card.md)
