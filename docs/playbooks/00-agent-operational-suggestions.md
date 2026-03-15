# Playbook 00: Sugestões operacionais para agentes

## Objetivo

Padronizar decisões de agente em tarefas e notificações para reduzir erro operacional.

## 1) Antes de executar tarefa ou mover cartão, validar campos obrigatórios

Sugestão prática:

1. Descobrir tarefas e card alvo:
   - `pnpm cli --output json my-tasks`
   - `pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>`
2. Descobrir estrutura de fields do flow:
   - `pnpm cli --output json fields by-flow --flow-id <flowId>`
3. Se houver `values` no payload da execução/movimentação:
   - montar payload com `field.name` como chave
   - preencher campos com `required = 1` do `idForm` usado
   - executar validação:
     - `pnpm cli card update-values --payload ./payloads/update-values.json --validate-fields --dry-run`
     - `pnpm cli card move-step-with-values --payload ./payloads/move-step-with-values.json --validate-fields --dry-run`
4. Só executar mutação real após validação passar.

## 2) Ao executar tarefa ou mover cartão, comentar o que foi feito e por quê

Sugestão prática:

1. Montar comentário objetivo com:
   - ação executada
   - motivo/contexto
   - resultado esperado
2. Publicar comentário no card:
   - `pnpm cli comment create --payload ./payloads/execution-note.json --dry-run`
   - `pnpm cli comment create --payload ./payloads/execution-note.json`

Exemplo de mensagem:

`"Atualizei os campos obrigatórios e movi para Revisão para liberar validação financeira."`

## 3) Ao ler/responder comentário, marcar notificação como lida

Sugestão prática:

1. Buscar notificações ativas:
   - `pnpm cli --output json notifications --is-archived N`
2. Responder por comentário quando necessário:
   - `pnpm cli comment create --payload ./payloads/reply-comment.json --dry-run`
   - `pnpm cli comment create --payload ./payloads/reply-comment.json`
3. Marcar notificação como lida/arquivada:
   - `pnpm cli notification read --payload ./examples/notification-read.example.json --dry-run`
   - `pnpm cli notification read --payload ./examples/notification-read.example.json`

Importante: atualizar `notificationId` no payload para a notificação realmente tratada.

## Checklist rápido para agente

- Há contexto suficiente (`flowId`, `cardId`, etapa)?
- Há campos obrigatórios pendentes no `idForm` usado?
- O comentário de evidência foi publicado?
- A notificação relacionada foi marcada como lida?
