"use strict";
// Testes da descoberta automática do banco.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../src/localizar-banco.js");

test("redes: LAN primeiro, VPN (100.64) depois, cabo direto 169.254 por último; ignora loopback", () => {
    const ifaces = {
        a: [{ family: "IPv4", address: "169.254.10.2", internal: false }],
        b: [{ family: "IPv4", address: "100.101.1.2", internal: false }],
        c: [{ family: "IPv4", address: "192.168.0.7", internal: false }, { family: "IPv6", address: "fe80::1" }],
        lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
        d: [{ family: 4, address: "10.1.2.3", internal: false }]
    };
    assert.deepStrictEqual(L.classificarRedes(ifaces), ["192.168.0", "10.1.2", "100.101.1", "169.254.10"]);
});

test(".ini do sistema: caminho com e sem servidor, com porta, e chaves de servidor", () => {
    const r = L.extrairBancosDeIni([
        "[Banco]", "Caminho=SERVIDOR01:C:\\Sistema\\Loja\\SMALL.FDB",
        "Outro=192.168.0.10/3050:D:\\Dados\\SMALL.FDB", "Local=C:\\Loja\\SMALL.FDB", "Servidor=CAIXA-01", "IP = 192.168.0.10"
    ].join("\r\n"));
    assert.deepStrictEqual(r.bancos, [
        { host: "SERVIDOR01", caminho: "C:\\Sistema\\Loja\\SMALL.FDB" },
        { host: "192.168.0.10", caminho: "D:\\Dados\\SMALL.FDB" },
        { host: null, caminho: "C:\\Loja\\SMALL.FDB" }
    ]);
    assert.deepStrictEqual(r.hosts, ["CAIXA-01", "192.168.0.10"]);
});

test("caminhos conhecidos: configurado e extras primeiro, os extras em outras unidades, sem repetição, só SMALL.FDB", () => {
    const c = L.caminhosConhecidos("D:\\Banco\\SMALL.FDB", ["d:\\banco\\small.fdb", "C:\\Loja\\padrao.fdb", "E:\\X\\SMALL.FDB"]);
    assert.strictEqual(c[0], "D:\\Banco\\SMALL.FDB");
    assert.strictEqual(c[1], "E:\\X\\SMALL.FDB");
    assert.ok(c.includes("C:\\X\\SMALL.FDB") && c.includes("H:\\X\\SMALL.FDB"), "a mesma pasta em outras unidades");
    assert.ok(c.includes("C:\\SMALL.FDB") && c.includes("F:\\Dados\\SMALL.FDB"), "caminhos genéricos");
    assert.ok(c.every(x => /\\SMALL\.FDB$/i.test(x)), "sem padrao.fdb e sem aliases");
    assert.strictEqual(new Set(c.map(x => x.toUpperCase())).size, c.length);
});

test("preferência local: SMALL.FDB antes dos outros .FDB, depois o mais recente", () => {
    const l = [
        { caminho: "H:\\Backup\\SMALL.FDB", mtime: 300 },
        { caminho: "C:\\Outro\\VENDAS.FDB", mtime: 999 },
        { caminho: "H:\\Loja\\SMALL.FDB", mtime: 100 },
        { caminho: "C:\\Atual\\SMALL.FDB", mtime: 500 }
    ].sort(L.compararLocais);
    assert.deepStrictEqual(l.map(x => x.caminho), ["C:\\Atual\\SMALL.FDB", "H:\\Backup\\SMALL.FDB", "H:\\Loja\\SMALL.FDB", "C:\\Outro\\VENDAS.FDB"]);
});

