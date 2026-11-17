/**
 * Testes das atualizações do aplicativo (src/atualizacoes.js), sem rede.
 * @author Ruda Gabriel
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { EventEmitter } = require("events");
const A = require("../src/atualizacoes.js");

/** Servidor falso: rotas[url] = { status, corpo (string/Buffer), local (redirecionamento) }. */
function getFalso(rotas, visitas) {
    return (url, _opcoes, cb) => {
        if (visitas) visitas.push(url);
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = e => req.emit("error", e || new Error("destruído"));
        setImmediate(() => {
            const r = rotas[url];
            if (!r) { req.emit("error", new Error("getaddrinfo ENOTFOUND")); return; }
            const res = new PassThrough();
            res.statusCode = r.status || 200;
            res.headers = r.local ? { location: r.local } : { "content-length": String(Buffer.byteLength(r.corpo || "")) };
            cb(res);
            res.end(r.corpo || "");
        });
        return req;
    };
}
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const SOMAS = v => [
    "a".repeat(64) + "  ConsultaEstoque-" + v + "-legado-win7-a-11-ia32-instalador.exe",
    "b".repeat(64) + "  ConsultaEstoque-" + v + "-legado-win7-a-11-ia32-portatil.exe",
    "c".repeat(64) + "  ConsultaEstoque-" + v + "-legado-win7-a-11-instalador.exe",
    "d".repeat(64) + "  ConsultaEstoque-" + v + "-legado-win7-a-11-x64-instalador.exe",
    "e".repeat(64) + "  ConsultaEstoque-" + v + "-win10-11-x64-instalador.exe",
    "f".repeat(64) + "  ConsultaEstoque-" + v + "-win10-11-x64-portatil.exe",
    "linha inválida", "1234  arquivo.exe"
].join("\n");

test("atualizações: comparação de versões (só uma versão MAIOR atualiza)", () => {
    assert.strictEqual(A.compararVersoes("1.10.0", "1.9.9"), 1, "numérico, não texto");
    assert.strictEqual(A.compararVersoes("v1.8.0", "1.8.0"), 0);
    assert.strictEqual(A.compararVersoes("1.7.9", "1.8.0"), -1);
    assert.strictEqual(A.compararVersoes("lixo", "0.0.1"), -1, "versão inválida vale 0.0.0");
});

test("atualizações: lê o SHA256SUMS.txt e escolhe o arquivo da mesma variante, arquitetura e tipo", () => {
    const s = A.lerSomas(SOMAS("1.9.0"));
    assert.strictEqual(s.length, 6, "linhas inválidas ignoradas");
    const nome = alvo => (A.escolherArquivo(s, alvo) || {}).nome;
    assert.strictEqual(nome({ legado: false, arch: "x64", portatil: false }), "ConsultaEstoque-1.9.0-win10-11-x64-instalador.exe");
    assert.strictEqual(nome({ legado: false, arch: "x64", portatil: true }), "ConsultaEstoque-1.9.0-win10-11-x64-portatil.exe");
    assert.strictEqual(nome({ legado: true, arch: "ia32", portatil: false }), "ConsultaEstoque-1.9.0-legado-win7-a-11-ia32-instalador.exe");
    assert.strictEqual(nome({ legado: true, arch: "ia32", portatil: true }), "ConsultaEstoque-1.9.0-legado-win7-a-11-ia32-portatil.exe");
    assert.strictEqual(nome({ legado: true, arch: "x64", portatil: false }), "ConsultaEstoque-1.9.0-legado-win7-a-11-x64-instalador.exe");
    assert.strictEqual(nome({ legado: true, arch: "x64", portatil: true }), undefined, "sem o arquivo: nada");
    assert.strictEqual(nome({ legado: false, arch: "ia32" }), undefined, "a versão moderna não existe em 32 bits");
    assert.strictEqual(A.escolherArquivo(s, { legado: false, arch: "x64" }).hash, "e".repeat(64));
});

test("atualizações: verificação automática devida conforme a frequência", () => {
    const dia = 24 * 3600000, agora = 100 * dia;
    assert.strictEqual(A.verificacaoDevida("semanal", 0, agora), true, "nunca verificada");
    assert.strictEqual(A.verificacaoDevida("semanal", agora - 6 * dia, agora), false);
    assert.strictEqual(A.verificacaoDevida("semanal", agora - 7 * dia, agora), true);
    assert.strictEqual(A.verificacaoDevida("diaria", agora - dia, agora), true);
    assert.strictEqual(A.verificacaoDevida("mensal", agora - 29 * dia, agora), false);
    assert.strictEqual(A.verificacaoDevida("nunca", 0, agora), false, "nunca: só manual");
    assert.strictEqual(A.verificacaoDevida("semanal", agora + dia, agora), true, "relógio voltou: verifica");
});

