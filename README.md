# Fábrica de Software Agêntica no Claude Code

Adaptação da [Fábrica de Software Agêntica Semi-autônoma](https://github.com/andremenegassi/fabrica-software-agentica) (prof. André Menegassi), feita para o opencode, para rodar no **Claude Code**, com o GitHub Spec Kit, Git/GitHub obrigatórios e **registro no Slack da finalização de cada subagente**.

Projeto Final 4 · Tópicos. Os mesmos 7 agentes e o mesmo fluxo E0 → E8; muda só o harness.

## O que tem aqui

```text
original/                  os 7 agentes do opencode, sem alteração (fonte da verdade)
scripts/converter.mjs      gera os subagentes do Claude Code a partir de original/
scripts/instalar.mjs       instala a fábrica em um projeto clonado do GitHub
template/.claude/
├── agents/*.md            orquestrador + 6 subagentes (gerados pelo conversor)
├── fabrica/policy.json    permissões edit/bash/task extraídas dos cabeçalhos originais
├── hooks/fabrica-guard.mjs  PreToolUse: aplica a política do agente que está agindo
├── hooks/slack-notify.mjs   PostToolUse: publica no Slack o STATUS de cada subagente e o PR
└── settings.json          "agent": "orquestrador", permissões e hooks
```

Tudo em **Node.js** (já exigido pelo Claude Code): não depende de Python na máquina.

## Do opencode para o Claude Code

| Fábrica no opencode | Fábrica no Claude Code |
|---|---|
| `~/.config/opencode/agents/fabrica-software/*.md` | `.claude/agents/*.md` no projeto, gerados por `scripts/converter.mjs` |
| `mode: primary` no orquestrador | `"agent": "orquestrador"` em `.claude/settings.json`: a sessão principal já é o orquestrador |
| `mode: subagent` | subagente do Claude Code, acionado pela ferramenta **Agent** (`subagent_type`) |
| `permission.task` (`*` deny, `subagent-*` allow, arquiteto `ask`) | hook `fabrica-guard.mjs` no `PreToolUse(Agent)`: nega agentes fora da fábrica e pede confirmação humana para o Arquiteto |
| `permission.edit` / `permission.bash` | mesmo hook, no `PreToolUse` de Write/Edit/Bash, com a regra original: **vale a última que casar** |
| `steps: 150` | `maxTurns: 150` |
| `model` único (`9router/combo-free`) | um modelo por papel: Arquiteto e Revisor **Opus**, Desenvolvedor e Criador de Tarefas **Sonnet**, QA **Haiku** (tabela `MODELOS` do conversor) |
| `temperature: 0.1` | não existe no Claude Code (registrado como diferença) |
| Spec Kit para opencode | `specify init --integration claude`: skills `speckit-*` com os mesmos nomes |
| `AGENTS.md` | `CLAUDE.md` (o `update-agent-context` do Spec Kit atualiza esse arquivo) |
| `opencode-scheduler-v2` | `claude -p` agendado (Agendador de Tarefas do Windows ou `/schedule`), ver abaixo |
| (novo) registro no Slack | hook `PostToolUse(Agent)` → Incoming Webhook |

**Reaproveitamento:** o corpo dos 7 prompts é preservado. O conversor só troca o cabeçalho, remove o prefixo `fabrica-software/` dos nomes e acrescenta uma nota curta de adaptação ao harness no topo de cada agente.

**Regra no hook vale mais que regra no prompt:** no opencode, o limite do QA e do Desenvolvedor estava só no texto. Aqui todas as regras do cabeçalho viram política aplicada pela ferramenta, inclusive dentro dos subagentes (o Claude Code informa `agent_type` ao hook).

## Instalação

Pré-requisitos: Node 18+, Git, `gh` autenticado, Claude Code e o CLI do Spec Kit:

```powershell
winget install astral-sh.uv
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
```

1. Publique o projeto no GitHub e clone (precisa de um commit na branch base e do `origin`).
2. Instale a fábrica no clone:
   ```powershell
   node scripts/instalar.mjs C:\caminho\do\projeto
   ```
   O script roda `specify init --here --integration claude`, copia `.claude/`, mescla `settings.json`, cria `.claude/settings.local.json` (fora do Git) e atualiza o `.gitignore`.
3. **Slack:** crie um app em <https://api.slack.com/apps> → *Incoming Webhooks* → *Add New Webhook to Workspace* → escolha o canal (ex.: `#fabrica-software`). Cole a URL em `.claude/settings.local.json`:
   ```json
   { "env": { "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/..." } }
   ```
4. **Constituição:** abra o Claude Code como humano (fora do papel de orquestrador) e rode `/speckit-constitution`:
   ```powershell
   $env:FABRICA_AGENTE_PRINCIPAL = "humano"; claude
   ```
5. Faça o commit da fábrica e da constituição na branch base e dê push.

## Uso

Abra `claude` na raiz do projeto: a sessão já é o orquestrador.

```text
@subagent-analista-requisitos Nova feature.
No frontend a data/hora do servidor deve aparecer no formato pt-br e em cor vermelha. Não precisa ser atualizada e deve usar a timezone America/Sao_Paulo.
```

O orquestrador cria a branch, aciona o Analista (`speckit-specify`), faz o commit da spec e **para no Checkpoint 1**. Responda `aprovado`: o Claude Code pede confirmação antes do Arquiteto (barreira `ask`) e o fluxo segue sozinho por Arquiteto → Criador de Tarefas → `speckit-analyze` → Desenvolvedor → Revisor → QA → PR. Cada subagente publica o seu STATUS no Slack; a abertura do PR também é publicada. O merge é sempre humano (Checkpoint 2).

### Execução agendada das specs aprovadas

As specs aprovadas e não implementadas formam o backlog. Para rodá-las em sequência num horário, sem ninguém na frente da tela, o humano confirma o Arquiteto antecipadamente com `FABRICA_CONFIRMACAO_PREVIA=1`:

```powershell
$env:FABRICA_CONFIRMACAO_PREVIA = "1"
claude -p --agent orquestrador (Get-Content prompts\backlog-sequencial.txt -Raw)
```

Agende esse comando no Agendador de Tarefas do Windows (ou use o `/schedule` do Claude Code). O prompt é o mesmo do roteiro original: execute `001-...` e depois `002-...`, obrigatoriamente em sequência, interrompendo se a primeira falhar.

## Créditos

Agentes, fluxo e regras: [andremenegassi/fabrica-software-agentica](https://github.com/andremenegassi/fabrica-software-agentica). Adaptação para o Claude Code: Daniel dos Santos.
