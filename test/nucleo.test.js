"use strict";
// Testes do núcleo: trava somente leitura, leitura da tabela, busca, configuração.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FB = require("../src/firebird.js");
const Dados = require("../src/estoque-dados.js");
const Busca = require("../src/estoque-busca.js");
const Config = require("../src/config.js");
const { criarFbFalso, bancoExemplo } = require("./fb-falso.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ced-"));

test("trava: recusa qualquer SQL que não seja SELECT/WITH antes de chegar ao banco", async () => {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo() });
    const fb = FB.blindar(falso, 2);
    const db = await FB.conectar(fb, { host: "h", caminho: "X.FDB" }, 2000);
    for (const sql of ["UPDATE ESTOQUE SET PRECO=0", "delete from estoque", "  INSERT INTO X VALUES (1)", "EXECUTE PROCEDURE P", "ALTER TABLE X", ""]) {
        await assert.rejects(FB.consultar(db, sql, [], 2000), /somente leitura/);
    }
    assert.strictEqual(falso.sql.length, 0, "nenhum comando de escrita pode sair");
    await FB.consultar(db, "/* c */ -- x\n select 1 from rdb$database", [], 2000);
    await FB.consultar(db, "WITH a AS (SELECT 1 FROM RDB$DATABASE) SELECT * FROM a", [], 2000);
    assert.strictEqual(falso.sql.length, 2);
});

test("trava: transação somente leitura, read committed + rec_version, sem espera", async () => {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo() });
    const db = await FB.conectar(FB.blindar(falso, 2), { host: "h", caminho: "X.FDB" }, 2000);
    await FB.consultar(db, "SELECT 1 FROM RDB$DATABASE", [], 2000);
    assert.deepStrictEqual(falso.transacoes[0], { isolation: [15, 17], readOnly: true, wait: false });
    const falso0 = criarFbFalso({ "h|X.FDB": bancoExemplo() });
    const db0 = await FB.conectar(FB.blindar(falso0, 0), { host: "h", caminho: "X.FDB" }, 2000);
    await FB.consultar(db0, "SELECT 1 FROM RDB$DATABASE", [], 2000);
    assert.deepStrictEqual(falso0.transacoes[0], [15, 17], "node-firebird 0.x recebe só a lista");
});

test("conexão: prazo esgotado rejeita e classifica como tempo", async () => {
    const lento = { attach() { /* nunca responde */ } };
    await assert.rejects(FB.conectar(lento, { host: "h", caminho: "x" }, 100), e => FB.tipoErro(e) === "tempo");
});

test("erros: classificação em linguagem simples", () => {
    assert.strictEqual(FB.tipoErro(new Error("connect ECONNREFUSED 10.0.0.1:3050")), "inacessivel");
    assert.strictEqual(FB.tipoErro(new Error("I/O error during \"CreateFile (open)\"")), "arquivo");
    assert.strictEqual(FB.tipoErro(new Error("Your user name and password are not defined")), "auth");
    assert.strictEqual(FB.tipoErro(Object.assign(new Error("x"), { codigo: "TABELA" })), "tabela");
    assert.match(FB.explicarErro(new Error("ECONNREFUSED")), /servidor/i);
});

test("texto: UTF-8 válido, senão Windows-1252", () => {
    assert.strictEqual(FB.decodificarTexto(Buffer.from("RAÇÃO", "utf8")), "RAÇÃO");
    assert.strictEqual(FB.decodificarTexto(Buffer.from([0x52, 0x41, 0xC7, 0xC3, 0x4F])), "RAÇÃO");
    assert.strictEqual(FB.decodificarTexto(Buffer.from([0x80])), "€");
});

test("dados: lê a tabela com acentos, papéis do Small (EAN em REFERENCIA) e ignora BLOB binário", async () => {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo() });
    const db = await FB.conectar(FB.blindar(falso, 2), { host: "h", caminho: "X.FDB" }, 2000);
    const r = await Dados.carregarTabela(db, { origem: "h:X.FDB" });
    assert.strictEqual(r.tabela, "ESTOQUE");
    assert.strictEqual(r.papeis.barras, "REFERENCIA");
    assert.strictEqual(r.papeis.referencia, null);
    assert.strictEqual(r.papeis.qtd, "QTD_ATUAL");
    assert.strictEqual(r.linhas.length, 15);
    assert.ok(!r.colunas.some(c => c.nome === "FOTO"), "BLOB binário fica fora");
    assert.strictEqual(Dados.resumo(r, 0).descricao, "RAÇÃO GATO 1KG");
    assert.strictEqual(r.inverterAtivo, true, "no Small, '0' = ativo na maioria");
    assert.strictEqual(Dados.resumo(r, 0).ativo, true);
    assert.strictEqual(Dados.resumo(r, 2).ativo, false);
    assert.ok(r.octets);
});

