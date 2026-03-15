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

0. Entre na pasta do projeto:

```bash
cd cange-agent-kit
```

1. Instale dependências:

```bash
pnpm install
```

2. Copie o ambiente:

```bash
cp .env.example .env
```

3. Gere o build da CLI:

```bash
pnpm build
```

4. Rode a CLI local (modo estável, recomendado):

```bash
pnpm cli --help
```

5. Opcional: rodar sem build (modo dev):

```bash
pnpm dev --help
```

Se aparecer erro `EPERM ... tsx ... pipe` no modo dev, use o modo estável (`pnpm build` + `pnpm cli ...`).

6. Opcional: expor comando global `cange` no seu shell:

```bash
pnpm link --global
cange --help
```

Sem link global, use sempre `pnpm cli <comando>`.

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
pnpm cli auth login
```

## Discovery (obrigatório antes de mutações)

Os comandos abaixo exigem autenticação válida no `.env` (`CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` + `CANGE_APIKEY`).

```bash
pnpm cli my-flows
pnpm cli my-registers
pnpm cli my-tasks
pnpm cli notifications --is-archived N
pnpm cli flow get --id-flow 192
pnpm cli flow get --hash abc123
pnpm cli register get --id-register 55
pnpm cli register get --hash reg-hash
pnpm cli fields by-flow --flow-id 192
pnpm cli fields by-register --register-id 55 --with-children true
```

## Inspeção de estrutura e template

```bash
pnpm cli template flow-create --flow-id 192
pnpm cli template register-create --register-id 55
```

Os templates já retornam:

- contexto (`flowId/registerId` + `formId`)
- required fields
- optional fields
- payload skeleton

## Operações de card

```bash
pnpm cli card get --flow-id 192 --card-id 9001
pnpm cli card list --flow-id 192 --archived false --with-pre-answer true --with-time-tracking true
pnpm cli card create --payload ./examples/create-card.example.json --validate-fields --dry-run
pnpm cli card update --payload ./payload.json --dry-run
pnpm cli card update-values --payload ./examples/update-card-values.example.json --validate-fields --dry-run
```

Diferença importante:

- `card update` altera atributos principais do cartão (`responsável`, `due date`, `tag`, `complete`, `archived`)
- `card update-values` altera respostas dinâmicas do formulário (`values`)

## Operações de comentário e anexo

```bash
pnpm cli comment create --payload ./payload.json --dry-run
pnpm cli attachment upload --file ./arquivo.pdf
pnpm cli attachment link-card --payload ./payload.json --dry-run
```

## Operações de register

```bash
pnpm cli register-form-answer get --form-answer-id 100
pnpm cli register create --payload ./examples/create-register.example.json --register-id 55 --validate-fields --dry-run
pnpm cli register update --payload ./payload.json --register-id 55 --validate-fields --dry-run
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
- [docs/agent-mcp-kb.md](./docs/agent-mcp-kb.md)
- [docs/playbooks/README.md](./docs/playbooks/README.md)

## Uso com Codex e Claude Code

Esta seção é o caminho rápido para usar o `cange-agent-kit` com agentes como Codex ou Claude Code.

### 1. Instalação do projeto (igual para ambos)

```bash
cd cange-agent-kit
pnpm install
cp .env.example .env
pnpm build
```

Depois disso, teste:

```bash
pnpm cli --help
```

### 2. Skills/base de conhecimento do repositório

Trate estes arquivos como “skills” operacionais do agente:

- skill principal: [docs/agent-mcp-kb.md](./docs/agent-mcp-kb.md)
- skill de tarefas pendentes: [docs/playbooks/01-pending-tasks.md](./docs/playbooks/01-pending-tasks.md)
- skill de notificações: [docs/playbooks/02-notifications.md](./docs/playbooks/02-notifications.md)
- skill de resposta por comentários: [docs/playbooks/03-reply-notifications.md](./docs/playbooks/03-reply-notifications.md)
- skill de execução/movimentação de card: [docs/playbooks/04-execute-and-move-card.md](./docs/playbooks/04-execute-and-move-card.md)
- skill de criação de card: [docs/playbooks/05-create-card.md](./docs/playbooks/05-create-card.md)

### 3. Codex (OpenAI)

O Codex lê [AGENTS.md](./AGENTS.md). Para bootstrap rápido, use algo como:

```text
Leia AGENTS.md, docs/agent-mcp-kb.md e docs/playbooks/README.md antes de agir.
Use a CLI cange-agent-kit como tool principal, sempre com `pnpm cli --output json`.
Para mutações, siga discovery -> validate-fields -> dry-run -> execução.
Nunca invente field.name, IDs ou payload values fora do form_id correto.
```

### 4. Claude Code

O Claude Code pode usar o arquivo [CLAUDE.md](./CLAUDE.md) deste repositório.

Prompt de bootstrap recomendado:

```text
Leia CLAUDE.md, docs/agent-mcp-kb.md e docs/playbooks/README.md.
Use somente comandos `pnpm cli ...` para operar o Cange.
Priorize os summaries e use o raw apenas para auditoria.
Em mutações, rode dry-run antes da execução real.
```

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
3. Incluir cache local opcional para endpoints de leitura (`my-flows`, `my-registers`, `my-tasks`, `notifications`, `fields`).
4. Adicionar auditoria estruturada por comando (sem segredos) para rastreabilidade.
5. Criar policy layer para bloquear mutações sem discovery prévio quando configurado.
