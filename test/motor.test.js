"use strict";
// Testes do motor (modos, auto-correção, cache em disco) e da cópia por gbak.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const FB = require("../src/firebird.js");
const Config = require("../src/config.js");
const { criarMotor } = require("../src/motor.js");
const { criarCopiaGbak, RE_COPIA } = require("../src/copia-gbak.js");
const { criarFbFalso, bancoExemplo } = require("./fb-falso.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ced-motor-"));
const esperar = (cond, ms) => new Promise((res, rej) => {
    const fim = Date.now() + (ms || 5000);
    (function v() { if (cond()) return res(); if (Date.now() > fim) return rej(new Error("tempo esgotado esperando")); setTimeout(v, 20); })();
});
const logMudo = { info() {}, aviso() {}, erro() {}, busca() {}, copia() {} };

function montar(bancos, cfgInicial, extra) {
    const pasta = tmp();
    const arquivoConfig = path.join(pasta, "config.json");
    if (cfgInicial) Config.salvar(arquivoConfig, Config.normalizar(cfgInicial));
    const falso = criarFbFalso(bancos);
    const status = [];
    const motor = criarMotor(Object.assign({
        pastaDados: pasta, arquivoConfig, log: logMudo, Firebird: FB.blindar(falso, 2),
        localizarGbak: async () => "", portaAberta: async () => false,
        aoStatus: s => status.push(s)
    }, extra || {}));
    return { motor, pasta, arquivoConfig, falso, status };
}

test("motor: banco configurado → carrega, busca e auto-abre o item lido pelo leitor (Enter)", async () => {
    const { motor } = montar({ "10.0.0.5|C:\\SC\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.5", fdbPath: "C:\\SC\\SMALL.FDB" });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "pronto" && motor.status().itens === 15);
    assert.strictEqual(motor.status().metodoEfetivo, "instantaneo", "sem gbak/Firebird local, o modo cópia usa a leitura instantânea");
    const r = motor.pesquisar({ q: "7891234567895", enter: true });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.abrir.descricao, "RAÇÃO GATO 1KG");
    const r2 = motor.pesquisar({ q: "racao", enter: true });
    assert.strictEqual(r2.total, 2);
    assert.strictEqual(r2.abrir, null, "dois resultados sem correspondência exata: não abre sozinho");
    const r3 = motor.pesquisar({ q: "123", enter: true });
    assert.strictEqual(r3.abrir && r3.abrir.codigo, "00123", "código sem os zeros à esquerda abre o item");
    const r4 = motor.pesquisar({ q: "00125", enter: true, ativos: true });
    assert.strictEqual(r4.total, 0, "item inativo fica fora da lista com \"Só ativos\"");
    assert.ok(r4.abrir && r4.abrir.codigo === "00125" && r4.abrir.foraDoFiltro, "mas a leitura do código mostra o produto");
    assert.strictEqual(motor.pesquisar({ q: "naoexiste123", enter: true, ativos: true }).abrir, null);
    const det = await motor.item({ i: r.abrir.i, versao: r.abrir.versao });
    assert.ok(det.ok);
    assert.ok(det.campos.some(c => c.nome === "FORNECEDOR"));
    motor.encerrar();
});

test("motor: sem configuração → procura o banco sozinho e grava no config.json", async () => {
    let chamadas = 0;
    const { motor, arquivoConfig } = montar({ "192.168.0.9|D:\\SMALL.FDB": bancoExemplo() }, null, {
        localizar: async dep => {
            chamadas++;
            const v = await dep.validar("192.168.0.9", "D:\\SMALL.FDB");
            assert.ok(v.ok, "a validação abre o banco e confere a tabela de produtos");
            return { achado: { host: "192.168.0.9", caminho: "D:\\SMALL.FDB" }, falhas: [] };
        }
    });
    await motor.iniciar();
    await esperar(() => motor.status().itens === 15);
    assert.strictEqual(chamadas, 1);
    const c = Config.carregar(arquivoConfig).cfg;
    assert.strictEqual(c.fbHost, "192.168.0.9");
    assert.strictEqual(c.fdbPath, "D:\\SMALL.FDB");
    assert.strictEqual(c.fbHostAuto, true);
    motor.encerrar();
});

