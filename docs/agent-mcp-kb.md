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

- `pnpm cli card create --payload <json> [--validate-fields] [--dry-run]`
- `pnpm cli card update --payload <json> [--dry-run]`
- `pnpm cli card update-values --payload <json> [--validate-fields] [--dry-run]`
- `pnpm cli comment create --payload <json> [--dry-run]`
- `pnpm cli attachment upload --file <path>`
- `pnpm cli attachment link-card --payload <json> [--dry-run]`
- `pnpm cli register create --payload <json> [--validate-fields] [--register-id <id>] [--dry-run]`
- `pnpm cli register update --payload <json> [--validate-fields] [--register-id <id>] [--dry-run]`

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

## Limites conhecidos

- Não há comando dedicado para mover explicitamente `flow_step_id`.
- Estratégia suportada:
  - executar o trabalho (values/comentários/anexos)
  - concluir cartão com `card update` (`complete: "S"`) quando o fluxo usar isso como transição
  - verificar no `card get`/`my-tasks`
  - se o fluxo exigir movimentação manual de etapa, escalonar para operador humano

## Playbooks

- [01 - Consultar tarefas pendentes](./playbooks/01-pending-tasks.md)
- [02 - Consultar notificações](./playbooks/02-notifications.md)
- [03 - Responder notificações via comentários](./playbooks/03-reply-notifications.md)
- [04 - Executar tarefa e concluir/mover cartão](./playbooks/04-execute-and-move-card.md)
- [05 - Criar novo cartão](./playbooks/05-create-card.md)
