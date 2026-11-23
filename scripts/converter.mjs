#!/usr/bin/env node
// Converte os agentes da Fábrica de Software (opencode) em subagentes do Claude Code.
//
// Uso: node scripts/converter.mjs [pasta-original] [pasta-.claude-de-saida]
//      (padrão: original/  ->  template/.claude/)
//
// O que é convertido: só o cabeçalho (frontmatter). O corpo de cada prompt é preservado;
// a única troca textual é o prefixo de nome "fabrica-software/" (no opencode o nome da pasta
// fazia parte do nome do agente; no Claude Code o nome é o campo `name`).
//
// Mapeamento opencode -> Claude Code:
//   description          -> description (mesmo texto)
//   mode: primary        -> "agent": "orquestrador" no settings.json (sessão principal)
//   mode: subagent       -> arquivo em .claude/agents/ com `name`
//   model / temperature  -> model por papel (tabela MODELOS); temperature não existe no Claude Code
//   steps                -> maxTurns
//   permission.task      -> política "task" (hook fabrica-guard, PreToolUse do Agent) + permissions.ask
//   permission.edit/bash -> política "edit"/"bash" em .claude/fabrica/policy.json (hook fabrica-guard)

import fs from "node:fs";
import path from "node:path";

const [, , origemArg = "original", saidaArg = "template/.claude"] = process.argv;
const origem = path.resolve(origemArg);
const saida = path.resolve(saidaArg);

// Um modelo diferente para quem produz e para quem verifica (seção "Um modelo diferente para cada papel").
const MODELOS = {
  orquestrador: "inherit",
  "subagent-analista-requisitos": "inherit",
  "subagent-arquiteto": "opus",
  "subagent-criador-tarefas": "sonnet",
  "subagent-desenvolvedor": "sonnet",
  "subagent-revisor-codigo": "opus",
  "subagent-qa": "haiku",
};

// Ferramentas do Claude Code por papel. Nenhum subagente recebe "Agent": subagente não aciona subagente.
const BASE = ["Read", "Glob", "Grep", "Bash", "Skill", "TodoWrite", "Write", "Edit"];
const FERRAMENTAS = {
  orquestrador: ["Agent", ...BASE],
  default: BASE,
};

const CORES = {
  orquestrador: "blue",
  "subagent-analista-requisitos": "purple",
  "subagent-arquiteto": "orange",
  "subagent-criador-tarefas": "yellow",
  "subagent-desenvolvedor": "green",
  "subagent-revisor-codigo": "red",
  "subagent-qa": "cyan",
};

// Arquivo de contexto: o opencode usa AGENTS.md; a integração claude do Spec Kit atualiza CLAUDE.md.
const EQUIVALENTES_EDIT = { "AGENTS.md": ["AGENTS.md", "CLAUDE.md"] };

