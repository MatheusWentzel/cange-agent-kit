# cange-agent-kit

Toolkit local em Node.js + TypeScript para uso por agentes com a API do Cange, com foco em segurança, previsibilidade, governança e separação entre leitura e mutação.

## Objetivo

Evitar chamadas diretas e repetitivas à API crua do Cange em cada tarefa de agente, centralizando:

- autenticação
- headers padrão
- timeout e retry leve
- normalização de erros
- validação de payloads dinâmicos (`values`)
- UX de CLI previsível para workflows de agente

## Stack

- Node.js
- TypeScript (strict)
- pnpm
- tsup + tsx
- zod
- undici/fetch
- commander
- vitest
- dotenv

## Estrutura

```text
/cange-agent-kit
  /src
    /client
    /contracts
    /schemas
    /cli
    /utils
  /examples
  /docs
  AGENTS.md
  README.md
  .env.example
```

## Setup

1. Instale dependências:

```bash
pnpm install
```

2. Copie o ambiente:

```bash
cp .env.example .env
```

3. Build:

```bash
pnpm build
```

4. Rodar CLI local:

```bash
pnpm dev -- --help
```

## Ambiente (`.env`)

```env
CANGE_API_BASE_URL=https://api.cange.me
CANGE_APP_ORIGIN=https://app.cange.me
CANGE_EMAIL=
CANGE_APIKEY=
CANGE_ACCESS_TOKEN=
CANGE_OUTPUT=pretty
```

Regra de autenticação:

- se `CANGE_ACCESS_TOKEN` existir, ele é usado
- senão, se `CANGE_EMAIL` + `CANGE_APIKEY` existirem, o kit autentica via `POST /session`
- se nada existir, retorna erro amigável

## Como autenticar

```bash
cange auth login
```

## Discovery (obrigatório antes de mutações)

```bash
cange my-flows
cange my-registers
cange flow get --id-flow 192
cange flow get --hash abc123
cange register get --id-register 55
cange register get --hash reg-hash
cange fields by-flow --flow-id 192
cange fields by-register --register-id 55 --with-children true
```

## Inspeção de estrutura e template

```bash
cange template flow-create --flow-id 192
cange template register-create --register-id 55
```

Os templates já retornam:

- contexto (`flowId/registerId` + `formId`)
- required fields
- optional fields
- payload skeleton

## Operações de card

```bash
cange card get --flow-id 192 --card-id 9001
cange card list --flow-id 192 --archived false --with-pre-answer true --with-time-tracking true
cange card create --payload ./examples/create-card.example.json --validate-fields --dry-run
cange card update --payload ./payload.json --dry-run
cange card update-values --payload ./examples/update-card-values.example.json --validate-fields --dry-run
```

Diferença importante:

- `card update` altera atributos principais do cartão (`responsável`, `due date`, `tag`, `complete`, `archived`)
- `card update-values` altera respostas dinâmicas do formulário (`values`)

## Operações de comentário e anexo

```bash
cange comment create --payload ./payload.json --dry-run
cange attachment upload --file ./arquivo.pdf
cange attachment link-card --payload ./payload.json --dry-run
```

## Operações de register

```bash
cange register-form-answer get --form-answer-id 100
cange register create --payload ./examples/create-register.example.json --register-id 55 --validate-fields --dry-run
cange register update --payload ./payload.json --register-id 55 --validate-fields --dry-run
```

## Regras críticas de `values`

- A chave de cada entrada em `values` deve ser exatamente `field.name`.
- Não inventar chaves.
- O valor deve respeitar o `field.type`.
- Campos fora do formulário correto não devem ser enviados.
- Na criação, todos os campos com `required = "1"` devem ser preenchidos.

## Regra de `form_id`

- Card create: usar `flow.form_init_id`.
- Register create/update: usar `register.form_id`.
- Validar sempre com `--validate-fields` quando possível.

## Output e dry-run

- `--output json|pretty`
- `--dry-run` em mutações: mostra payload e não executa chamada de escrita
- código de saída não-zero em falha

## Tratamento de erro

Classes principais:

- `CangeApiError`
- `CangeAuthError`
- `CangeValidationError`
- `CangeCliUsageError`

A normalização inclui:

- status HTTP
- endpoint
- método
- mensagem amigável
- detalhes seguros (sem token/apikey)

## Testes

Arquivos de teste cobrem:

- resolução de configuração
- autenticação
- normalização de erro
- parsing de CLI
- dry-run
- upload/link de attachment com mocks
- discovery (flows/registers)
- builder de template
- validação de obrigatórios e tipo
- mapeamento de contratos para payload HTTP

Rodar:

```bash
pnpm test
```

## Uso por agentes

Veja instruções operacionais em [AGENTS.md](./AGENTS.md) e guias em:

- [docs/cange-agent-usage.md](./docs/cange-agent-usage.md)
- [docs/cange-api-notes.md](./docs/cange-api-notes.md)
- [docs/field-types.md](./docs/field-types.md)

## Projeto preparado para agentes

Este kit foi desenhado para:

- priorizar discovery antes de mutação
- reduzir improvisação em payloads dinâmicos
- expor summaries úteis e resposta raw simultaneamente
- separar contratos read-only e mutações por domínio
- manter UX de comando previsível para automação

## Próximos passos

Evolução planejada para MCP server:

1. Expor contratos como tools MCP (`read` e `mutation` separados por namespace).
2. Adicionar modo `agent-safe` com confirmação explícita para qualquer mutação.
3. Incluir cache local opcional para endpoints de leitura (`my-flows`, `my-registers`, `fields`).
4. Adicionar auditoria estruturada por comando (sem segredos) para rastreabilidade.
5. Criar policy layer para bloquear mutações sem discovery prévio quando configurado.
