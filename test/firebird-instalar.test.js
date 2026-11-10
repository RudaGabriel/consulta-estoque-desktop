"use strict";
// Testes da instalação automática do Firebird (sem baixar nem instalar nada de verdade).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const I = require("../src/instalar-firebird.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ced-fb-"));
// "Download" falso: grava um arquivo do tamanho certo.
const baixarFalso = tamanho => async (url, destino) => { fs.writeFileSync(destino, Buffer.alloc(tamanho)); return tamanho; };

test("firebird: pacote de 64 bits no Windows 64 (mesmo com o aplicativo de 32 bits) e de 32 bits no Windows 32", () => {
    assert.strictEqual(I.pacotePara("x64", {}), I.PACOTES.x64);
    assert.strictEqual(I.pacotePara("ia32", { PROCESSOR_ARCHITEW6432: "AMD64" }), I.PACOTES.x64);
    assert.strictEqual(I.pacotePara("ia32", { PROCESSOR_ARCHITECTURE: "x86" }), I.PACOTES.ia32);
    assert.ok(I.ARGS_INSTALADOR.includes("/VERYSILENT") && I.ARGS_INSTALADOR.some(a => /SYSDBAPASSWORD=masterkey/.test(a)));
});

test("firebird: arquivo que não confere é recusado; permissão negada; sucesso só com a porta 3050 ligada", async () => {
    const pac = I.PACOTES.x64;
    const etapas = [];
    const comum = { plataforma: "win32", arch: "x64", env: {}, pasta: tmp(), esperaMs: 0, etapa: t => etapas.push(t) };
    // Hash errado: nada é executado.
    let executou = false;
    const r1 = await I.instalar(Object.assign({}, comum, {
        portaAberta: async () => false, baixar: baixarFalso(pac.tamanho), sha256: async () => "0".repeat(64),
        executar: async () => { executou = true; return 0; }
    }));
    assert.strictEqual(r1.ok, false);
    assert.match(r1.mensagem, /não confere/);
    assert.strictEqual(executou, false);
    // Permissão do Windows negada.
    const r2 = await I.instalar(Object.assign({}, comum, {
        pasta: tmp(), portaAberta: async () => false, baixar: baixarFalso(pac.tamanho), sha256: async () => pac.sha256, executar: async () => 1223
    }));
    assert.strictEqual(r2.ok, false);
    assert.match(r2.mensagem, /cancelada/);
    // Sucesso: instalador roda e a porta 3050 responde depois.
    let ligado = false, args = null;
    const r3 = await I.instalar(Object.assign({}, comum, {
        pasta: tmp(), portaAberta: async () => ligado, baixar: baixarFalso(pac.tamanho), sha256: async () => pac.sha256,
        executar: async (exe, a) => { args = a; ligado = true; return 0; }
    }));
    assert.strictEqual(r3.ok, true, r3.mensagem);
    assert.deepStrictEqual(args, I.ARGS_INSTALADOR);
    assert.ok(etapas.some(t => /Baixando/.test(t)) && etapas.some(t => /permitir/.test(t)));
    // Já tem Firebird: não baixa nada.
    let baixou = false;
    const r4 = await I.instalar(Object.assign({}, comum, { portaAberta: async () => true, baixar: async () => { baixou = true; } }));
    assert.strictEqual(r4.ok, true);
    assert.strictEqual(baixou, false);
    // Fora do Windows: recusa sem tentar.
    assert.strictEqual((await I.instalar({ plataforma: "linux", portaAberta: async () => false })).ok, false);
});