function lerFrontmatter(texto) {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("arquivo sem frontmatter");
  const cab = {};
  const permission = {};
  let secao = null;
  for (const linha of m[1].split(/\r?\n/)) {
    if (!linha.trim() || linha.trim().startsWith("#")) continue;
    const indent = linha.match(/^ */)[0].length;
    if (indent === 0) {
      const [, k, v] = linha.match(/^([\w-]+):\s*(.*)$/);
      secao = null;
      if (k === "permission") continue;
      cab[k] = v.replace(/^["']|["']$/g, "");
    } else if (indent === 2) {
      secao = linha.trim().replace(/:$/, "");
      permission[secao] = [];
    } else if (secao) {
      const r = linha.trim().match(/^(["'])(.*)\1\s*:\s*(\w+)/);
      if (r) permission[secao].push([r[2], r[3]]);
    }
  }
  return { cab, permission, corpo: m[2] };
}

const notaGeral = (nome) => `> **Adaptação para o Claude Code.** Este é o prompt original da fábrica (opencode), preservado. Neste harness:
> - Os agentes \`fabrica-software/<nome>\` são os subagentes \`<nome>\` de \`.claude/agents/\`.
> - As skills do Spec Kit (\`speckit-specify\`, \`speckit-plan\`, \`speckit-tasks\`, \`speckit-implement\`...) foram instaladas por \`specify init --integration claude\`: use a ferramenta **Skill** com esse nome. Se a skill não existir, leia e siga \`.claude/skills/<nome>/SKILL.md\` ou \`.claude/commands/<nome com ponto>.md\`.
> - Onde o texto diz \`AGENTS.md\`, o arquivo de contexto deste harness é o \`CLAUDE.md\` da raiz.
> - As regras de \`permission\` do cabeçalho original são aplicadas pelo hook \`.claude/hooks/fabrica-guard.mjs\` (política em \`.claude/fabrica/policy.json\`, vale a última regra que casar). Uma ação negada pelo hook é regra da fábrica: não tente contorná-la por outro caminho.
> - O shell padrão é o Bash (Git Bash no Windows). Use caminhos com \`/\`.${nome === "orquestrador" ? "" : `
> - Ao terminar, o hook \`slack-notify.mjs\` publica no Slack o seu bloco de status. Encerre **sempre** com o bloco STATUS completo, sem texto depois dele.`}
`;

const notaOrquestrador = `
> **Adaptação para o Claude Code (orquestrador).**
> - Você é a sessão principal (\`"agent": "orquestrador"\` em \`.claude/settings.json\`). Aciona cada subagente com a ferramenta **Agent**, \`subagent_type\` = nome do subagente (ex.: \`subagent-arquiteto\`) e o handoff completo de 10 itens no \`prompt\`. Subagentes do Claude Code começam sem contexto, como o handoff pressupõe.
> - A barreira \`ask\` do Arquiteto continua: o hook pede confirmação humana antes de cada \`Agent(subagent-arquiteto)\`.
> - O hook \`slack-notify.mjs\` publica no Slack o STATUS de cada subagente quando ele devolve o resultado, e também a abertura do PR. Ao relatar cada etapa ao humano, mencione que o registro foi enviado.
> - No Windows, o \`gh\` pode estar em \`"/c/Program Files/GitHub CLI/gh.exe"\` (o fluxo já prevê isso em E0).
`;

function yamlStr(s) {
  return JSON.stringify(s);
}

fs.mkdirSync(path.join(saida, "agents"), { recursive: true });
fs.mkdirSync(path.join(saida, "fabrica"), { recursive: true });

const politica = {};
for (const arq of fs.readdirSync(origem).filter((f) => f.endsWith(".md")).sort()) {
  const nome = path.basename(arq, ".md");
  const { cab, permission, corpo } = lerFrontmatter(fs.readFileSync(path.join(origem, arq), "utf8"));
  const tira = (p) => p.replace(/^fabrica-software\//, "");

  const pol = {};
  for (const [secao, regras] of Object.entries(permission)) {
    pol[secao] = [];
    for (const [padrao, acao] of regras) {
      const alvos = secao === "edit" ? EQUIVALENTES_EDIT[padrao] || [padrao] : [secao === "task" ? tira(padrao) : padrao];
      for (const alvo of alvos) pol[secao].push([alvo, acao]);
    }
  }
  politica[nome] = pol;

  const linhas = [
    "---",
    `name: ${nome}`,
    `description: ${yamlStr(cab.description)}`,
    `tools: ${(FERRAMENTAS[nome] || FERRAMENTAS.default).join(", ")}`,
    `model: ${MODELOS[nome] || "inherit"}`,
    ...(cab.steps ? [`maxTurns: ${cab.steps}`] : []),
    `color: ${CORES[nome] || "gray"}`,
    "---",
    "",
  ];
  const corpoConvertido = corpo.replace(/fabrica-software\/(subagent-[\w-]+|orquestrador)/g, "$1");
  const texto = linhas.join("\n") + notaGeral(nome) + (cab.mode === "primary" ? notaOrquestrador : "") + "\n" + corpoConvertido.trimStart();
  fs.writeFileSync(path.join(saida, "agents", `${nome}.md`), texto);
  console.log(`convertido: ${nome}  (mode ${cab.mode}, model ${MODELOS[nome] || "inherit"}, ${Object.keys(pol).join("/") || "sem regras"})`);
}

fs.writeFileSync(path.join(saida, "fabrica", "policy.json"), JSON.stringify(politica, null, 2) + "\n");
console.log(`política gravada: ${path.relative(process.cwd(), path.join(saida, "fabrica", "policy.json"))}`);
