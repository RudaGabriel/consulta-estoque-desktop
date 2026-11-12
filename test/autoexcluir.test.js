/**
 * Testes do ajudante que apaga a versão portátil (src/autoexcluir.js).
 * @author Ruda Gabriel
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const A = require("../src/autoexcluir.js"); // também desliga o .asar como pasta no Electron (process.noAsar)

const pastaTeste = () => fs.mkdtempSync(path.join(os.tmpdir(), "ce-autoexcluir-"));

test("pasta temporária do lançador do portátil é reconhecida", () => {
    assert.strictEqual(A.pastaDoLancador("C:\\Users\\Joao\\AppData\\Local\\Temp\\nsa1B2.tmp\\app\\Consulta Estoque.exe"),
        "C:\\Users\\Joao\\AppData\\Local\\Temp\\nsa1B2.tmp");
    assert.strictEqual(A.pastaDoLancador("C:\\Users\\Área de Trabalho\\Temp\\nsX9.tmp\\APP\\Consulta Estoque.exe"),
        "C:\\Users\\Área de Trabalho\\Temp\\nsX9.tmp");
});

test("fora do lançador do portátil nada é apagado da pasta do programa", () => {
    assert.strictEqual(A.pastaDoLancador("C:\\Program Files\\Consulta Estoque\\Consulta Estoque.exe"), null);
    assert.strictEqual(A.pastaDoLancador("C:\\Programas\\app\\Consulta Estoque.exe"), null);
    assert.strictEqual(A.pastaDoLancador("C:\\Temp\\outra.tmp\\app\\Consulta Estoque.exe"), null);
    assert.strictEqual(A.pastaDoLancador("C:\\100%\\nsa1.tmp\\app\\Consulta Estoque.exe"), null);
    assert.strictEqual(A.pastaDoLancador(""), null);
});

test("sobras de aberturas antigas: só as pastas deste aplicativo", () => {
    const tmp = pastaTeste();
    const criar = (nome, comAsar) => {
        const app = path.join(tmp, nome, "app");
        fs.mkdirSync(path.join(app, "resources"), { recursive: true });
        fs.writeFileSync(path.join(app, "Consulta Estoque.exe"), "x");
        if (comAsar) fs.writeFileSync(path.join(app, "resources", "app.asar"), "x");
        return path.join(tmp, nome);
    };
    const nossa = criar("nsa1.tmp", true), atual = criar("nsb2.tmp", true);
    criar("nsc3.tmp", false);                         // sem o pacote do aplicativo
    fs.mkdirSync(path.join(tmp, "nsd4.tmp", "app"), { recursive: true }); // de outro programa
    fs.mkdirSync(path.join(tmp, "qualquer"));
    assert.deepStrictEqual(A.sobrasDoLancador(tmp, "Consulta Estoque.exe", atual), [nossa]);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("espera o aplicativo fechar e só então apaga o .exe e os dados", async () => {
    const tmp = pastaTeste();
    const exe = path.join(tmp, "Consulta Estoque portátil.exe");
    const dados = path.join(tmp, "ConsultaEstoque-dados");
    fs.writeFileSync(exe, "exe");
    fs.mkdirSync(path.join(dados, "cache"), { recursive: true });
    fs.writeFileSync(path.join(dados, "config.json"), "{}");
    const app = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
    const inicio = Date.now();
    const r = await A.executar({ pids: [app.pid], alvos: [exe, dados, path.join(tmp, "nao-existe")], tmp, esperaMs: 10000, prazoMs: 2000, passoMs: 100 });
    assert.ok(Date.now() - inicio >= 1000, "esperou o aplicativo fechar");
    assert.ok(!fs.existsSync(exe) && !fs.existsSync(dados), "apagou o .exe e a pasta de dados");
    assert.deepStrictEqual(r.restantes, []);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("roda sozinho pela linha de comando (como o main.js chama) e apaga a própria cópia", async () => {
    const tmp = pastaTeste();
    const script = path.join(tmp, "ajudante.js");
    fs.copyFileSync(path.join(__dirname, "..", "src", "autoexcluir.js"), script);
    const alvo = path.join(tmp, "Consulta Estoque.exe");
    fs.writeFileSync(alvo, "exe");
    const dados = { pids: [999999], alvos: [alvo], tmp, nomeExe: "Consulta Estoque.exe", apagarScript: true, esperaMs: 2000, prazoMs: 2000, passoMs: 100 };
    const codigo = await new Promise(ok => {
        const f = cp.spawn(process.execPath, [script, Buffer.from(JSON.stringify(dados), "utf8").toString("base64")], { stdio: "ignore" });
        f.on("exit", ok);
    });
    assert.strictEqual(codigo, 0);
    assert.ok(!fs.existsSync(alvo), "apagou o .exe");
    assert.ok(!fs.existsSync(script), "apagou a própria cópia");
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("argumento estragado não apaga nada e termina sem travar", async () => {
    const codigo = await new Promise(ok => {
        const f = cp.spawn(process.execPath, [path.join(__dirname, "..", "src", "autoexcluir.js"), "%%%lixo"], { stdio: "ignore" });
        f.on("exit", ok);
    });
    assert.strictEqual(codigo, 0);
});