test("firebird: download segue redirecionamento, recusa resposta de erro e não deixa arquivo pela metade", async () => {
    const { EventEmitter, PassThrough } = require("stream");
    const dir = tmp();
    const respostas = {
        "https://a/x": { statusCode: 302, headers: { location: "https://b/y" } },
        "https://b/y": { statusCode: 200, headers: { "content-length": "4" }, corpo: "abcd" },
        "https://c/z": { statusCode: 404, headers: {} }
    };
    const get = (url, _o, cb) => {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => {};
        setImmediate(() => {
            const r = respostas[url];
            const res = new PassThrough();
            res.statusCode = r.statusCode; res.headers = r.headers;
            cb(res);
            res.end(r.corpo || "");
        });
        return req;
    };
    const destino = path.join(dir, "fb.exe");
    assert.strictEqual(await I.baixar("https://a/x", destino, { get }), 4);
    assert.strictEqual(fs.readFileSync(destino, "utf8"), "abcd");
    await assert.rejects(I.baixar("https://c/z", path.join(dir, "erro.exe"), { get }), /404/);
    assert.ok(!fs.existsSync(path.join(dir, "erro.exe")));
});

test("firebird: versão do servidor escolhe o pacote; Firebird daqui mais antigo; troca desinstala antes, numa só permissão", async () => {
    assert.strictEqual(I.chaveParaVersao("2.1.7"), "2.5");
    assert.strictEqual(I.chaveParaVersao("2.5.9.27139"), "2.5");
    assert.strictEqual(I.chaveParaVersao("4.0.2"), "4.0");
    assert.strictEqual(I.chaveParaVersao("5.0.1"), "5.0");
    assert.strictEqual(I.chaveParaVersao("6.0.0"), null, "versão sem instalador conhecido");
    assert.strictEqual(I.localMaisAntiga("3.0.13", "4.0.6"), true);
    assert.strictEqual(I.localMaisAntiga("3.0.13", "2.5.9"), false, "local mais novo é compatível");
    assert.strictEqual(I.localMaisAntiga("2.5.9", "2.5.8"), false);
    assert.deepStrictEqual(await I.versaoDoGbak("gbak", async () => "gbak:gbak version WI-V2.5.9.27139 Firebird 2.5\ngbak: ERROR"), { maior: 2, menor: 5, texto: "2.5.9" });
    assert.strictEqual(await I.versaoDoGbak("gbak", async () => ""), null);
    Object.keys(I.VERSOES).forEach(k => assert.ok(I.argumentosInstalador(k).some(a => /DevAdminComponent/.test(a)), "gbak instalado (ferramentas de administração) na " + k));
    assert.ok(!I.argumentosInstalador("2.5").some(a => /SYSDBAPASSWORD|EnableLegacy/.test(a)), "2.5 sem opções do 3.0+");
    // Troca: baixa o pacote da versão do servidor e passa o desinstalador ao executor.
    const pasta = tmp();
    const unins = path.join(pasta, "unins000.exe");
    fs.writeFileSync(unins, "x");
    const pac = I.VERSOES["4.0"].x64;
    let url = "", recebido = null, ligado = true;
    const r = await I.instalar({
        plataforma: "win32", arch: "x64", env: {}, pasta, esperaMs: 0, versao: "4.0.4", desinstalador: unins,
        portaAberta: async () => ligado,
        baixar: async (u, destino) => { url = u; fs.writeFileSync(destino, Buffer.alloc(pac.tamanho)); },
        sha256: async () => pac.sha256,
        executar: async (exe, a, ms, des) => { recebido = des; ligado = true; return 0; }
    });
    assert.strictEqual(r.ok, true, r.mensagem);
    assert.match(url, /v4\.0\.6\/Firebird-4\.0\.6\.3221-0-x64\.exe$/);
    assert.strictEqual(recebido, unins, "desinstala o antigo na mesma permissão");
    assert.match(I.scriptTroca(unins, "fb.exe", ["/X"]), /unins000\.exe.*Test-Path.*exit 90.*fb\.exe/);
    const sem = await I.instalar({ plataforma: "win32", arch: "x64", env: {}, pasta: tmp(), versao: "6.0.0", portaAberta: async () => false });
    assert.strictEqual(sem.ok, false);
    assert.match(sem.mensagem, /mais novo/);
});
