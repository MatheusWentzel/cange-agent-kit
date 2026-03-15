# Playbook 03: Responder notificações via comentários

## Objetivo

Responder notificações (especialmente `comment_mention`) publicando comentário no card certo.

## Fluxo recomendado

1. Buscar notificações ativas:

```bash
pnpm cli --output json notifications --is-archived N
```

2. Selecionar uma notificação com `cardId` + `flowId`.
3. Opcional: consultar card para contexto adicional:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
```

4. Montar payload de comentário:

```json
{
  "flowId": 19263,
  "cardId": 827730,
  "description": "Recebido. Vou executar e retorno status em seguida.",
  "mentions": [76]
}
```

5. Dry-run:

```bash
pnpm cli comment create --payload ./payloads/reply-comment.json --dry-run
```

6. Executar:

```bash
pnpm cli comment create --payload ./payloads/reply-comment.json
```

## Regras de resposta

- Manter resposta objetiva e com próximo passo.
- Se `commentAuthorId` existir no summary, usar em `mentions` quando fizer sentido.
- Não assumir informações que não estejam em `notifications` ou `card get`.

## Observação

Este kit não possui rota para arquivar notificação. O playbook cobre resposta operacional via comentário.
