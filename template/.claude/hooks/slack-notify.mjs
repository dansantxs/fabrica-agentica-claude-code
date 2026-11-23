#!/usr/bin/env node
// Hook PostToolUse da Fábrica de Software: registra no Slack a finalização de cada subagente.
//
// Requisito do Projeto Final 4: "cada subagente deve registrar no Slack a finalização da sua tarefa".
// - PostToolUse(Agent): roda quando o subagente devolve o resultado ao orquestrador. Lê o bloco
//   STATUS / PARECER / ARTEFATOS / TESTES / BLOQUEIOS / PRÓXIMO e publica no canal.
// - PostToolUse(Bash) com `gh pr create`: publica o link do PR aberto pelo orquestrador (Checkpoint 2).
//
// A URL do Incoming Webhook vem de SLACK_WEBHOOK_URL. Defina no bloco "env" de
// .claude/settings.local.json (não vai para o Git). Sem a variável, só grava o log local
// .claude/fabrica/slack.log.jsonl. O hook nunca bloqueia o fluxo: qualquer erro é só registrado.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const NOMES = {
  "subagent-analista-requisitos": ["Analista de Requisitos", ":memo:"],
  "subagent-arquiteto": ["Arquiteto", ":building_construction:"],
  "subagent-criador-tarefas": ["Criador de Tarefas", ":clipboard:"],
  "subagent-desenvolvedor": ["Desenvolvedor", ":hammer_and_wrench:"],
  "subagent-revisor-codigo": ["Revisor de Código", ":mag:"],
  "subagent-qa": ["QA", ":white_check_mark:"],
};
const CAMPOS = ["STATUS", "PARECER", "ARTEFATOS", "TESTES", "BLOQUEIOS", "PRÓXIMO"];
const ICONE_STATUS = { DONE: ":large_green_circle:", BLOCKED: ":red_circle:", NEEDS_CLARIFICATION: ":large_yellow_circle:", HUMAN_REVIEW_REQUIRED: ":large_orange_circle:" };

// Junta todos os textos de uma resposta de ferramenta, qualquer que seja o formato.
function textos(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textos);
  if (v && typeof v === "object") {
    if (typeof v.text === "string") return [v.text];
    return ["content", "result", "output", "stdout"].filter((k) => k in v).flatMap((k) => textos(v[k]));
  }
  return [];
}

// Extrai o último bloco de status (a partir da última linha "STATUS:").
function blocoStatus(texto) {
  const linhas = texto.replace(/\r/g, "").split("\n");
  let ini = -1;
  linhas.forEach((l, i) => {
    if (/^\s*[*_`>]*\s*STATUS\s*[*_`]*\s*:/.test(l)) ini = i;
  });
  if (ini < 0) return null;
  const campos = {};
  let atual = null;
  for (const bruta of linhas.slice(ini)) {
    const l = bruta.replace(/^\s*[>*_`-]*\s*/, "").replace(/[*_`]+(?=\s*:)/, "");
    const m = l.match(/^([A-ZÁÉÍÓÚÂÊÔÃÕÇ]+)\s*:\s*(.*)$/);
    if (m && CAMPOS.includes(m[1])) {
      atual = m[1];
      campos[atual] = m[2].trim();
    } else if (atual && bruta.trim() && !/^```/.test(bruta.trim())) {
      campos[atual] += (campos[atual] ? "\n" : "") + bruta.trim();
    }
  }
  return campos;
}

const git = (raiz, args) => {
  try {
    return execSync(`git ${args}`, { cwd: raiz, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};

async function publicar(raiz, mensagem, registro) {
  const log = path.join(raiz, ".claude", "fabrica", "slack.log.jsonl");
  const url = process.env.SLACK_WEBHOOK_URL;
  let resultado = "sem SLACK_WEBHOOK_URL (só log local)";
  if (url) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mensagem) });
      resultado = `slack http ${r.status}`;
    } catch (e) {
      resultado = `erro: ${e.message}`;
    }
  }
  try {
    fs.appendFileSync(log, JSON.stringify({ em: new Date().toISOString(), resultado, ...registro }) + "\n");
  } catch {}
}

let entrada = "";
process.stdin.on("data", (c) => (entrada += c));
process.stdin.on("end", async () => {
  try {
    const ev = JSON.parse(entrada || "{}");
    const raiz = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
    const repo = path.basename(raiz);
    const branch = git(raiz, "branch --show-current") || "?";
    const ferramenta = ev.tool_name;

    if (ferramenta === "Agent" || ferramenta === "Task") {
      const agente = ev.tool_input?.subagent_type || "?";
      const [nome, emoji] = NOMES[agente] || [agente, ":robot_face:"];
      if (!NOMES[agente]) process.exit(0); // só os subagentes da fábrica
      const resposta = textos(ev.tool_response).join("\n");
      const campos = blocoStatus(resposta) || { STATUS: "(sem bloco de status)" };
      const status = (campos.STATUS || "").split(/\s/)[0];
      const etapa = (ev.tool_input?.prompt || "").match(/\bE\d(?:\.\d)?\b/)?.[0] || "";
      const detalhes = ["ARTEFATOS", "TESTES", "BLOQUEIOS", "PRÓXIMO"]
        .filter((k) => campos[k])
        .map((k) => `*${k}:* ${campos[k].includes("\n") ? "\n" + campos[k] : campos[k]}`)
        .join("\n");
      const titulo = `${emoji} ${nome} finalizou${etapa ? ` a ${etapa}` : " a sua tarefa"}`;
      const mensagem = {
        text: `${titulo}: STATUS ${campos.STATUS || "?"} (${repo} @ ${branch})`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: titulo.replace(/:[a-z_]+:\s*/g, "") } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Agente*\n\`${agente}\`` },
              { type: "mrkdwn", text: `*Branch*\n\`${branch}\`` },
              { type: "mrkdwn", text: `*STATUS*\n${ICONE_STATUS[status] || ":white_circle:"} ${campos.STATUS || "?"}` },
              { type: "mrkdwn", text: `*PARECER*\n${campos.PARECER || "—"}` },
            ],
          },
          ...(detalhes ? [{ type: "section", text: { type: "mrkdwn", text: detalhes.slice(0, 2900) } }] : []),
          { type: "context", elements: [{ type: "mrkdwn", text: `Fábrica de Software Agêntica · Claude Code · ${repo}` }] },
        ],
      };
      await publicar(raiz, mensagem, { agente, branch, etapa, campos });
    } else if (ferramenta === "Bash" || ferramenta === "PowerShell") {
      const cmd = String(ev.tool_input?.command || "");
      if (!/\bpr\s+create\b/.test(cmd)) process.exit(0);
      const url = textos(ev.tool_response).join("\n").match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
      if (!url) process.exit(0);
      const mensagem = {
        text: `:rocket: Orquestrador abriu o PR ${url} (${repo} @ ${branch}). Aguardando aprovação humana (Checkpoint 2).`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Orquestrador abriu o pull request" } },
          { type: "section", text: { type: "mrkdwn", text: `:rocket: <${url}|${url}>\n*Branch:* \`${branch}\`\nAguardando aprovação e merge do humano (Checkpoint 2).` } },
          { type: "context", elements: [{ type: "mrkdwn", text: `Fábrica de Software Agêntica · Claude Code · ${repo}` }] },
        ],
      };
      await publicar(raiz, mensagem, { agente: "orquestrador", branch, pr: url });
    }
  } catch (e) {
    try {
      process.stderr.write(`slack-notify: ${e.message}\n`);
    } catch {}
  }
  process.exit(0);
});