test("disco: acha .FDB, ignora bancos do Firebird e cópias de consulta, anota pastas de programa com .ini", async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "ced-disco-"));
    const sc = path.join(raiz, "Loja");
    fs.mkdirSync(sc);
    fs.writeFileSync(path.join(sc, "SMALL.FDB"), "x");
    fs.writeFileSync(path.join(sc, "config.ini"), "x");
    const prog = path.join(raiz, "Programa");
    fs.mkdirSync(prog);
    fs.writeFileSync(path.join(prog, "Programa.exe"), "x");
    fs.writeFileSync(path.join(prog, "programa.cfg"), "x");
    fs.mkdirSync(path.join(raiz, "SoIni"));
    fs.writeFileSync(path.join(raiz, "SoIni", "x.ini"), "x"); // sem programa nem banco: não é pasta de sistema
    fs.writeFileSync(path.join(raiz, "security3.fdb"), "x");
    fs.writeFileSync(path.join(raiz, "SMALL_OFFLINE_20260101_101010.FDB"), "x");
    fs.mkdirSync(path.join(raiz, "Windows"));
    fs.writeFileSync(path.join(raiz, "Windows", "Z.FDB"), "x");
    const pastasIni = [];
    const r = await L.buscarFdbLocais([raiz], { pastasIni });
    assert.deepStrictEqual(r.map(x => path.basename(x.caminho)), ["SMALL.FDB"]);
    assert.deepStrictEqual(pastasIni.slice().sort(), [sc, prog].sort());
});

test("primeiraQueAbre: pula servidor inacessível e devolve as falhas", async () => {
    const chamadas = [];
    const r = await L.primeiraQueAbre([
        { host: "A", caminho: "1" }, { host: "A", caminho: "2" }, { host: "B", caminho: "1" }, { host: "B", caminho: "2" }
    ], async (h, c) => { chamadas.push(h + c); if (h === "A") return { ok: false, inacessivel: true }; return { ok: c === "2" }; });
    assert.deepStrictEqual(r.combo, { host: "B", caminho: "2" });
    assert.deepStrictEqual(chamadas, ["A1", "B1", "B2"]);
    assert.strictEqual(r.falhas.length, 2);
});

const IFACES = { eth: [{ family: "IPv4", address: "192.168.50.20", internal: false }] };
const semDisco = {
    raizesDisco: [], lerIni: async () => ({ bancos: [], hosts: [] }),
    unidadesRede: async () => [], atalhos: async () => ({ hosts: [], pastas: [] }), identidades: new Set(["estemicro"]),
    compartilhamentos: async () => []
};

test("localizar: servidor configurado fora do ar → acha o banco em outro servidor da rede", async () => {
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { fbHost: "192.168.1.50", fdbPath: "C:\\Sistema\\Loja\\SMALL.FDB", fbPorta: 3050 },
        interfaces: IFACES,
        portaAberta: async h => h === "192.168.50.9",
        validar: async (h, c) => ({ ok: h === "192.168.50.9" && c === "D:\\Sistema\\Loja\\SMALL.FDB" })
    }));
    assert.deepStrictEqual(r.achado, { host: "192.168.50.9", caminho: "D:\\Sistema\\Loja\\SMALL.FDB" }, "a mesma pasta em outra unidade do servidor");
});

test("localizar: .ini do sistema com servidor tem prioridade sobre a rede", async () => {
    const r = await L.localizar({
        cfg: {}, interfaces: IFACES, raizesDisco: [], unidadesRede: async () => [], atalhos: async () => ({ hosts: [], pastas: [] }), identidades: new Set(),
        lerIni: async () => ({ bancos: [{ host: "SRV", caminho: "E:\\Dados\\SMALL.FDB" }], hosts: [] }),
        portaAberta: async h => h === "SRV" || h === "192.168.50.9",
        validar: async h => ({ ok: true })
    });
    assert.deepStrictEqual(r.achado, { host: "SRV", caminho: "E:\\Dados\\SMALL.FDB" });
});

