/**
 * autoexcluir.js — apaga a versão portátil depois que ela fecha
 * @author Ruda Gabriel
 * v1.0.0 — ajudante próprio (roda como Node, como o vigia), no lugar do comando
 *          PowerShell: espera o aplicativo, o vigia e o lançador do portátil
 *          fecharem, apaga o .exe e os dados (tentando por até 2 min) e limpa
 *          a pasta temporária onde o lançador abriu o aplicativo.
 * Histórico completo das versões: CHANGELOG.md no repositório.
 *
 * Uso (pelo main.js): <Electron com ELECTRON_RUN_AS_NODE=1> autoexcluir.js <JSON em base64>
 *   { pids: [..], alvos: [..], pastaLancador: "...\\Temp\\nsXXXX.tmp" | null, nomeExe, apagarScript }
 * Só usa módulos do próprio Node: o arquivo é copiado para a pasta temporária e roda de lá.
 */
"use strict";
// No Electron como Node, o fs abre arquivos .asar como pastas: aqui eles são só arquivos a apagar.
try { process.noAsar = true; } catch (_) {}
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const PADRAO = { esperaMs: 60000, prazoMs: 120000, passoMs: 1000 };

const dormir = ms => new Promise(r => setTimeout(r, ms));
const vivo = pid => {
    if (!(pid > 0) || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
};
const existe = p => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };

/** Apaga arquivo ou pasta; devolve true se não existe mais. */
function apagar(alvo) {
    try {
        if (fs.rmSync) fs.rmSync(alvo, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
        else if (existe(alvo)) { const st = fs.lstatSync(alvo); if (st.isDirectory()) fs.rmdirSync(alvo, { recursive: true }); else fs.unlinkSync(alvo); }
    } catch (_) {}
    return !existe(alvo);
}

/**
 * Pasta temporária do lançador do portátil ("...\nsXXXX.tmp"), quando o aplicativo
 * roda de "...\nsXXXX.tmp\app\<exe>". Qualquer outro caminho (versão instalada,
 * desenvolvimento) → null: nada fora disso é apagado por esta função.
 */
function pastaDoLancador(execPath, P) {
    P = P || path.win32;
    if (!execPath) return null;
    const dirApp = P.dirname(String(execPath));
    if (P.basename(dirApp).toLowerCase() !== "app") return null;
    const ns = P.dirname(dirApp);
    if (!/^ns[a-z0-9]+\.tmp$/i.test(P.basename(ns))) return null;
    if (/["%^&|<>]/.test(ns)) return null; // não vai para a linha do cmd
    return ns;
}

/** Sobras de aberturas antigas do portátil na pasta temporária (só as deste aplicativo). */
function sobrasDoLancador(tmp, nomeExe, exceto) {
    const achadas = [];
    if (!tmp || !nomeExe) return achadas;
    let nomes = [];
    try { nomes = fs.readdirSync(tmp); } catch (_) { return achadas; }
    for (const n of nomes) {
        if (!/^ns[a-z0-9]+\.tmp$/i.test(n)) continue;
        const ns = path.join(tmp, n);
        if (exceto && ns.toLowerCase() === String(exceto).toLowerCase()) continue;
        if (existe(path.join(ns, "app", nomeExe)) && existe(path.join(ns, "app", "resources", "app.asar"))) achadas.push(ns);
    }
    return achadas;
}

/** A pasta do próprio ajudante só pode ser apagada depois que ele fecha: o cmd espera uns segundos e apaga. */
function agendarRemocaoDaPasta(pasta) {
    if (process.platform !== "win32" || !pasta || /["%^&|<>]/.test(pasta)) return false;
    try {
        const filho = cp.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "\"ping -n 4 127.0.0.1 >nul & rmdir /s /q \"" + pasta + "\"\""],
            { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, cwd: os.tmpdir() });
        filho.on("error", () => {});
        filho.unref();
        return true;
    } catch (_) { return false; }
}

async function executar(op) {
    const o = Object.assign({}, PADRAO, op || {});
    const pids = (Array.isArray(o.pids) ? o.pids : []).map(Number).filter(n => n > 0);
    const alvos = (Array.isArray(o.alvos) ? o.alvos : []).filter(a => typeof a === "string" && a.length > 3).map(a => path.resolve(a));
    // 1) Espera o aplicativo, o vigia e o lançador do portátil (que segura o .exe) fecharem.
    const t0 = Date.now();
    while (pids.some(vivo) && Date.now() - t0 < o.esperaMs) await dormir(300);
    // 2) Apaga, tentando de novo enquanto algo ainda estiver preso (antivírus, Explorer aberto na pasta).
    let resta = alvos.slice();
    const t1 = Date.now();
    for (;;) {
        resta = resta.filter(a => !apagar(a));
        if (!resta.length || Date.now() - t1 >= o.prazoMs) break;
        await dormir(o.passoMs);
    }
    // 3) Pastas temporárias do lançador: as antigas agora; a atual (onde este ajudante roda) depois que ele fechar.
    for (const s of sobrasDoLancador(o.tmp || os.tmpdir(), o.nomeExe, o.pastaLancador)) apagar(s);
    if (o.apagarScript) apagar(__filename);
    if (o.pastaLancador) agendarRemocaoDaPasta(o.pastaLancador);
    return { apagados: alvos.length - resta.length, restantes: resta };
}

module.exports = { executar, pastaDoLancador, sobrasDoLancador, apagar };

if (require.main === module) {
    let op = {};
    try { op = JSON.parse(Buffer.from(String(process.argv[2] || ""), "base64").toString("utf8")) || {}; } catch (_) { op = {}; }
    executar(op).then(() => process.exit(0), () => process.exit(1));
}