test("motor: servidor configurado errado → procura, SOBRESCREVE a configuração e carrega", async () => {
    const { motor, arquivoConfig } = montar({ "192.168.0.9|D:\\SMALL.FDB": bancoExemplo() }, { fbHost: "192.168.1.50", fdbPath: "C:\\SMALL.FDB" }, {
        localizar: async () => ({ achado: { host: "192.168.0.9", caminho: "D:\\SMALL.FDB" }, falhas: [] })
    });
    await motor.iniciar();
    await esperar(() => motor.status().itens === 15);
    assert.strictEqual(Config.carregar(arquivoConfig).cfg.fbHost, "192.168.0.9");
    motor.encerrar();
});

test("motor: fbHostFixo=true nunca troca o servidor sozinho", async () => {
    let chamadas = 0;
    const { motor } = montar({}, { fbHost: "192.168.1.50", fdbPath: "C:\\SMALL.FDB", fbHostFixo: true }, {
        localizar: async () => { chamadas++; return { achado: null, falhas: [], mensagem: "x" }; }
    });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "erro");
    assert.strictEqual(chamadas, 0);
    assert.match(motor.status().erro, /servidor/i);
    motor.encerrar();
});

test("motor: senha errada não dispara busca (o banco está certo) e mostra o motivo", async () => {
    let chamadas = 0;
    const { motor } = montar({ "10.0.0.5|C:\\SMALL.FDB": bancoExemplo({ authErro: true }) }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB" }, {
        localizar: async () => { chamadas++; return { achado: null, falhas: [] }; }
    });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "erro");
    assert.strictEqual(chamadas, 0);
    assert.match(motor.status().erro, /senha/i);
    motor.encerrar();
});

test("motor: estoque salvo em disco aparece na hora ao reabrir, mesmo com o banco fora do ar", async () => {
    const m1 = montar({ "10.0.0.5|C:\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", fbHostFixo: true });
    await m1.motor.iniciar();
    await esperar(() => m1.motor.status().itens === 15 && fs.existsSync(path.join(m1.pasta, "estoque-cache.json.gz")));
    m1.motor.encerrar();
    const falso = criarFbFalso({});
    const m2 = criarMotor({ pastaDados: m1.pasta, arquivoConfig: m1.arquivoConfig, log: logMudo, Firebird: FB.blindar(falso, 2), localizarGbak: async () => "", portaAberta: async () => false });
    await m2.iniciar();
    assert.strictEqual(m2.status().itens, 15);
    assert.strictEqual(m2.status().dadosDoDisco, true);
    assert.strictEqual(m2.pesquisar({ q: "areia" }).total, 1);
    // Cópia salva ainda no prazo (3 h) e do mesmo banco: abrir não refaz a cópia.
    await new Promise(r => setTimeout(r, 1800));
    assert.strictEqual(falso.attaches.length, 0, "abrir com a cópia em dia não toca no banco");
    assert.ok(m2.status().proximaEm - Date.now() > 60 * 60000, "próxima cópia agendada para o fim do prazo");
    m2.atualizarAgora();
    await esperar(() => m2.status().erro);
    assert.strictEqual(m2.status().estado, "pronto", "com dados salvos, uma falha não derruba a consulta");
    m2.encerrar();
});