test("localizar: IP da própria máquina é tratado como local (127.0.0.1)", async () => {
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { fbHost: "192.168.50.20", fdbPath: "C:\\Loja\\SMALL.FDB" }, interfaces: IFACES,
        portaAberta: async h => h === "127.0.0.1",
        validar: async (h, c) => ({ ok: h === "127.0.0.1" && c === "C:\\Loja\\SMALL.FDB" })
    }));
    assert.deepStrictEqual(r.achado, { host: "127.0.0.1", caminho: "C:\\Loja\\SMALL.FDB" });
});

test("localizar: senha errada vira mensagem clara; nada achado vira diagnóstico", async () => {
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { fbHost: "192.168.50.9" }, interfaces: IFACES,
        portaAberta: async h => h === "192.168.50.9",
        validar: async () => ({ ok: false, auth: true, motivo: "login" })
    }));
    assert.strictEqual(r.achado, null);
    assert.match(r.mensagem, /usuário\/senha/);
    const r2 = await L.localizar(Object.assign({}, semDisco, {
        cfg: { fbHost: "192.168.1.50", varrerRede: false }, interfaces: IFACES,
        portaAberta: async () => false, validar: async () => ({ ok: false })
    }));
    assert.match(r2.mensagem, /192\.168\.1\.50 não respondeu/);
});

test("localizar: REDE PRIMEIRO — com Firebird local ligado, o servidor da rede vence", async () => {
    const testados = [];
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { fbHost: "192.168.1.80", fdbPath: "C:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB" }, interfaces: IFACES,
        portaAberta: async h => h === "127.0.0.1" || h === "SERVIDOR",
        validar: async (h, c) => { testados.push(h); return { ok: h === "127.0.0.1" || /Sistema\\Loja\\SMALL\.FDB$/i.test(c) }; }
    }));
    assert.deepStrictEqual(r.achado, { host: "SERVIDOR", caminho: "C:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB" });
    assert.ok(!testados.includes("127.0.0.1"), "o banco local nem é testado quando a rede tem o banco");
});

test("localizar: local só como última opção, e nunca um arquivo que não seja SMALL.FDB", async () => {
    const testados = [];
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: {}, interfaces: IFACES,
        lerIni: async () => ({ bancos: [{ host: null, caminho: "C:\\Loja\\padrao.fdb" }, { host: null, caminho: "C:\\Loja\\SMALL.FDB" }], hosts: [] }),
        portaAberta: async h => h === "127.0.0.1",
        validar: async (h, c) => { testados.push(c); return { ok: true }; }
    }));
    assert.deepStrictEqual(r.achado, { host: "127.0.0.1", caminho: "C:\\Loja\\SMALL.FDB" });
    assert.ok(!testados.some(c => /padrao/i.test(c)));
    assert.match(r.mensagem, /neste computador/);
});

test("localizar: unidade mapeada → servidor pelo NOME, e .ini do compartilhamento aponta o disco dele", async () => {
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { varrerRede: false }, interfaces: IFACES,
        unidadesRede: async () => [{ letra: "H:", unc: "\\\\loja-srv\\Sistema" }],
        compartilhamentos: async h => h === "loja-srv" ? ["\\\\loja-srv\\Sistema", "\\\\loja-srv\\Loja"] : [],
        lerIni: async (pastas, log, hostDaPasta) => {
            assert.ok(pastas.includes("\\\\loja-srv\\Sistema") && pastas.includes("H:\\"), "lê o .ini na unidade mapeada");
            assert.ok(pastas.includes("\\\\loja-srv\\Loja"), "e nas pastas compartilhadas listadas pelo servidor");
            return { bancos: [{ host: null, caminho: "D:\\Banco\\SMALL.FDB", origemHost: hostDaPasta("H:\\Sistema") }], hosts: [] };
        },
        portaAberta: async h => h === "loja-srv",
        validar: async (h, c) => ({ ok: h === "loja-srv" && c === "D:\\Banco\\SMALL.FDB" })
    }));
    assert.deepStrictEqual(r.achado, { host: "loja-srv", caminho: "D:\\Banco\\SMALL.FDB" });
});

