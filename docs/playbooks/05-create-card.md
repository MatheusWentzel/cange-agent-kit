# Playbook 05: Criar novos cartões

## Objetivo

Criar card com segurança, sem inventar `values`, usando estrutura real do flow.

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

## Anti-padrões proibidos

- inventar chaves em `values`
- enviar campos de outro `form_id`
- criar card sem passar por template/discovery