test("atualizações: verificar segue o redirecionamento; 403/429 e sem rede = tentar mais tarde", async () => {
    const rotas = {
        [A.URL_SOMAS]: { status: 302, local: "https://github.com/x/releases/download/v1.9.0/SHA256SUMS.txt" },
        "https://github.com/x/releases/download/v1.9.0/SHA256SUMS.txt": { corpo: SOMAS("1.9.0") }
    };
    const alvo = { legado: false, arch: "x64", portatil: false };
    const r = await A.verificar({ versaoAtual: "1.8.0", alvo, get: getFalso(rotas) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.versaoNova, "1.9.0");
    assert.strictEqual(r.arquivo.nome, "ConsultaEstoque-1.9.0-win10-11-x64-instalador.exe");
    const igual = await A.verificar({ versaoAtual: "1.9.0", alvo, get: getFalso(rotas) });
    assert.deepStrictEqual([igual.ok, igual.versaoNova], [true, null], "mesma versão: nada a fazer");
    const maior = await A.verificar({ versaoAtual: "2.0.0", alvo, get: getFalso(rotas) });
    assert.strictEqual(maior.versaoNova, null, "nunca volta para versão menor");
    for (const st of [403, 429]) {
        const x = await A.verificar({ versaoAtual: "1.8.0", alvo, get: getFalso({ [A.URL_SOMAS]: { status: st } }) });
        assert.deepStrictEqual([x.ok, x.adiar], [false, true], st + ": tentar mais tarde");
    }
    const semRede = await A.verificar({ versaoAtual: "1.8.0", alvo, get: getFalso({}) });
    assert.deepStrictEqual([semRede.ok, semRede.adiar], [false, true]);
    assert.match(semRede.erro, /Sem conexão/);
    const travado = await A.baixarTexto(A.URL_SOMAS, { get: () => { const q = new EventEmitter(); q.setTimeout = () => q; q.destroy = () => {}; return q; }, prazoMs: 200 });
    assert.strictEqual(travado.status, 0, "servidor que não responde: prazo");
    const http = await A.baixarTexto("http://inseguro/x", { get: getFalso({}) });
    assert.match(http.erro, /HTTPS/, "sem HTTPS: recusado");
});

test("atualizações: download conferido pelo SHA-256; arquivo diferente é apagado", async () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "ce-atualiz-"));
    const conteudo = Buffer.from("instalador de teste " + "x".repeat(5000));
    const nome = "ConsultaEstoque-1.9.0-win10-11-x64-instalador.exe";
    const url = A.urlArquivo("1.9.0", nome);
    const progresso = [];
    const ok = await A.baixarAtualizacao({ arquivo: { nome, versao: "1.9.0", hash: sha(conteudo) }, pasta, get: getFalso({ [url]: { corpo: conteudo } }), progresso: (b, t) => progresso.push([b, t]) });
    assert.strictEqual(ok, path.join(pasta, nome));
    assert.ok(fs.readFileSync(ok).equals(conteudo));
    assert.ok(progresso.length > 0, "andamento informado");
    await assert.rejects(
        A.baixarAtualizacao({ arquivo: { nome, versao: "1.9.0", hash: "0".repeat(64) }, pasta: path.join(pasta, "b"), get: getFalso({ [url]: { corpo: conteudo } }) }),
        /não confere/);
    assert.deepStrictEqual(fs.readdirSync(path.join(pasta, "b")), [], "nada sobra do arquivo que não confere");
    await assert.rejects(A.baixarAtualizacao({ arquivo: { nome: "..\\\\outro.exe", versao: "1.9.0", hash: sha(conteudo) }, pasta, get: getFalso({}) }), /inválido/, "nome estranho recusado");
    fs.rmSync(pasta, { recursive: true, force: true });
});

test("atualizações: instalação automática silenciosa ou com todos os detalhes; o aplicativo sempre volta a abrir", () => {
    const base = { arquivo: "C:\\Users\\Loja\\AppData\\Local\\Temp\\ConsultaEstoque-atualizacao\\ConsultaEstoque-1.9.0-win10-11-x64-instalador.exe", exeApp: "C:\\Users\\Loja\\AppData\\Local\\Programs\\Consulta Estoque\\Consulta Estoque.exe" };
    const sil = A.comandoAtualizacao(Object.assign({ modo: "silencioso" }, base));
    assert.match(sil, /start "" \/wait "[^"]+instalador\.exe" \/S --updated --force-run/, "silenciosa: sem janelas, como atualização, reabrindo");
    assert.match(sil, /& start "" "[^"]+Consulta Estoque\.exe""$/, "depois do instalador, abre o aplicativo (se a instalação falhar, a versão atual volta)");
    assert.ok(sil.indexOf("ping -n 4") < sil.indexOf("/wait"), "espera o aplicativo fechar antes do instalador");
    const det = A.comandoAtualizacao(Object.assign({ modo: "detalhado" }, base));
    assert.match(det, /\/wait "[^"]+instalador\.exe" --updated & /, "com todos os detalhes: instalador com as etapas");
    assert.ok(!/\/S/.test(det), "sem /S no modo detalhado");
    assert.strictEqual(A.comandoAtualizacao({ arquivo: "D:\\Pendrive\\ConsultaEstoque-1.9.0-win10-11-x64-portatil.exe", portatil: true }),
        "\"ping -n 4 127.0.0.1 >nul & start \"\" \"D:\\Pendrive\\ConsultaEstoque-1.9.0-win10-11-x64-portatil.exe\"\"", "portátil: abre a versão nova");
    assert.match(A.comandoAtualizacao(Object.assign({}, base)), /\/S --updated --force-run/, "sem modo: silenciosa");
    assert.throws(() => A.comandoAtualizacao({ arquivo: "C:\\100%\\x.exe", exeApp: "C:\\a.exe" }), /não suportados/);
    assert.throws(() => A.comandoAtualizacao({ arquivo: "C:\\a.exe", exeApp: "C:\\\"b.exe" }), /não suportados/);
    assert.throws(() => A.comandoAtualizacao({ arquivo: "", exeApp: "C:\\a.exe" }), /não suportados/);
});
