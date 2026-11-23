#!/usr/bin/env node
// Hook PreToolUse da Fábrica de Software no Claude Code.
//
// Aplica, por agente, as regras de `permission` que no opencode ficavam no cabeçalho de cada agente:
//   task -> ferramenta Agent (quais subagentes podem ser acionados; "ask" pede confirmação ao humano)
//   edit -> Write / Edit / MultiEdit / NotebookEdit (quais caminhos podem ser alterados)
//   bash -> Bash / PowerShell (quais comandos podem rodar)
// Semântica do opencode preservada: as regras são lidas em ordem e vale a ÚLTIMA que casar;
// "*" casa qualquer sequência de caracteres. A política vem de .claude/fabrica/policy.json,
// gerada por scripts/converter.mjs a partir dos agentes originais.
//
// Qual agente está agindo: dentro de um subagente o Claude Code envia `agent_type` no evento;
// na sessão principal vale o agente de settings.json ("agent": "orquestrador").
// Para rodar a sessão principal como humano (ex.: /speckit-constitution), defina FABRICA_AGENTE_PRINCIPAL=humano.

import fs from "node:fs";
import path from "node:path";

const EDICAO = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL = new Set(["Bash", "PowerShell"]);
const AGENTE = new Set(["Agent", "Task"]);

const lerJson = (arq) => {
  try {
    return JSON.parse(fs.readFileSync(arq, "utf8"));
  } catch {
    return null;
  }
};

function agenteAtual(evento, raiz) {
  if (evento.agent_type) return evento.agent_type;
  if (process.env.FABRICA_AGENTE_PRINCIPAL) return process.env.FABRICA_AGENTE_PRINCIPAL;
  for (const nome of ["settings.local.json", "settings.json"]) {
    const s = lerJson(path.join(raiz, ".claude", nome));
    if (s?.agent) return s.agent;
  }
  return null;
}

const paraRegex = (padrao) =>
  new RegExp("^" + padrao.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");

function decidir(regras, alvo) {
  let decisao = "allow";
  let regra = null;
  for (const [padrao, acao] of regras) {
    if (paraRegex(padrao).test(alvo)) {
      decisao = acao; // vale a última que casar
      regra = padrao;
    }
  }
  return { decisao, regra };
}

// Avalia o comando inteiro e cada comando encadeado, para que `cd x && git push` não burle a regra.
function segmentos(comando) {
  const limpo = comando.trim();
  const partes = limpo.split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/).map((p) => p.trim()).filter(Boolean);
  // também sem prefixos de variáveis de ambiente (FOO=1 git push)
  const semEnv = partes.map((p) => p.replace(/^(?:\w+=\S*\s+)+/, ""));
  return [...new Set([limpo, ...partes, ...semEnv])];
}

function responder(decisao, motivo) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decisao, permissionDecisionReason: motivo },
    }),
  );
  process.exit(0);
}

let entrada = "";
process.stdin.on("data", (c) => (entrada += c));
process.stdin.on("end", () => {
  let evento;
  try {
    evento = JSON.parse(entrada || "{}");
  } catch {
    process.exit(0);
  }
  const raiz = process.env.CLAUDE_PROJECT_DIR || evento.cwd || process.cwd();
  const politica = lerJson(path.join(raiz, ".claude", "fabrica", "policy.json")) || {};
  const agente = agenteAtual(evento, raiz);
  const regras = politica[agente];
  if (!regras) process.exit(0); // agente fora da fábrica (ou humano): segue as permissões normais

  const ferramenta = evento.tool_name;
  const entradaFerr = evento.tool_input || {};

  if (AGENTE.has(ferramenta) && regras.task) {
    const alvo = entradaFerr.subagent_type || "general-purpose";
    const { decisao, regra } = decidir(regras.task, alvo);
    if (decisao === "deny") responder("deny", `Fábrica: ${agente} não pode acionar ${alvo} (regra task "${regra}").`);
    // Execução agendada/headless: o humano já confirmou o Arquiteto ao disparar a execução.
    if (decisao === "ask" && process.env.FABRICA_CONFIRMACAO_PREVIA === "1")
      responder("allow", `Fábrica: ${alvo} confirmado previamente pelo humano (FABRICA_CONFIRMACAO_PREVIA=1).`);
    if (decisao === "ask")
      responder("ask", `Fábrica: acionar ${alvo} exige confirmação humana (regra task "${regra}": ask). Confirme só se o Checkpoint 1 foi aprovado.`);
    process.exit(0);
  }

  if (EDICAO.has(ferramenta) && regras.edit) {
    const bruto = entradaFerr.file_path || entradaFerr.notebook_path || "";
    const norm = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    const absRaiz = norm(raiz);
    const absArq = norm(path.resolve(raiz, bruto));
    const dentro = process.platform === "win32" ? absArq.toLowerCase().startsWith(absRaiz.toLowerCase() + "/") : absArq.startsWith(absRaiz + "/");
    const rel = dentro ? absArq.slice(absRaiz.length + 1) : absArq;
    const { decisao, regra } = decidir(regras.edit, rel);
    if (decisao !== "allow")
      responder(decisao, `Fábrica: o agente ${agente} não pode editar ${rel} (regra edit "${regra}": ${decisao}).`);
    process.exit(0);
  }

  if (SHELL.has(ferramenta) && regras.bash) {
    const comando = String(entradaFerr.command || "");
    let pior = { decisao: "allow" };
    for (const seg of segmentos(comando)) {
      const d = decidir(regras.bash, seg);
      if (d.decisao === "deny") responder("deny", `Fábrica: o agente ${agente} não pode executar "${seg}" (regra bash "${d.regra}": deny).`);
      if (d.decisao === "ask") pior = { ...d, seg };
    }
    if (pior.decisao === "ask") responder("ask", `Fábrica: "${pior.seg}" exige confirmação (regra bash "${pior.regra}").`);
  }
  process.exit(0);
});