test("motor: modo direto relê o item ao vivo ao abrir o detalhe", async () => {
    const banco = bancoExemplo();
    const { motor } = montar({ "10.0.0.5|C:\\SMALL.FDB": banco }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", modo: "direto" });
    await motor.iniciar();
    await esperar(() => motor.status().itens === 15);
    assert.strictEqual(motor.status().metodoEfetivo, "direto");
    banco.linhas[0].QTD_ATUAL = 7; // venda no caixa
    const r = motor.pesquisar({ q: "00123", enter: true });
    assert.strictEqual(r.abrir.qtd, 12, "a lista ainda mostra o valor da última leitura");
    const det = await motor.item({ i: r.abrir.i, versao: r.abrir.versao, codigo: r.abrir.codigo });
    assert.strictEqual(det.aoVivo, true);
    assert.strictEqual(det.resumo.qtd, 7);
    assert.strictEqual(motor.pesquisar({ q: "00123" }).itens[0].qtd, 7, "a lista passa a mostrar o valor ao vivo");
    motor.encerrar();
});

test("motor: trocar o modo nas configurações recarrega", async () => {
    const { motor } = montar({ "10.0.0.5|C:\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", fbHostAuto: true });
    await motor.iniciar();
    await esperar(() => motor.status().metodoEfetivo === "instantaneo" && motor.status().estado === "pronto");
    const c = motor.salvarConfig({ modo: "direto", fbHostAuto: false, campoInexistente: 1 });
    assert.strictEqual(c.fbHostAuto, true, "a tela não consegue desmarcar o automático sem trocar o endereço");
    assert.strictEqual(c.modo, "direto");
    await esperar(() => motor.status().metodoEfetivo === "direto" && motor.status().estado === "pronto");
    motor.salvarConfig({ fbHost: "10.0.0.5 " });
    assert.strictEqual(motor.config().fbHostAuto, true, "mesmo endereço (só espaço) não é troca manual");
    motor.salvarConfig({ fdbPath: "C:\\OUTRO.FDB" });
    assert.strictEqual(motor.config().fbHostAuto, false, "endereço digitado pelo usuário deixa de ser automático");
    motor.encerrar();
});

test("motor: método gbak sem gbak instalado → mensagem clara", async () => {
    const { motor } = montar({ "10.0.0.5|C:\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", metodoCopia: "gbak" });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "erro");
    assert.match(motor.status().erro, /gbak não foi encontrado/);
    motor.encerrar();
});

// ── Cópia por gbak (com gbak simulado) ──────────────────────────────────────
const MOCK = path.join(__dirname, "mock-gbak.js");

test("gbak: backup + restauração somente leitura, senha por variável de ambiente, manifesto e limpeza", async () => {
    const d = tmp();
    const origem = path.join(d, "SMALL.FDB");
    fs.writeFileSync(origem, "BANCO-1");
    const pasta = path.join(d, "copias");
    const logGbak = path.join(d, "gbak.log");
    process.env.MOCK_GBAK_LOG = logGbak;
    try {
        const c = criarCopiaGbak({ pasta, gbak: MOCK, usuario: "SYSDBA", senha: "segredo" });
        assert.strictEqual(c.status().estimativaMs, null, "primeira cópia: sem estimativa");
        const r1 = await c.executar({ host: "127.0.0.1", caminho: origem });
        const st = c.status();
        assert.ok(st.estimativaMs > 0 && st.estimativaBackupMs > 0 && st.estimativaRestauracaoMs > 0, "depois da cópia: estimativa pela duração de cada etapa");
        const man = JSON.parse(fs.readFileSync(path.join(pasta, "copia.json"), "utf8"));
        assert.strictEqual(man.duracaoBackupMs + man.duracaoRestauracaoMs, man.duracaoMs);
        assert.ok(RE_COPIA.test(path.basename(r1.arquivo)));
        assert.strictEqual(fs.readFileSync(r1.arquivo, "utf8"), "BANCO-1");
        assert.strictEqual(c.ativa(), r1.arquivo);
        const chamadas = fs.readFileSync(logGbak, "utf8").trim().split("\n").map(JSON.parse);
        assert.ok(chamadas.every(x => x.senhaPorAmbiente && !x.args.includes("segredo")), "senha nunca na linha de comando");
        assert.ok(chamadas[0].args.includes("-g") && chamadas[1].args.includes("read_only"));
        await new Promise(r => setTimeout(r, 1100));
        fs.writeFileSync(origem, "BANCO-2");
        const r2 = await c.executar({ host: "127.0.0.1", caminho: origem });
        assert.notStrictEqual(r2.arquivo, r1.arquivo);
        assert.ok(!fs.existsSync(r1.arquivo), "cópia antiga apagada");
        assert.deepStrictEqual(fs.readdirSync(pasta).sort(), [path.basename(r2.arquivo), "copia.json"].sort());
        // arquivo alheio na pasta nunca é apagado
        fs.writeFileSync(path.join(pasta, "IMPORTANTE.FDB"), "x");
        c.limpar();
        assert.ok(fs.existsSync(path.join(pasta, "IMPORTANTE.FDB")));
        // falha mantém a cópia anterior
        process.env.MOCK_GBAK_FALHAR = "backup";
        await assert.rejects(c.executar({ host: "127.0.0.1", caminho: origem }), /backup/);
        assert.strictEqual(c.ativa(), r2.arquivo);
        assert.ok(!fs.readdirSync(pasta).some(n => /\.tmp$/i.test(n)), "sem temporários esquecidos");
    } finally {
        delete process.env.MOCK_GBAK_LOG;
        delete process.env.MOCK_GBAK_FALHAR;
    }
});

