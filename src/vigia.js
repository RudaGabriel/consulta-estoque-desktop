"use strict";
/**
 * vigia.js
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Módulo de persistência do quiosque: um processo pequeno que
 *              reabre o Consulta Estoque se ele for fechado SEM o comando de
 *              saída (senha do administrador), travar ou cair.
 *
 * Roda com o próprio executável do aplicativo em modo Node
 * (ELECTRON_RUN_AS_NODE=1), a partir de uma cópia na pasta de dados.
 * Argumentos: --dados <pasta> --exe <executável> [--args <json>]
 *
 * Arquivos na pasta de dados:
 *   app.pid              PID do aplicativo em execução (gravado por ele ao abrir)
 *   vigia.pid            PID deste vigia (um só por vez)
 *   saida-autorizada     criado pelo aplicativo ao sair com a senha → o vigia termina
 *   reiniciando          criado pelo aplicativo ao reiniciar sozinho → o vigia espera
 *   config.json          com "persistente": false o vigia termina
 *
 * Transparente e reversível: aparece no Gerenciador de Tarefas como
 * "Consulta Estoque"; o aplicativo NÃO reabre o vigia enquanto está aberto
 * (só ao iniciar). Para desligar: Configurações → Windows → Persistência
 * (com a senha), ou "Sair do aplicativo" com a senha.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — Reabre em 1 a 2 s (antes ~14 s): confere a cada 1 s e só espera o prazo
 *           longo quando o próprio aplicativo avisou que está reiniciando ou logo
 *           depois de reabrir (o aplicativo novo ainda está gravando o PID).
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// CONSULTA_VIGIA_RAPIDO=1 encurta os tempos (só nos testes automáticos).
const R = process.env.CONSULTA_VIGIA_RAPIDO === "1" ? 0.1 : 1;
const INTERVALO_MS = 1000 * R;
const ESPERA_REINICIO_MS = 15000 * R; // só quando o app avisou que está reiniciando (grava o PID novo ao abrir)
const AVISO_VALIDO_MS = 30000;        // aviso "reiniciando" mais velho que isso é ignorado
const MAX_REINICIOS = 5;              // em JANELA_MS → pausa longa (evita laço se o app não abre)
const JANELA_MS = 3 * 60000 * R;
const PAUSA_LONGA_MS = 60000 * R;

function arg(nome) {
    const i = process.argv.indexOf("--" + nome);
    return i >= 0 ? process.argv[i + 1] : null;
}

const PASTA = arg("dados");
const EXE = arg("exe");
let ARGS = [];
try { ARGS = JSON.parse(arg("args") || "[]"); if (!Array.isArray(ARGS)) ARGS = []; } catch (_) { ARGS = []; }
if (!PASTA || !EXE) process.exit(2);

const ARQ = {
    app: path.join(PASTA, "app.pid"),
    vigia: path.join(PASTA, "vigia.pid"),
    saida: path.join(PASTA, "saida-autorizada"),
    reiniciando: path.join(PASTA, "reiniciando"),
    config: path.join(PASTA, "config.json"),
    log: path.join(PASTA, "consulta-estoque.log")
};

const vivo = pid => {
    if (!(pid > 0)) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
};
const lerPid = arq => { try { return parseInt(fs.readFileSync(arq, "utf8"), 10) || 0; } catch (_) { return 0; } };
const log = msg => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    const linha = "[" + p(d.getDate()) + "-" + p(d.getMonth() + 1) + "-" + d.getFullYear() + "] [" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "] [VIGIA] " + msg + "\r\n";
    try { fs.appendFileSync(ARQ.log, linha); } catch (_) {}
};
const persistenciaLigada = () => {
    try { return JSON.parse(fs.readFileSync(ARQ.config, "utf8").replace(/^﻿/, "")).persistente !== false; }
    catch (_) { return true; } // config ilegível: segue protegendo (o padrão é ligado)
};
// O próprio aplicativo avisou que está reiniciando (aviso recente)?
const reiniciandoAvisado = () => {
    try { return Date.now() - fs.statSync(ARQ.reiniciando).mtimeMs < AVISO_VALIDO_MS; } catch (_) { return false; }
};
const encerrar = (motivo) => {
    log("Vigia encerrado: " + motivo + ".");
    try { if (lerPid(ARQ.vigia) === process.pid) fs.unlinkSync(ARQ.vigia); } catch (_) {}
    process.exit(0);
};

// Um vigia só.
const outro = lerPid(ARQ.vigia);
if (outro && outro !== process.pid && vivo(outro)) process.exit(0);
try { fs.writeFileSync(ARQ.vigia, String(process.pid)); } catch (_) { process.exit(3); }
log("Vigia iniciado (PID " + process.pid + ") — reabre o aplicativo se ele for fechado sem a senha.");

let reinicios = [];
let mortoDesde = 0;
let pausaAte = 0;
let abertoEm = 0;          // última reabertura: o app novo leva uns segundos para gravar o PID

function abrirApp() {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE; // o aplicativo abre como aplicativo, não como Node
    try {
        const filho = cp.spawn(EXE, ARGS, { detached: true, stdio: "ignore", windowsHide: false, env });
        filho.on("error", e => log("Falha ao reabrir o aplicativo: " + e.message));
        filho.unref();
        log("Aplicativo fechado sem a senha — reaberto.");
    } catch (e) {
        log("Falha ao reabrir o aplicativo: " + e.message);
    }
}

setInterval(() => {
    // Ordem de saída autorizada (Sair com a senha) ou persistência desligada.
    if (fs.existsSync(ARQ.saida)) { try { fs.unlinkSync(ARQ.saida); } catch (_) {} encerrar("saída autorizada pelo administrador"); }
    if (!persistenciaLigada()) encerrar("persistência desligada nas configurações");
    if (lerPid(ARQ.vigia) !== process.pid) encerrar("outro vigia assumiu");

    const pid = lerPid(ARQ.app);
    if (vivo(pid)) { mortoDesde = 0; return; }
    const agora = Date.now();
    // Confirma na volta seguinte (1 s) que caiu mesmo; reinício avisado pelo app espera mais.
    if (!mortoDesde) { mortoDesde = agora; return; }
    if (agora < pausaAte || agora - abertoEm < ESPERA_REINICIO_MS) return;
    if (reiniciandoAvisado() && agora - mortoDesde < ESPERA_REINICIO_MS) return;

    reinicios = reinicios.filter(t => agora - t < JANELA_MS);
    if (reinicios.length >= MAX_REINICIOS) {
        pausaAte = agora + PAUSA_LONGA_MS;
        reinicios = [];
        log("O aplicativo não ficou aberto após " + MAX_REINICIOS + " tentativas — nova tentativa em " + Math.round(PAUSA_LONGA_MS / 1000) + " s.");
        return;
    }
    reinicios.push(agora);
    mortoDesde = 0;
    abertoEm = agora;
    abrirApp();
}, INTERVALO_MS);