test("pistas: SMALL.FDB, UNC e atalho .lnk", () => {
    assert.ok(L.ehArquivoSmall("C:\\x\\small.fdb") && !L.ehArquivoSmall("C:\\x\\padrao.fdb") && !L.ehArquivoSmall("SMALL_OFFLINE_1.FDB"));
    assert.strictEqual(L.hostDeUnc("\\\\servidor\\Sistema"), "servidor");
    const alvo = "\\\\servidor\\Sistema\\Loja\\Programa.exe";
    const r = L.extrairUncDeAtalho(Buffer.concat([Buffer.from([0x4c, 0]), Buffer.from(alvo + "\0", "utf16le")]));
    assert.deepStrictEqual(r, { hosts: ["servidor"], pastas: ["\\\\servidor\\Sistema\\Loja"] });
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: true, fbHost: "127.0.0.1", fdbPath: "C:\\SMALL.FDB" }), true);
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: false, fbHost: "127.0.0.1", fdbPath: "C:\\x.fdb" }), false);
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: true, fbHost: "SERVIDOR", fdbPath: "C:\\x\\SMALL.FDB" }), false, "servidor da rede com SMALL.FDB não é suspeito");
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: true, fbHost: "SERVIDOR", fdbPath: "C:\\x\\padrao.fdb" }), true);
});

test("caminhoNoServidor: acha o SMALL.FDB no servidor informado, sem trocar o servidor", async () => {
    const testados = [];
    const r = await L.caminhoNoServidor({
        host: "SERVIDOR", cfg: { fdbPath: "" }, compartilhamentos: async () => [],
        portaAberta: async h => h === "SERVIDOR",
        validar: async (h, c) => { testados.push(h); return { ok: c === "D:\\Dados\\SMALL.FDB" }; }
    });
    assert.deepStrictEqual(r.achado, { host: "SERVIDOR", caminho: "D:\\Dados\\SMALL.FDB" });
    assert.ok(testados.every(h => h === "SERVIDOR"));
    const fora = await L.caminhoNoServidor({ host: "OUTRO", cfg: {}, portaAberta: async () => false, validar: async () => ({ ok: true }) });
    assert.strictEqual(fora.achado, null);
    assert.match(fora.mensagem, /não respondeu/);
    const auth = await L.caminhoNoServidor({ host: "S", cfg: {}, portaAberta: async () => true, validar: async () => ({ ok: false, auth: true }) });
    assert.match(auth.mensagem, /usuário\/senha/);
});

test("compartilhamento: UNC vira o caminho no disco do servidor; C$ dá o caminho exato", () => {
    assert.deepStrictEqual(L.partesDeUnc("\\\\SERVIDOR\\Sistema\\Loja\\SMALL.FDB"),
        { host: "SERVIDOR", compart: "Sistema", resto: "\\Loja\\SMALL.FDB" });
    assert.strictEqual(L.partesDeUnc("C:\\Sistema\\SMALL.FDB"), null, "caminho local não é UNC");
    assert.strictEqual(L.partesDeUnc("\\\\SERVIDOR"), null, "sem compartilhamento");
    // A pasta com o nome do compartilhamento na estrutura deste computador vem primeiro.
    const c = L.caminhosDoCompartilhamento("\\\\SERVIDOR\\Loja\\SMALL.FDB", false, ["D:\\Outra", "C:\\Program Files (x86)\\Sistema\\Loja"]);
    assert.strictEqual(c[0], "C:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB");
    assert.ok(c.includes("D:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB"), "a mesma estrutura em outras unidades");
    assert.ok(c.includes("D:\\Loja\\SMALL.FDB") && c.includes("C:\\SMALL.FDB") && c.includes("E:\\Program Files\\Loja\\SMALL.FDB"));
    assert.strictEqual(L.caminhosDoCompartilhamento("\\\\SERVIDOR\\Loja\\SMALL.FDB")[0], "C:\\Loja\\SMALL.FDB", "sem estrutura: a pasta na raiz");
    assert.deepStrictEqual(L.paisDoNome("loja", ["C:\\A\\Loja\\Dados", "E:\\Loja", "lixo", null, "\\\\srv\\Loja"]), ["\\A", ""]);
    assert.deepStrictEqual(L.paisDoNome("", ["C:\\Loja"]), []);
    assert.ok(c.every(x => /^[C-H]:\\/.test(x) && /\\SMALL\.FDB$/.test(x)), "nunca um caminho de rede");
    assert.strictEqual(new Set(c.map(x => x.toUpperCase())).size, c.length);
    assert.deepStrictEqual(L.caminhosDoCompartilhamento("\\\\SERVIDOR\\d$\\Banco\\SMALL.FDB"), ["D:\\Banco\\SMALL.FDB"]);
    assert.deepStrictEqual(L.caminhosDoCompartilhamento("\\\\SERVIDOR\\Dados\\padrao.fdb"), [], "só SMALL.FDB");
});