test("gbak: cancelar encerra o processo e devolve CANCELADA", async () => {
    const d = tmp();
    const origem = path.join(d, "SMALL.FDB");
    fs.writeFileSync(origem, "X");
    process.env.MOCK_GBAK_ATRASO_MS = "3000";
    try {
        const c = criarCopiaGbak({ pasta: path.join(d, "copias"), gbak: MOCK });
        const p = c.executar({ host: "127.0.0.1", caminho: origem });
        await new Promise(r => setTimeout(r, 300));
        assert.strictEqual(c.cancelar(), true);
        await assert.rejects(p, e => e.codigo === "CANCELADA");
        assert.strictEqual(c.status().emAndamento, false);
    } finally { delete process.env.MOCK_GBAK_ATRASO_MS; }
});

test("motor: servidor informado sem caminho → o SMALL.FDB é procurado nesse servidor", async () => {
    let buscaGeral = 0;
    const { motor, arquivoConfig } = montar({ "10.0.0.7|D:\\DADOS\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.7", fbHostFixo: true }, {
        portaAberta: async h => h === "10.0.0.7",
        localizar: async () => { buscaGeral++; return { achado: null, falhas: [], mensagem: "x" }; }
    });
    await motor.iniciar();
    await esperar(() => motor.status().itens === 15, 8000);
    assert.strictEqual(buscaGeral, 0, "não precisou da busca geral (nem com fbHostFixo)");
    const c = Config.carregar(arquivoConfig).cfg;
    assert.strictEqual(c.fbHost, "10.0.0.7");
    assert.strictEqual(c.fdbPath.toUpperCase(), "D:\\DADOS\\SMALL.FDB");
    motor.encerrar();
});

