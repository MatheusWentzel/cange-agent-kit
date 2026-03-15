# Playbook 02: Consultar notificações

## Objetivo

Identificar notificações ativas e extrair contexto acionável.

## Comando

Notificações ativas:

```bash
pnpm cli --output json notifications --is-archived N
```

Notificações arquivadas:

```bash
pnpm cli --output json notifications --is-archived S
```

## Como interpretar

Usar `summaries[]`.

Campos-chave:

- `id`, `type`, `createdAt`
- `description` e `commentText`
- `cardId`, `cardTitle`
- `flowId`, `flowName`
- `stepName`

## Regras práticas

1. Priorizar `type = comment_mention`.
2. Quando existir `cardId` + `flowId`, abrir contexto do card com `card get`.
3. Se não houver contexto mínimo (`cardId` e `flowId`), classificar como `needs-human-review`.

## Saída operacional esperada do agente

```json
{
  "hasActiveNotifications": true,
  "total": 3,
  "actionable": [
    {
      "notificationId": 48367,
      "type": "comment_mention",
      "cardId": 827730,
      "flowId": 19263
    }
  ]
}
```