// Pastas falsas da rede para buscarFdbNaRede (o arquivo nunca é aberto, só listado).
function pastaFalsa(mapa, lidas) {
    const ent = (name, dir) => ({ name, isFile: () => !dir, isDirectory: () => dir });
    return async p => {
        lidas.push(p);
        const v = mapa[p.toUpperCase()];
        if (v === "trava") return new Promise(() => {});
        if (!v) throw new Error("ENOENT");
        return v.map(x => x.endsWith("\\") ? ent(x.slice(0, -1), true) : ent(x, false));
    };
}

test("rede: acha o SMALL.FDB na pasta compartilhada, pula servidor fora do ar e pasta travada", async () => {
    const lidas = [];
    const lerPasta = pastaFalsa({
        "\\\\SERVIDOR\\SISTEMA": ["Loja\\", "Lixo\\", "leiame.txt"],
        "\\\\SERVIDOR\\SISTEMA\\LOJA": ["padrao.fdb", "SMALL.FDB", "Programa.exe"],
        "\\\\SERVIDOR\\SISTEMA\\LIXO": "trava"
    }, lidas);
    const inicio = Date.now();
    const r = await L.buscarFdbNaRede(["\\\\DESLIGADO\\Sistema", "\\\\SERVIDOR\\Sistema\\", "C:\\local"], {
        lerPasta, prazoPastaMs: 200, hostAcessivel: async h => h === "SERVIDOR"
    });
    assert.deepStrictEqual(r, ["\\\\SERVIDOR\\Sistema\\Loja\\SMALL.FDB"]);
    assert.ok(!lidas.some(p => /DESLIGADO/i.test(p)), "servidor sem a porta 445 nem é tocado");
    assert.ok(!lidas.some(p => /^C:/i.test(p)), "caminho local não entra na busca da rede");
    assert.ok(Date.now() - inicio < 3000, "pasta travada não segura a busca");
});

test("localizar: SMALL.FDB da pasta compartilhada é aberto pelo Firebird do servidor, nunca pela pasta", async () => {
    const testados = [];
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { varrerRede: false }, interfaces: IFACES,
        buscarRede: async () => ["\\\\loja-srv\\Dados\\SMALL.FDB", "\\\\estemicro\\x\\SMALL.FDB"],
        portaAberta: async h => h === "loja-srv",
        validar: async (h, c) => { testados.push(h + "|" + c); return { ok: h === "loja-srv" && c === "E:\\Dados\\SMALL.FDB" }; }
    }));
    assert.deepStrictEqual(r.achado, { host: "loja-srv", caminho: "E:\\Dados\\SMALL.FDB" });
    assert.ok(testados.every(t => !t.includes("\\\\")), "nenhum caminho de rede chega ao Firebird");
    assert.ok(!testados.some(t => /^estemicro\|/i.test(t)), "compartilhamento desta máquina não vira servidor");
});