test("motor: trocar só o servidor nas configurações apaga o caminho antigo e procura no novo", async () => {
    const { motor } = montar({
        "10.0.0.5|C:\\SMALL.FDB": bancoExemplo(),
        "10.0.0.9|E:\\BANCO\\SMALL.FDB": bancoExemplo()
    }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB" }, { portaAberta: async h => h === "10.0.0.5" || h === "10.0.0.9" });
    await motor.iniciar();
    await esperar(() => motor.status().itens === 15);
    const c = motor.salvarConfig({ fbHost: "10.0.0.9", fdbPath: "C:\\SMALL.FDB" });
    assert.strictEqual(c.fdbPath, "", "caminho antigo não vale para o servidor novo");
    await esperar(() => /10\.0\.0\.9/.test(String(motor.status().fonte && motor.status().fonte.host)) && motor.status().estado === "pronto" && motor.config().fdbPath, 8000);
    assert.match(motor.config().fdbPath, /^E:\\Banco\\SMALL\.FDB$/i);
    assert.strictEqual(motor.salvarConfig({ senhaAdmin: "pbkdf2$1$" }).senhaAdmin, "", "a senha não muda por salvarConfig");
    motor.encerrar();
});

test("motor: sem SMALL.FDB em lugar nenhum → status avisa, outros .FDB são testados e o escolhido é adotado", async () => {
    const { motor, arquivoConfig } = montar({ "SRV|C:\\DADOS\\LOJA.FDB": bancoExemplo() }, null, {
        portaAberta: async h => h === "SRV",
        localizar: async () => ({ achado: null, falhas: [], mensagem: "O SMALL.FDB não foi encontrado em lugar nenhum.",
            outros: [{ origem: "rede", host: "SRV", caminhos: ["D:\\DADOS\\LOJA.FDB", "C:\\DADOS\\LOJA.FDB"], exibir: "\\\\SRV\\DADOS\\LOJA.FDB" }] })
    });
    await motor.iniciar();
    await esperar(() => motor.status().buscaSemSmall);
    assert.strictEqual(motor.status().buscaSemSmall.outros, 1);
    const lista = await motor.outrosFdb();
    assert.deepStrictEqual(lista.map(x => [x.ok, x.host, x.caminho]), [[true, "SRV", "C:\\DADOS\\LOJA.FDB"]]);
    assert.strictEqual((await motor.usarBanco({ host: "SRV", caminho: "C:\\DADOS\\NAO.FDB" })).ok, false, "banco que não abre não é adotado");
    assert.strictEqual((await motor.usarBanco({ host: "SRV", caminho: "C:\\x.txt" })).ok, false);
    assert.strictEqual((await motor.usarBanco({ host: "SRV", caminho: "C:\\DADOS\\LOJA.FDB" })).ok, true);
    await esperar(() => motor.status().estado === "pronto" && motor.status().itens === 15);
    const cfg = Config.carregar(arquivoConfig).cfg;
    assert.strictEqual(cfg.fbHost, "SRV");
    assert.strictEqual(cfg.fdbPath, "C:\\DADOS\\LOJA.FDB");
    assert.strictEqual(cfg.fbHostAuto, false, "escolha do usuário não é trocada sozinha");
    assert.strictEqual(motor.status().buscaSemSmall, null);
    motor.encerrar();
});

test("motor: busca usa as opções de coringa e preço do config", async () => {
    const { motor } = montar({ "10.0.0.5|C:\\SC\\SMALL.FDB": bancoExemplo() }, { fbHost: "10.0.0.5", fdbPath: "C:\\SC\\SMALL.FDB" });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "pronto");
    assert.strictEqual(motor.pesquisar({ q: "racao*15" }).total, 1);
    assert.strictEqual(motor.pesquisar({ q: "racao >100" }).total, 1);
    motor.salvarConfig({ buscaCoringa: false, buscaPreco: false });
    assert.strictEqual(motor.pesquisar({ q: "racao*15" }).total, 0);
    assert.strictEqual(motor.pesquisar({ q: "racao >100" }).total, 0);
    motor.encerrar();
});

test("motor: estimativa da última cópia gbak no status, mesmo antes de copiar nesta abertura", async () => {
    const pastaCopias = tmp();
    fs.writeFileSync(path.join(pastaCopias, "copia.json"), JSON.stringify({ arquivo: "x", duracaoMs: 240000 }));
    const { motor } = montar({}, { pastaCopias });
    assert.strictEqual(motor.status().copia.estimativaMs, 240000);
    const sem = montar({}, { pastaCopias: tmp() });
    assert.strictEqual(sem.motor.status().copia.estimativaMs, null, "sem cópia anterior: sem estimativa");
    motor.encerrar(); sem.motor.encerrar();
});

