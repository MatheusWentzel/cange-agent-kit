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

## Convenções de input (crítico)

- `--payload` sempre recebe caminho de arquivo JSON (ex: `--payload ./payloads/comment.json`).
- Não enviar JSON inline em `--payload`.
- Em mutações, chaves de input fora de `values` usam camelCase (`flowId`, `cardId`, `registerId`, `formAnswerId`).
- Exceção: dentro de `values`, a chave deve ser exatamente `field.name` (pode ser hash/string não legível).

## Contrato padrão de saída

A maioria dos comandos retorna envelope previsível:

- leituras de lista:
  - `raw`: payload original da API
  - `summaries`: versão normalizada para decisão
  - `total`: quantidade
- leitura unitária:
  - `raw`
  - `summary`
- mutações com `--dry-run`:
  - `dryRun: true`
  - `executed: false`
  - `payload`
  - `note`

## Catálogo de tools (comandos)

### Discovery/contexto (read-only)

- `pnpm cli my-flows`
- `pnpm cli my-registers`
- `pnpm cli my-tasks`
- `pnpm cli notifications --is-archived N`
- `pnpm cli flow get --id-flow <id>`
- `pnpm cli register get --id-register <id>`
- `pnpm cli fields by-flow --flow-id <id>`
- `pnpm cli fields by-register --register-id <id>`
- `pnpm cli template flow-create --flow-id <id>`
- `pnpm cli template register-create --register-id <id>`
- `pnpm cli card get --flow-id <id> --card-id <id>`
- `pnpm cli card list --flow-id <id>`

### Mutações

- `pnpm cli card create --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli card update --payload <path-to-json> [--dry-run]`
- `pnpm cli card update-values --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli card move-step --payload <path-to-json> [--dry-run]`
- `pnpm cli card move-step-with-values --payload <path-to-json> [--validate-fields] [--dry-run]`
- `pnpm cli comment create --payload <path-to-json> [--dry-run]`
- `pnpm cli notification read --payload <path-to-json> [--dry-run]`
- `pnpm cli attachment upload --file <path>`
- `pnpm cli attachment link-card --payload <path-to-json> [--dry-run]`
- `pnpm cli register create --payload <path-to-json> [--validate-fields] [--register-id <id>] [--dry-run]`
- `pnpm cli register update --payload <path-to-json> [--validate-fields] [--register-id <id>] [--dry-run]`

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
- Se houver `values`, preencher obrigatórios (`required = 1`) do formulário alvo.
- Validar antes de mutar:
  - `card update-values --validate-fields --dry-run`
  - `card move-step-with-values --validate-fields --dry-run`

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

## Playbooks

- [00 - Sugestões operacionais para agentes](./playbooks/00-agent-operational-suggestions.md)
- [01 - Consultar tarefas pendentes](./playbooks/01-pending-tasks.md)
- [02 - Consultar notificações](./playbooks/02-notifications.md)
- [03 - Responder notificações via comentários](./playbooks/03-reply-notifications.md)
- [04 - Executar tarefa e concluir/mover cartão](./playbooks/04-execute-and-move-card.md)
- [05 - Criar novo cartão](./playbooks/05-create-card.md)