test("caminhoNoServidor: usa o SMALL.FDB achado nas pastas que esse servidor compartilha", async () => {
    let pastas = null;
    const r = await L.caminhoNoServidor({
        host: "SERVIDOR", cfg: {},
        compartilhamentos: async h => ["\\\\" + h + "\\Sistema"],
        buscarRede: async p => { pastas = p; return ["\\\\SERVIDOR\\Sistema\\Banco Novo\\SMALL.FDB"]; },
        portaAberta: async () => true,
        validar: async (h, c) => ({ ok: c === "F:\\Sistema\\Banco Novo\\SMALL.FDB" })
    });
    assert.deepStrictEqual(r.achado, { host: "SERVIDOR", caminho: "F:\\Sistema\\Banco Novo\\SMALL.FDB" });
    assert.deepStrictEqual(pastas, ["\\\\SERVIDOR\\Sistema"], "só as pastas desse servidor");
    // Com a estrutura deste computador, o caminho certo é o primeiro testado.
    const testados = [];
    const r2 = await L.caminhoNoServidor({
        host: "SRV", cfg: {}, estrutura: ["C:\\Program Files (x86)\\Sistema\\Loja"],
        compartilhamentos: async () => ["\\\\SRV\\Loja"], buscarRede: async () => ["\\\\SRV\\Loja\\SMALL.FDB"],
        portaAberta: async () => true,
        validar: async (h, c) => { testados.push(c); return { ok: c === "C:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB" }; }
    });
    assert.strictEqual(r2.achado.caminho, "C:\\Program Files (x86)\\Sistema\\Loja\\SMALL.FDB");
    assert.strictEqual(testados.length, 1);
    // Servidor sem a porta 445: nem lista as pastas compartilhadas.
    let listou = false;
    await L.caminhoNoServidor({ host: "S2", cfg: {}, compartilhamentos: async () => { listou = true; return []; },
        portaAberta: async (h, p) => p !== 445, validar: async () => ({ ok: false }) });
    assert.strictEqual(listou, false);
});

test("localizar: meta \"local\" testa este computador primeiro; meta \"rede\" deixa por último", async () => {
    const base = {
        interfaces: IFACES, raizesDisco: [], unidadesRede: async () => [], atalhos: async () => ({ hosts: [], pastas: [] }), identidades: new Set(),
        lerIni: async () => ({ bancos: [{ host: null, caminho: "C:\\Loja\\SMALL.FDB" }], hosts: [] }), buscarRede: async () => [], compartilhamentos: async () => [],
        portaAberta: async h => h === "127.0.0.1" || h === "SERVIDOR",
        validar: async (h, c) => ({ ok: /^C:\\Loja\\SMALL\.FDB$/i.test(c) })
    };
    const local = await L.localizar(Object.assign({}, base, { cfg: { metaBusca: "local", varrerRede: false } }));
    assert.strictEqual(local.achado.host, "127.0.0.1");
    assert.strictEqual(local.meta, "local");
    const rede = await L.localizar(Object.assign({}, base, { cfg: { metaBusca: "rede", varrerRede: false } }));
    assert.strictEqual(rede.achado.host, "SERVIDOR");
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: true, metaBusca: "local", fbHost: "SERVIDOR", fdbPath: "C:\\SMALL.FDB" }), true, "rede adotada com meta local");
    assert.strictEqual(L.bancoAutoSuspeito({ fbHostAuto: true, metaBusca: "local", fbHost: "127.0.0.1", fdbPath: "C:\\SMALL.FDB" }), false);
});

