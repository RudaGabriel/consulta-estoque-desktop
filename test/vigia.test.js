"use strict";
// Testes do vigia (persistência) com processos de verdade e um "aplicativo" falso.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const VIGIA = path.join(__dirname, "..", "src", "vigia.js");
const esperar = (cond, ms) => new Promise((res, rej) => {
    const fim = Date.now() + (ms || 8000);
    (function v() { if (cond()) return res(); if (Date.now() > fim) return rej(new Error("tempo esgotado")); setTimeout(v, 50); })();
});
const vivo = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

function preparar(cfg, atrasoPidMs) {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "ced-vigia-"));
    fs.writeFileSync(path.join(pasta, "config.json"), JSON.stringify(Object.assign({ persistente: true }, cfg || {})));
    // "Aplicativo" falso: grava o PID, anota que abriu e fica aberto.
    const app = path.join(pasta, "app-falso.js");
    fs.writeFileSync(app, 'const fs=require("fs"),p=require("path"),d=process.argv[2];' +
        'fs.appendFileSync(p.join(d,"aberturas.txt"),"x");setTimeout(()=>fs.writeFileSync(p.join(d,"app.pid"),String(process.pid)),' + (atrasoPidMs || 0) + ');setInterval(()=>{},1000);');
    const vigia = cp.spawn(process.execPath, [VIGIA, "--dados", pasta, "--exe", process.execPath, "--args", JSON.stringify([app, pasta])],
        { stdio: "ignore", env: Object.assign({}, process.env, { CONSULTA_VIGIA_RAPIDO: "1" }) });
    return { pasta, vigia, aberturas: () => { try { return fs.readFileSync(path.join(pasta, "aberturas.txt"), "utf8").length; } catch (_) { return 0; } } };
}
const matarApp = pasta => { try { process.kill(parseInt(fs.readFileSync(path.join(pasta, "app.pid"), "utf8"), 10), "SIGKILL"); } catch (_) {} };
// O "aplicativo" anota a abertura antes de gravar o PID: espera o PID dele antes de matar.
const pidDoApp = pasta => { try { return parseInt(fs.readFileSync(path.join(pasta, "app.pid"), "utf8"), 10) || 0; } catch (_) { return 0; } };
const esperarPid = async pasta => { await esperar(() => { const p = pidDoApp(pasta); return p > 0 && vivo(p); }, 8000); };
const fimVigia = v => new Promise(res => { if (v.exitCode !== null) return res(v.exitCode); v.once("exit", c => res(c)); });

test("vigia: reabre o aplicativo fechado sem a senha", async () => {
    const t = preparar();
    try {
        await esperar(() => t.aberturas() === 1, 8000);           // app.pid inexistente → abre
        await esperarPid(t.pasta);
        matarApp(t.pasta);                                         // "fechado pelo Gerenciador de Tarefas"
        await esperar(() => t.aberturas() === 2, 8000);
        assert.ok(fs.readFileSync(path.join(t.pasta, "consulta-estoque.log"), "utf8").includes("reaberto"));
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});

test("vigia: saída autorizada (senha) encerra o vigia e não reabre", async () => {
    const t = preparar();
    try {
        await esperar(() => t.aberturas() === 1, 8000);
        fs.writeFileSync(path.join(t.pasta, "saida-autorizada"), "1");
        matarApp(t.pasta);
        assert.strictEqual(await fimVigia(t.vigia), 0);
        await new Promise(r => setTimeout(r, 1500));
        assert.strictEqual(t.aberturas(), 1, "não reabriu");
        assert.ok(!fs.existsSync(path.join(t.pasta, "vigia.pid")));
        assert.ok(!fs.existsSync(path.join(t.pasta, "saida-autorizada")));
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});

test("vigia: persistência desligada nas configurações → o vigia termina", async () => {
    const t = preparar();
    try {
        await esperar(() => t.aberturas() === 1, 8000);
        fs.writeFileSync(path.join(t.pasta, "config.json"), JSON.stringify({ persistente: false }));
        assert.strictEqual(await fimVigia(t.vigia), 0);
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});

test("vigia: só um vigia por vez", async () => {
    const t = preparar();
    try {
        await esperar(() => fs.existsSync(path.join(t.pasta, "vigia.pid")), 5000);
        const segundo = cp.spawn(process.execPath, [VIGIA, "--dados", t.pasta, "--exe", process.execPath], { stdio: "ignore" });
        assert.strictEqual(await fimVigia(segundo), 0);
        assert.ok(vivo(t.vigia.pid));
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});

test("vigia: reabre rápido, sem abrir duas vezes enquanto o aplicativo novo ainda grava o PID", async () => {
    // Modo rápido: confere a cada 0,1 s; o "aplicativo" leva 0,8 s para gravar o PID.
    const t = preparar(null, 800);
    try {
        await esperar(() => t.aberturas() === 1, 8000);
        await new Promise(r => setTimeout(r, 1200));
        assert.strictEqual(t.aberturas(), 1, "não abriu de novo enquanto o PID não estava gravado");
        await esperarPid(t.pasta);
        const antes = Date.now();
        matarApp(t.pasta);
        await esperar(() => t.aberturas() === 2, 8000);
        assert.ok(Date.now() - antes < 1000, "reabriu em menos de 1 s no modo rápido (≈ 1 a 2 s de verdade)");
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});

test("vigia: aplicativo que avisou que está reiniciando ganha tempo antes de ser reaberto", async () => {
    const t = preparar();
    try {
        await esperar(() => t.aberturas() === 1, 8000);
        await esperarPid(t.pasta);
        fs.writeFileSync(path.join(t.pasta, "reiniciando"), String(Date.now()));
        matarApp(t.pasta);
        await new Promise(r => setTimeout(r, 900));
        assert.strictEqual(t.aberturas(), 1, "esperou o reinício avisado");
        await esperar(() => t.aberturas() === 2, 8000);
    } finally { matarApp(t.pasta); t.vigia.kill(); }
});