test("motor: Firebird daqui mais antigo que o do servidor → leitura instantânea e aviso para trocar", async () => {
    const banco = Object.assign(bancoExemplo(), { versao: "4.0.4" });
    const { motor } = montar({ "10.0.0.5|C:\\SMALL.FDB": banco }, { fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", metodoCopia: "auto", versaoConfig: 3 }, {
        localizarGbak: async () => "C:\\Firebird_3_0\\gbak.exe",
        portaAberta: async () => true,
        versaoGbak: async () => ({ maior: 3, menor: 0, texto: "3.0.13" })
    });
    await motor.iniciar();
    await esperar(() => motor.status().estado === "pronto" && motor.status().itens === 15);
    assert.strictEqual(motor.status().metodoEfetivo, "instantaneo", "gbak mais antigo que o servidor não é usado");
    const fb = motor.status().firebird;
    assert.deepStrictEqual([fb.servidor, fb.local, fb.pacote, fb.localMaisAntiga], ["4.0.4", "3.0.13", "4.0", true]);
    motor.encerrar();
});

test("motor: pedido do relógio durante uma atualização não faz outra em seguida; Atualizar e troca de banco fazem", async () => {
    const pasta = tmp();
    const arquivoConfig = path.join(pasta, "config.json");
    Config.salvar(arquivoConfig, Config.normalizar({ fbHost: "10.0.0.5", fdbPath: "C:\\SMALL.FDB", fbHostAuto: true, versaoConfig: 3 }));
    const falso = criarFbFalso({ "10.0.0.5|C:\\SMALL.FDB": bancoExemplo() });
    // Banco "lento": cada conexão leva 300 ms.
    const lento = Object.assign({}, falso, { attach(o, cb) { setTimeout(() => falso.attach(o, cb), 300); } });
    const motor = criarMotor({ pastaDados: pasta, arquivoConfig, log: logMudo, Firebird: FB.blindar(lento, 2), localizarGbak: async () => "", portaAberta: async () => false,
        localizar: async () => ({ achado: null, falhas: [], outros: [], mensagem: "nada" }) });
    await motor.iniciar();
    await esperar(() => motor.status().ocupado, 5000);
    motor.salvarConfig({ metaBusca: "local" }); // pede uma rodada pelo relógio no meio da atual
    await esperar(() => motor.status().estado === "pronto" && !motor.status().ocupado && motor.status().itens === 15, 5000);
    await new Promise(r => setTimeout(r, 900));
    assert.strictEqual(falso.attaches.length, 1, "uma leitura só (sem repetir na sequência)");
    // Atualizar pedido pelo usuário durante uma rodada: refaz depois.
    motor.atualizarAgora();
    await esperar(() => motor.status().ocupado, 3000);
    motor.atualizarAgora();
    await esperar(() => falso.attaches.length === 3 && !motor.status().ocupado, 5000);
    motor.encerrar();
});

test("motor: seleção manual do banco → sem busca automática; com servidor e caminho informados, carrega normalmente", async () => {
    let buscas = 0;
    const loc = async () => { buscas++; return { achado: null, falhas: [], mensagem: "x" }; };
    const sem = montar({}, { metaBusca: "manual" }, { portaAberta: async () => false, localizar: loc });
    await sem.motor.iniciar();
    await esperar(() => sem.motor.status().estado === "erro", 8000);
    assert.strictEqual(buscas, 0, "nenhuma busca automática");
    assert.match(String(sem.motor.status().erro || sem.motor.status().mensagem), /Configurações → Banco de dados/);
    sem.motor.encerrar();
    const com = montar({ "10.0.0.7|D:\\DADOS\\SMALL.FDB": bancoExemplo() }, { metaBusca: "manual", fbHost: "10.0.0.7", fdbPath: "D:\\DADOS\\SMALL.FDB" },
        { portaAberta: async h => h === "10.0.0.7", localizar: loc });
    await com.motor.iniciar();
    await esperar(() => com.motor.status().itens === 15, 8000);
    assert.strictEqual(buscas, 0);
    com.motor.encerrar();
});
