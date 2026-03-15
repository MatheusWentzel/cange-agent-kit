# Playbook 01: Consultar tarefas pendentes

## Objetivo

Descobrir quais cards estão pendentes para o usuário autenticado e priorizar execução.

## Comandos

```bash
pnpm cli --output json my-tasks
```

Opcional para enriquecer contexto do card:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <cardId>
```

## Como interpretar

Usar `summaries[]` do `my-tasks`.

Campos-chave:

- `cardId`, `flowId`
- `title`
- `stepName`, `currentStepId`
- `dueDate`, `statusDue`
- `responsibleUserId`, `responsibleName`

## Estratégia de priorização recomendada

1. `statusDue` vencido/urgente primeiro.
2. `dueDate` mais próximo.
3. cards sem `complete`.

## Saída operacional esperada do agente

Lista ordenada de trabalho, por exemplo:

```json
[
  {
    "priority": 1,
    "cardId": 827730,
    "flowId": 19263,
    "title": "Crie uma frase legal...",
    "stepName": "A Fazer",
    "reason": "statusDue=4"
  }
]
```
