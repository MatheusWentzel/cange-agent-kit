# Tipos de campo suportados

Fonte de referência: tipologias públicas do Cange ("Tipos de campos"), com mapeamento operacional para validação de `values`.

## Mapeamento

- texto curto: `string`
- texto longo: `string`
- caixa de seleção: `string`
- data: `string` ISO
- seleção única: `string`
- seleção múltipla: `string[]`
- responsável: `number | string`
- meus cadastros: `number[]`
- meus fluxos: `number[]`
- moeda: `number`
- vencimento: `string` ISO
- e-mail: `string`
- telefone: `string`
- interruptor: `boolean`
- lista de itens: `object`
- numérico: `number`
- documentos: `string`
- texto formatado: `string` (HTML)
- link: `string`

## Observações de implementação

- A validação usa `field.type` com aliases comuns (ex.: `TEXT_SHORT_FIELD`, `DATE_PICKER_FIELD`, `COMBO_BOX_USER_FIELD`).
- Quando o tipo não está mapeado, o validador retorna `UNKNOWN_FIELD_TYPE` para evitar mutação insegura.
- A chave em `values` sempre deve ser o `field.name`.
