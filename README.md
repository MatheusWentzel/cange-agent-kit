# cange-agent-kit

Toolkit local em Node.js + TypeScript para uso por agentes com a API do Cange, com foco em segurança, previsibilidade, governança e separação entre leitura e mutação.

## Início Rápido Para Agentes (Do Zero)

Use este prompt quando o agente ainda não está no projeto e precisa chegar até um ambiente 100% pronto.
Premissa: a pessoa já está na pasta raiz onde quer instalar o `cange-agent-kit`.

Prompt recomendado (Codex ou Claude Code, copiar/colar):

```text
Quero que você prepare o cange-agent-kit do zero para uso imediato.

1) Se a pasta cange-agent-kit ainda não existir aqui, clone o repositório público:
   git clone https://github.com/MatheusWentzel/cange-agent-kit.git

2) Entre no projeto:
   cd cange-agent-kit

3) Leia os guias operacionais:
   - AGENTS.md
   - CLAUDE.md (se estiver usando Claude Code)
   - docs/agent-mcp-kb.md
   - docs/agent-changelog.md
   - docs/playbooks/README.md

4) Instale e configure:
   - pnpm install
   - se .env não existir: cp .env.example .env
   - valide se .env contém:
     CANGE_API_BASE_URL, CANGE_APP_ORIGIN e autenticação por CANGE_ACCESS_TOKEN
     ou por CANGE_EMAIL + CANGE_APIKEY, se não existir, me pergunte que vou lhe passar para criar o env.

5) Valide o projeto:
   - pnpm lint:types
   - pnpm build
   - pnpm test

6) Faça smoke test da CLI:
   - pnpm cli --help
   - pnpm cli auth login
   - pnpm --silent cli --output json my-flows
   - pnpm --silent cli --output json my-registers
   - pnpm --silent cli --output json my-tasks
   - pnpm --silent cli --output json notifications --is-archived N

7) Entregue um relatório final com:
   - status de cada etapa (ok/falhou)
   - comandos executados
   - erros encontrados
   - ações para corrigir pendências

Regras obrigatórias:
- Nunca expor token/apikey em logs.
- Nunca inventar IDs nem chaves de values.
- Em mutações com values: discovery -> --validate-fields -> --dry-run -> execução real.
```

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

1. Entre na pasta do projeto:

```bash
cd cange-agent-kit
```

1. Instale dependências:

```bash
pnpm install
```

1. Copie o ambiente:

```bash
cp .env.example .env
```

1. Gere o build da CLI:

```bash
pnpm build
```

1. Rode a CLI local (modo estável, recomendado):

```bash
pnpm cli --help
```

1. Opcional: rodar sem build (modo dev):

```bash
pnpm dev --help
```

Se aparecer erro `EPERM ... tsx ... pipe` no modo dev, use o modo estável (`pnpm build` + `pnpm cli ...`).

1. Opcional: expor comando global `cange` no seu shell:

```bash
pnpm link --global
cange --help
```

Sem link global, use sempre `pnpm cli <comando>`.

Para automação e pipes JSON, prefira:

```bash
pnpm --silent cli --output json <comando>
```

Ou use o atalho:

```bash
pnpm cli:silent --output json <comando>
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
pnpm cli auth login
```

## Discovery (obrigatório antes de mutações)

Os comandos abaixo exigem autenticação válida no `.env` (`CANGE_ACCESS_TOKEN` ou `CANGE_EMAIL` + `CANGE_APIKEY`).

```bash
pnpm cli my-flows
pnpm cli my-registers
pnpm cli my-tasks
pnpm cli my-tasks --flow-id 192 --step-id 106024
pnpm cli step-form --flow-id 192 --step-id 106024
pnpm cli notifications --is-archived N
pnpm cli my-registers --name Reposit
pnpm cli flow get --id-flow 192
pnpm cli flow get --hash abc123
pnpm cli register get --id-register 55
pnpm cli register get --hash reg-hash
pnpm cli fields by-flow --flow-id 192 --form-id 662
pnpm cli fields by-register --register-id 55 --with-children true --form-id 700
```

## Inspeção de estrutura e template

```bash
pnpm cli template flow-create --flow-id 192
pnpm cli template register-create --register-id 55
pnpm cli template step-move --flow-id 192 --from-step-id 106024 --to-step-id 106025
```

Os templates já retornam:

- contexto (`flowId/registerId` + `formId`)
- required fields
- optional fields
- payload skeleton

## Operações de card

```bash
pnpm cli card get --flow-id 192 --card-id 9001
pnpm cli card get --flow-id 192 --card-id 9001 --field-ids 332831,269733
pnpm cli card get --flow-id 192 --card-id 9001 --field-ids 332831,269733 --summary-only
pnpm cli card list --flow-id 192 --archived false --with-pre-answer true --with-time-tracking true --step-id 106024 --limit 50
pnpm cli card create --payload ./examples/create-card.example.json --validate-fields --dry-run
pnpm cli card update --payload ./examples/update-card.example.json --dry-run
pnpm cli card update-values --payload ./examples/update-card-values.example.json --validate-fields --dry-run
pnpm cli card move-step-with-values --discover-required --flow-id 192 --form-id 660
pnpm cli card move-step-with-values --payload ./examples/move-card-step-with-values.example.json --validate-fields --dry-run
```

Diferença importante:

- `card update` altera atributos principais do cartão (`responsável`, `due date`, `tag`, `complete`, `archived`)
- `card update-values` altera respostas dinâmicas do formulário (`values`)
- `card move-step-with-values` move de etapa enviando `idForm + values` (`values` pode ser `{}`)
- `card move-step-with-values --discover-required` lista campos obrigatórios do `form_id` antes de montar payload
- `card move-step` é alias deprecated (compatibilidade)