test("dados: Firebird que recusa OCTETS → repete sem e lê do mesmo jeito", async () => {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo({ octetsRecusa: true }) });
    const db = await FB.conectar(FB.blindar(falso, 2), { host: "h", caminho: "X.FDB" }, 2000);
    const r = await Dados.carregarTabela(db, {});
    assert.strictEqual(r.octets, false);
    assert.strictEqual(r.linhas.length, 15);
});

test("dados: banco sem a tabela de produtos → erro TABELA", async () => {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo({ semTabela: true }) });
    const db = await FB.conectar(FB.blindar(falso, 2), { host: "h", caminho: "X.FDB" }, 2000);
    await assert.rejects(Dados.carregarTabela(db, {}), e => FB.tipoErro(e) === "tabela");
    assert.strictEqual(await Dados.temTabelaProduto(db), false);
});

async function retratoExemplo() {
    const falso = criarFbFalso({ "h|X.FDB": bancoExemplo() });
    const db = await FB.conectar(FB.blindar(falso, 2), { host: "h", caminho: "X.FDB" }, 2000);
    return { r: await Dados.carregarTabela(db, { origem: "h:X.FDB" }), db, falso };
}

test("busca: sem acento, vários termos, EAN, código com zeros à esquerda, exclusão", async () => {
    const { r } = await retratoExemplo();
    const f = Dados.fonteDe(r);
    const desc = res => res.itens.map(i => i.descricao);
    assert.deepStrictEqual(desc(Busca.pesquisar(f, { q: "racao gato" }, i => Dados.resumo(r, i))), ["RAÇÃO GATO 1KG"]);
    assert.deepStrictEqual(desc(Busca.pesquisar(f, { q: "7891234567895" }, i => Dados.resumo(r, i))), ["RAÇÃO GATO 1KG"]);
    assert.strictEqual(Busca.pesquisar(f, { q: "123" }, i => Dados.resumo(r, i)).itens[0].codigo, "00123");
    assert.deepStrictEqual(desc(Busca.pesquisar(f, { q: "racao -gato" }, i => Dados.resumo(r, i))), ["RAÇÃO CÃO 15KG"]);
    assert.strictEqual(Busca.pesquisar(f, { q: "", estoque: "negativo" }, i => Dados.resumo(r, i)).total, 1);
    assert.strictEqual(Busca.pesquisar(f, { q: "", ativos: true }, i => Dados.resumo(r, i)).total, 14);
});

