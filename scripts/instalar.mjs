#!/usr/bin/env node
// Instala a Fábrica de Software (Claude Code) em um projeto já clonado do GitHub.
//
// Uso: node scripts/instalar.mjs <pasta-do-projeto>
//
// 1. Confere os pré-requisitos (git com commit e origin, gh autenticado, specify instalado).
// 2. Roda `specify init --here --integration claude` se o Spec Kit ainda não estiver no projeto.
// 3. Copia template/.claude (agentes, hooks, política, settings.json) para o projeto, mesclando settings.json.
// 4. Cria .claude/settings.local.json (fora do Git) com o espaço para o SLACK_WEBHOOK_URL.
// 5. Acrescenta ao .gitignore o que não deve ir para o repositório.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destino = path.resolve(process.argv[2] || ".");
const sh = (cmd, cwd = destino) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const ok = (msg) => console.log(`  ok  ${msg}`);
const falha = (msg) => {
  console.error(`  ERRO ${msg}`);
  process.exit(1);
};

console.log(`Instalando a Fábrica em ${destino}`);
try { sh("git rev-parse --is-inside-work-tree"); ok("repositório git"); } catch { falha("não é um repositório git (clone o projeto do GitHub primeiro)"); }
try { sh("git rev-parse HEAD"); ok("branch base com commit"); } catch { falha("a branch base precisa de pelo menos um commit"); }
try { ok(`origin: ${sh("git remote get-url origin")}`); } catch { falha("remoto origin não configurado"); }
try { sh("gh auth status"); ok("gh autenticado"); } catch { falha("gh não autenticado (rode gh auth login)"); }

if (!fs.existsSync(path.join(destino, ".specify"))) {
  try { sh("specify version"); } catch { falha("CLI do Spec Kit ausente: uv tool install specify-cli --from git+https://github.com/github/spec-kit.git"); }
  console.log("  ..  specify init --here --integration claude");
  execSync("specify init --here --force --non-interactive --integration claude --script sh --ignore-agent-tools", { cwd: destino, stdio: "inherit" });
}
ok("Spec Kit inicializado (.specify/)");

const copiar = (de, para) => {
  for (const item of fs.readdirSync(de, { withFileTypes: true })) {
    const a = path.join(de, item.name);
    const b = path.join(para, item.name);
    if (item.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      copiar(a, b);
    } else if (item.name !== "settings.json") fs.copyFileSync(a, b);
  }
};
const origemClaude = path.join(kit, "template", ".claude");
const destClaude = path.join(destino, ".claude");
fs.mkdirSync(destClaude, { recursive: true });
copiar(origemClaude, destClaude);
ok("agentes, hooks e política copiados para .claude/");

// settings.json: mescla com o que o Spec Kit ou o projeto já tiverem.
const arqSettings = path.join(destClaude, "settings.json");
const atual = fs.existsSync(arqSettings) ? JSON.parse(fs.readFileSync(arqSettings, "utf8")) : {};
const fab = JSON.parse(fs.readFileSync(path.join(origemClaude, "settings.json"), "utf8"));
const uniq = (a = [], b = []) => [...new Set([...a, ...b])];
const merged = {
  ...atual,
  ...fab,
  permissions: {
    ...(atual.permissions || {}),
    allow: uniq(atual.permissions?.allow, fab.permissions.allow),
    ask: uniq(atual.permissions?.ask, fab.permissions.ask),
    deny: uniq(atual.permissions?.deny, fab.permissions.deny),
  },
  hooks: { ...(atual.hooks || {}), ...fab.hooks },
};
fs.writeFileSync(arqSettings, JSON.stringify(merged, null, 2) + "\n");
ok('settings.json: "agent": "orquestrador", permissões e hooks');

const local = path.join(destClaude, "settings.local.json");
if (!fs.existsSync(local)) {
  fs.writeFileSync(local, JSON.stringify({ env: { SLACK_WEBHOOK_URL: "" } }, null, 2) + "\n");
  ok("settings.local.json criado: cole o Incoming Webhook do Slack em env.SLACK_WEBHOOK_URL");
}

const gi = path.join(destino, ".gitignore");
const linhas = [".claude/settings.local.json", ".claude/fabrica/slack.log.jsonl"];
const conteudo = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
const faltam = linhas.filter((l) => !conteudo.split(/\r?\n/).includes(l));
if (faltam.length) fs.appendFileSync(gi, (conteudo && !conteudo.endsWith("\n") ? "\n" : "") + "\n# Fábrica de Software (Claude Code)\n" + faltam.join("\n") + "\n");
ok(".gitignore atualizado");

console.log(`
Pronto. Próximos passos:
  1. Cole o webhook do Slack em .claude/settings.local.json (env.SLACK_WEBHOOK_URL).
  2. Crie a constituição: FABRICA_AGENTE_PRINCIPAL=humano claude   e rode  /speckit-constitution
  3. Faça o commit da fábrica na branch base e abra o Claude Code: a sessão já é o orquestrador.`);