test("localizar: sem SMALL.FDB em lugar nenhum → mensagem de varredura completa e os outros .FDB para escolher", async () => {
    let compartilhamentosPedidos = [];
    const r = await L.localizar(Object.assign({}, semDisco, {
        cfg: { varrerRede: false }, interfaces: IFACES,
        buscarDisco: async (raizes, o) => { o.outros.push("D:\\Antigo\\LOJA.FDB"); return []; },
        lerIni: async () => ({ bancos: [{ host: "SERVIDOR", caminho: "C:\\Dados\\BANCO.FDB" }, { host: null, caminho: "C:\\x\\security3.fdb" }], hosts: [] }),
        compartilhamentos: async h => { compartilhamentosPedidos.push(h); return ["\\\\" + h + "\\Dados"]; },
        buscarRede: async (pastas, o) => {
            assert.ok(pastas.includes("\\\\SERVIDOR\\Dados"), "pastas listadas pelo servidor entram na busca");
            o.outros.push("\\\\SERVIDOR\\Dados\\EMPRESA.FDB");
            return [];
        },
        portaAberta: async h => h === "SERVIDOR",
        validar: async () => ({ ok: false, motivo: "não existe" })
    }));
    assert.strictEqual(r.achado, null);
    assert.match(r.mensagem, /não foi encontrado em lugar nenhum/);
    assert.match(r.mensagem, /3 outro/);
    assert.deepStrictEqual(compartilhamentosPedidos, ["SERVIDOR"]);
    assert.deepStrictEqual(r.outros.map(o => o.origem), ["config", "rede", "disco"]);
    assert.ok(!r.outros.some(o => /security/i.test(o.exibir)), "bancos do próprio Firebird ficam de fora");
    assert.ok(r.outros[1].caminhos.includes("C:\\Program Files (x86)\\Dados\\EMPRESA.FDB"));
    const v = await L.validarOutros({
        outros: r.outros, portaAberta: async h => h === "SERVIDOR",
        validar: async (h, c) => c === "C:\\Dados\\BANCO.FDB" ? { ok: true } : c === "D:\\Dados\\EMPRESA.FDB" ? { ok: false, motivo: "o banco abriu, mas não tem a tabela de produtos" } : { ok: false, motivo: "I/O error" }
    });
    assert.deepStrictEqual(v.map(x => x.ok), [true, false, false]);
    assert.strictEqual(v[0].caminho, "C:\\Dados\\BANCO.FDB");
    assert.match(v[1].motivo, /tabela de produtos/);
    assert.match(v[2].motivo, /não tem o Firebird ligado/);
});

test("rede: nomes dos compartilhamentos no \"net view\" (português e inglês) e outros .FDB na pasta", async () => {
    const pt = [
        "Recursos compartilhados em \\\\SERVIDOR", "", "Nome do compartilhamento  Tipo  Usado como  Comentário", "",
        "-------------------------------------------------------------------------------",
        "ADMIN$                    Disco             Administração remota", "C$                        Disco             Recurso compartilhado padrão",
        "IPC$                      IPC               IPC remoto", "Sistema                   Disco", "Impressora                Impressão", "Dados                     Disco",
        "Comando concluído com êxito.", ""
    ].join("\r\n");
    assert.deepStrictEqual(L.extrairCompartilhamentos(pt), ["C$", "Sistema", "Dados"]);
    assert.deepStrictEqual(L.extrairCompartilhamentos("Share name  Type  Used as  Comment\n\n------------------------------------\nDados       Disk\nThe command completed successfully.\n"), ["Dados"]);
    assert.deepStrictEqual(L.extrairCompartilhamentos("Erro de sistema 53."), []);
    const outros = [];
    const r = await L.buscarFdbNaRede(["\\\\SRV\\Dados"], {
        outros, hostAcessivel: async () => true,
        lerPasta: async () => [{ name: "LOJA.FDB", isFile: () => true, isDirectory: () => false }, { name: "employee.fdb", isFile: () => true, isDirectory: () => false }]
    });
    assert.deepStrictEqual(r, []);
    assert.deepStrictEqual(outros, ["\\\\SRV\\Dados\\LOJA.FDB"]);
});
