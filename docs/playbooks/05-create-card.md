# Playbook 05: Criar novos cartões

## Objetivo

Criar card com segurança, sem inventar `values`, usando estrutura real do flow.

Convenção importante:

- `--payload` é caminho para arquivo JSON.
- No payload de criação, usar camelCase para chaves fixas (`idForm`, `flowId`, `origin`).
- Em `values`, a chave continua sendo `field.name`.

## Fluxo obrigatório

1. Descobrir flow:

```bash
pnpm cli --output json my-flows
pnpm cli --output json flow get --id-flow <flowId>
```

2. Descobrir formulário inicial e fields corretos:

```bash
pnpm cli --output json template flow-create --flow-id <flowId>
```

3. Montar payload com base no template:

- usar `idForm = flow.form_init_id`
- usar somente campos do `formId` alvo
- chave de `values` = `field.name`
- preencher todos os `required`

Exemplo:

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

4. Validar e simular:

```bash
pnpm cli card create --payload ./payloads/create-card.json --validate-fields --dry-run
```

5. Executar:

```bash
pnpm cli card create --payload ./payloads/create-card.json --validate-fields
```

6. Verificar:

- usar `summary.cardId` do retorno
- consultar:

```bash
pnpm cli --output json card get --flow-id <flowId> --card-id <newCardId>
```

## Vários cards de uma vez (LOTE) — obrigatório a partir de 2

Um arquivo `.json` por card num diretório e **um** comando:

```bash
pnpm cli card create --payload-dir ./payloads/itens --validate-fields
```

Ou uma lista explícita: `--payloads ./p/a.json,./p/b.json`.

O que o lote faz por você:

- valida **todos** os payloads antes de mutar (payload quebrado não deixa o lote pela metade);
- 1 autenticação e 1 processo para N cards;
- **throttle** abaixo do teto de escrita (`--rps`, default 8/s; teto do backend: 20/s);
- **retry com backoff** em 429/5xx/rede (`--max-retries`, default 3);
- **PARA** o lote se a chave for bloqueada (429) — martelar só estende os 5 minutos de bloqueio;
- devolve o resumo com os ids **reais**.

Saída (exemplo de lote incompleto):

```json
{
  "requested": 28,
  "created": 20,
  "failed": 1,
  "notAttempted": 7,
  "cardIds": [1281634, 1281635],
  "failures": [{ "payload": "itens/item-21.json", "attempts": 4, "error": "…", "status": 429 }],
  "notAttemptedPayloads": ["itens/item-22.json"],
  "aborted": { "reason": "RATE_LIMIT_BLOCK", "retryAfterSeconds": 300 },
  "warning": "ATENÇÃO: 8 de 28 cards NÃO foram criados. …"
}
```

**Exit code:** `0` só quando tudo passou; **`5` quando o lote saiu incompleto**;
`2` quando algum payload é inválido (nesse caso nada foi criado).

Depois de um lote incompleto:

1. use SOMENTE os ids de `cardIds` (não existe id "provável" — a falha acontece no
   meio da rajada, então os ids que faltam **não** são uma continuação da sequência);
2. espere o bloqueio passar (`aborted.retryAfterSeconds`) e rode de novo apenas os
   payloads de `failures`/`notAttemptedPayloads`;
3. se não der para fechar, reporte a tarefa como **parcial** — nunca como concluída.

## Anti-padrões proibidos

- inventar chaves em `values`
- enviar campos de outro `form_id`
- criar card sem passar por template/discovery
- **criar cards em rajada num loop de shell** (`for f in *.json; do cange card create …`):
  estoura o rate limit, bloqueia a chave por 5 min e os creates seguintes falham em silêncio
- **assumir que o card foi criado sem ler o retorno** (foi assim que 8 ids inexistentes
  entraram num vínculo e a tarefa foi fechada como sucesso)