test("dados: disco ida e volta, achar item pelo código após recarga, CSV protegido", async () => {
    const { r } = await retratoExemplo();
    const volta = Dados.doDisco(JSON.parse(JSON.stringify(Dados.paraDisco(r))));
    assert.ok(volta && volta.doDisco);
    assert.strictEqual(volta.linhas.length, r.linhas.length);
    assert.strictEqual(volta.busca[0], r.busca[0], "índice de busca refeito igual");
    assert.strictEqual(Dados.doDisco({ formato: 99 }), null);
    assert.strictEqual(Dados.doDisco({ formato: 1, colunas: [{ nome: "A" }], papeis: {}, linhas: [[1, 2]] }), null, "linha com tamanho errado é recusada");
    assert.strictEqual(Dados.acharIndice(volta, { i: 0, versao: "outra", codigo: "00124" }), 1);
    assert.strictEqual(Dados.acharIndice(volta, { i: 99, versao: volta.versao }), -1);
    const csv = Dados.csv(r, [3]);
    assert.ok(csv.startsWith("﻿CODIGO;"));
    assert.match(csv, /;'=CMD/, "texto começando com = vira texto no Excel");
});

test("dados: lerItem relê um item ao vivo e aplicarLinha atualiza lista e busca", async () => {
    const { r, db, falso } = await retratoExemplo();
    const banco = falso;
    // muda o estoque "no banco"
    const novo = await Dados.lerItem(db, r, "00123");
    assert.ok(Array.isArray(novo));
    novo[r.idxPapel.qtd] = 99;
    assert.ok(Dados.aplicarLinha(r, 0, novo));
    assert.strictEqual(Dados.resumo(r, 0).qtd, 99);
    assert.ok(banco.sql.some(s => /WHERE "CODIGO" = \?/.test(s)));
    assert.strictEqual(await Dados.lerItem(db, r, "NAOEXISTE"), null);
});

test("config: valores inválidos voltam ao padrão, faixas respeitadas, chaves desconhecidas descartadas", () => {
    const c = Config.normalizar({ modo: "xyz", copiaACadaMin: 0, diretoRecarregarSeg: "999999", zoom: "1,5", fbHostFixo: "true", lixo: 1 });
    assert.strictEqual(c.modo, "copia");
    assert.strictEqual(c.copiaACadaMin, 1);
    assert.strictEqual(c.diretoRecarregarSeg, 3600);
    assert.strictEqual(c.zoom, 1.5);
    assert.strictEqual(c.fbHostFixo, true);
    assert.strictEqual(c.lixo, undefined);
    assert.strictEqual(Config.semSenha({ fbPass: "x" }).fbPass, "••••");
});

test("config: arquivo corrompido é guardado e o app abre com os padrões", () => {
    const d = tmp();
    const arq = path.join(d, "config.json");
    fs.writeFileSync(arq, "{ isto não é json");
    const r = Config.carregar(arq);
    assert.strictEqual(r.cfg.modo, "copia");
    assert.match(r.aviso, /corrompido/);
    assert.ok(fs.readdirSync(d).some(n => n.startsWith("config.json.corrompido-")));
    Config.salvar(arq, Object.assign(r.cfg, { fbHost: "10.0.0.5" }));
    assert.strictEqual(Config.carregar(arq).cfg.fbHost, "10.0.0.5");
    assert.strictEqual(Config.carregar(path.join(d, "nao-existe.json")).aviso, null);
});

test("admin: senha guardada só como hash (pbkdf2), conferência correta e chaves sensíveis", () => {
    const h = Config.gerarHashSenha("1234");
    assert.match(h, /^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!h.includes("1234"));
    assert.strictEqual(Config.conferirSenha("1234", h), true);
    assert.strictEqual(Config.conferirSenha("12345", h), false);
    assert.strictEqual(Config.conferirSenha("", ""), false);
    assert.strictEqual(Config.conferirSenha(null, h), false);
    assert.notStrictEqual(Config.gerarHashSenha("1234"), h, "sal diferente a cada vez");
    assert.strictEqual(Config.validarValor("senhaAdmin", "texto-qualquer"), "", "registro inválido não é aceito");
    const atual = Config.padrao();
    assert.deepStrictEqual(Config.sensiveisAlteradas(atual, { tema: "escuro", zoom: 1.2, som: false }), [], "opções visuais são públicas");
    assert.deepStrictEqual(Config.sensiveisAlteradas(atual, { persistente: false, fbHost: "X", mostrarCusto: true }).sort(), ["fbHost", "mostrarCusto", "persistente"]);
    assert.deepStrictEqual(Config.sensiveisAlteradas(atual, { persistente: true, copiaACadaMin: "180" }), [], "valor igual ao atual não conta como mudança");
    assert.strictEqual(Config.semSenha({ senhaAdmin: h }).senhaAdmin, "(definida)");
});

test("config: padrões do quiosque e da cópia (3 horas), hora do reinício diário validada", () => {
    const c = Config.padrao();
    assert.strictEqual(c.copiaACadaMin, 180);
    assert.strictEqual(c.limparAposSeg, 60);
    assert.strictEqual(c.iniciarComWindows, true);
    assert.strictEqual(c.persistente, true);
    assert.strictEqual(c.sempreNoTopo, true);
    assert.strictEqual(c.telaCheia, undefined, "tela cheia não é mais opção: é permanente");
    assert.strictEqual(Config.validarValor("reiniciarDiario", "6:30"), "06:30");
    assert.strictEqual(Config.validarValor("reiniciarDiario", "24:00"), "");
    assert.strictEqual(Config.validarValor("reiniciarDiario", "abc"), "");
});

test("busca: coringa * no mesmo campo e filtro de preço >valor / <valor (o próprio valor entra)", async () => {
    const { r } = await retratoExemplo();
    const f = Dados.fonteDe(r);
    const desc = (q, o) => Busca.pesquisar(f, Object.assign({ q }, o || {}), i => Dados.resumo(r, i)).itens.map(i => i.descricao).sort();
    assert.deepStrictEqual(desc("racao*15"), ["RAÇÃO CÃO 15KG"]);
    assert.deepStrictEqual(desc("rac*kg"), ["RAÇÃO CÃO 15KG", "RAÇÃO GATO 1KG"]);
    assert.deepStrictEqual(desc("racao*15", { coringa: false }), [], "coringa desligado: * é texto");
    assert.deepStrictEqual(desc("rac*gato", { contem: false }), ["RAÇÃO GATO 1KG"], "sem \"Contém\": o campo começa pelo padrão");
    assert.deepStrictEqual(desc("racao >100"), ["RAÇÃO CÃO 15KG"]);
    assert.deepStrictEqual(desc("racao <25,90"), ["RAÇÃO GATO 1KG"], "valor igual entra");
    assert.deepStrictEqual(desc("racao <25,89"), []);
    assert.deepStrictEqual(desc("item >=5 <6"), ["ITEM GENÉRICO 4", "ITEM GENÉRICO 5"]);
    assert.strictEqual(Busca.pesquisar(f, { q: "racao >100", preco: false }, i => i).total, 0, "preço desligado: \">100\" é texto");
    assert.strictEqual(Busca.pesquisar(f, { q: "*" }, i => i).total, 15, "só * não filtra nada");
    assert.deepStrictEqual(Busca.separarPreco("racao >1.500,00 <R$ 2000"), { texto: "racao", min: 1500, max: 2000 });
    assert.deepStrictEqual(Busca.separarPreco("cabo >50kg"), { texto: "cabo >50kg", min: null, max: null }, "valor com letras grudadas não é preço");
    assert.strictEqual(Busca.lerValor("49.90"), 49.9);
    assert.strictEqual(Busca.lerValor("1.500"), 1500);
    assert.strictEqual(Busca.lerValor("abc"), null);
});

test("config: barra de tarefas oculta por padrão (também em config antigo, uma vez só), opções novas e chaves internas", () => {
    assert.strictEqual(Config.padrao().ocultarBarraTarefas, true);
    assert.strictEqual(Config.normalizar({ ocultarBarraTarefas: false }).ocultarBarraTarefas, true, "config.json antigo: passa a ocultar");
    const novo = Config.normalizar({ ocultarBarraTarefas: false, versaoConfig: 2 });
    assert.strictEqual(novo.ocultarBarraTarefas, false, "escolha feita depois da migração é mantida");
    assert.strictEqual(Config.mesclar(novo, {}).ocultarBarraTarefas, false);
    const c = Config.padrao();
    assert.strictEqual(c.buscaCoringa, true);
    assert.strictEqual(c.buscaPreco, true);
    assert.strictEqual(c.metaBusca, "");
    assert.strictEqual(Config.validarValor("metaBusca", "nuvem"), "");
    assert.strictEqual(c.perguntarFirebird, true);
    assert.ok(Config.SENSIVEIS.includes("metaBusca") && Config.SENSIVEIS.includes("buscaCoringa"));
    assert.ok(!Config.SENSIVEIS.includes("versaoConfig") && !Config.SENSIVEIS.includes("senhaAdmin"));
});

test("config 3: instantâneo e aceleração gráfica desligada por padrão (migrados uma vez), volume do bipe público; erro de conexão agrupado legível", () => {
    const c = Config.padrao();
    assert.strictEqual(c.metodoCopia, "instantaneo");
    assert.strictEqual(c.aceleracaoGrafica, false);
    assert.strictEqual(c.volumeSom, 100);
    assert.ok(Config.PUBLICAS.includes("volumeSom"));
    const antigo = Config.normalizar({ metodoCopia: "auto", aceleracaoGrafica: true, versaoConfig: 2 });
    assert.strictEqual(antigo.metodoCopia, "instantaneo", "auto antigo vira instantâneo");
    assert.strictEqual(antigo.aceleracaoGrafica, false);
    assert.strictEqual(Config.normalizar({ metodoCopia: "gbak", versaoConfig: 2 }).metodoCopia, "gbak", "escolha explícita do gbak é mantida");
    const novo = Config.normalizar({ metodoCopia: "auto", aceleracaoGrafica: true, versaoConfig: 3 });
    assert.strictEqual(novo.metodoCopia, "auto", "depois da migração a escolha vale");
    assert.strictEqual(novo.aceleracaoGrafica, true);
    assert.strictEqual(Config.validarValor("volumeSom", 300), 100);
    const ag = new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1:3050"), { code: "ECONNREFUSED" }), Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3050"), { code: "ECONNREFUSED" })], "");
    assert.match(FB.mensagemDe(ag), /ECONNREFUSED ::1:3050 \| connect ECONNREFUSED 127\.0\.0\.1:3050/);
    assert.strictEqual(FB.tipoErro(ag), "inacessivel");
    assert.doesNotMatch(FB.explicarErro(new AggregateError([], "")), /AggregateError/);
});