Observação sobre `card get`:

- `summary.fieldValues` retorna mapa flat `{ "<field_id>": <valor> }` para evitar parsing manual de `form_answers`.
- `summary.fields` é alias de `summary.fieldValues` para playbooks legados.
- Use `--field-ids` para retornar apenas os campos de interesse no summary.
- Com `--field-ids`, fields não encontrados retornam `null` no mapa.
- Use `--summary-only` para retornar somente o summary e eliminar parsing de `raw`.

## Operações de comentário e anexo

```bash
pnpm cli comment create --payload ./examples/comment-create.example.json --dry-run
pnpm cli attachment upload --file ./arquivo.pdf
pnpm cli attachment link-card --payload ./payload.json --dry-run
```

## Operações de notificação

```bash
pnpm cli notifications --is-archived N
pnpm cli notification read --payload ./examples/notification-read.example.json --dry-run
pnpm cli notification read --payload ./examples/notification-read.example.json
```

Obs.: o payload canônico usa `notificationId` (camelCase), mas o comando também aceita `id_notification` por compatibilidade com o formato raw da API.

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

## Convenção de payload de mutação

- `--payload` sempre recebe caminho de arquivo JSON (ex: `./examples/comment-create.example.json`).
- Não enviar JSON inline no `--payload`.
- Chaves de input de mutação (fora de `values`) seguem camelCase:
  - `flowId`, `cardId`, `registerId`, `formAnswerId`, `attachmentId`
- Exceção: dentro de `values`, as chaves são exatamente `field.name`.

## Regra de `form_id`

- Card create: usar `flow.form_init_id`.
- Register create/update: usar `register.form_id`.
- Card move-step-with-values: usar `idForm = flow_step.form_id` da etapa atual.
- Validar sempre com `--validate-fields` quando possível.
- Se `--validate-fields` falhar com `UNKNOWN_FIELD_TYPE`, repetir com `--dry-run` sem `--validate-fields`.

## Output e dry-run

- `--output json|pretty`
- `--dry-run` em mutações: mostra payload e não executa chamada de escrita
- código de saída não-zero em falha
- Para JSON limpo em stdout (sem header do pnpm), use `pnpm --silent cli --output json ...`

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
- em erros de validação de `values`, cada issue pode incluir `fieldTitle` quando disponível
- para campos de seleção (`RADIO_BOX_FIELD`/`COMBO_BOX_FIELD`), a validação checa valores reais das opções e retorna `INVALID_OPTION` quando necessário

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
- [docs/agent-changelog.md](./docs/agent-changelog.md)
- [docs/playbooks/README.md](./docs/playbooks/README.md)
- [docs/playbooks/00-agent-operational-suggestions.md](./docs/playbooks/00-agent-operational-suggestions.md)

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

O Codex lê [AGENTS.md](./AGENTS.md). Prompt completo recomendado (copiar/colar):

```text
Você está no repositório cange-agent-kit e deve deixá-lo 100% pronto para uso.

Siga exatamente esta sequência:

1) Leia os guias: AGENTS.md, docs/agent-mcp-kb.md e docs/playbooks/README.md.
2) Instale dependências com pnpm.
3) Verifique se existe .env:
   - se não existir, crie a partir de .env.example
   - não exponha secrets no output
4) Valide se o .env contém chaves esperadas:
   - CANGE_API_BASE_URL
   - CANGE_APP_ORIGIN
   - CANGE_ACCESS_TOKEN ou (CANGE_EMAIL + CANGE_APIKEY)
5) Rode validações de projeto:
   - pnpm lint:types
   - pnpm build
6) Faça smoke test da CLI:
   - pnpm cli --help
   - pnpm cli auth login
   - pnpm --silent cli --output json my-flows
   - pnpm --silent cli --output json my-registers
   - pnpm --silent cli --output json my-tasks
   - pnpm --silent cli --output json notifications --is-archived N
7) Se autenticação falhar, explique objetivamente o que falta no .env.
8) Entregue um relatório final com:
   - status de cada etapa (ok/falhou)
   - comando que falhou (se houver)
   - ação recomendada para corrigir

Regras obrigatórias:
- Usar somente `pnpm cli ...` para operações Cange.
- Em mutações com values: discovery -> validate-fields -> dry-run -> execução.
- Nunca inventar IDs, field.name ou chaves de values.
```

### 4. Claude Code

O Claude Code pode usar o arquivo [CLAUDE.md](./CLAUDE.md) deste repositório.

Prompt completo recomendado (copiar/colar):

```text
Você está no repositório cange-agent-kit. Configure e valide tudo para uso imediato da CLI.

Checklist obrigatório:
1) Leia CLAUDE.md, docs/agent-mcp-kb.md e docs/playbooks/README.md.
2) Execute:
   - pnpm install
   - se .env não existir: cp .env.example .env
3) Verifique configuração mínima no .env:
   - base/origin preenchidos
   - autenticação por token OU email+apikey
4) Rode:
   - pnpm lint:types
   - pnpm build
5) Smoke test:
   - pnpm cli --help
   - pnpm cli auth login
   - pnpm --silent cli --output json my-tasks
   - pnpm --silent cli --output json notifications --is-archived N
6) Mostre um resumo final com:
   - o que foi configurado
   - quais testes passaram
   - pendências para ficar 100% operacional

Política de operação:
- Preferir summaries para decisão e raw para auditoria.
- Não expor credenciais em logs.
- Em mutações: validar estrutura e usar dry-run antes da execução real.
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
