"use strict";
/**
 * motor.js
 * @version 1.6.0
 * @author Ruda Gabriel
 * @description O coração do aplicativo: mantém o estoque em memória e atualizado
 *              conforme o modo escolhido, acha o banco sozinho e responde às
 *              buscas da tela.
 *
 * Modos:
  *   - "copia" (padrão): a consulta nunca depende do
 *     banco do caixa a cada busca. Método da cópia:
 *       · "gbak": backup sem coleta de lixo + restauração somente leitura no
 *         Firebird desta máquina; o estoque é lido da cópia;
 *       · "instantaneo": uma única leitura (SELECT, somente leitura) da tabela
 *         de produtos a cada intervalo, guardada em memória e em disco;
 *       · "auto": gbak quando há gbak e Firebird nesta máquina; senão instantâneo.
 *   - "direto": lê o banco principal em somente leitura,
 *     recarrega a tabela a cada N segundos e, ao abrir um item, relê aquele item
 *     ao vivo (estoque e preço do instante).
 * Em todos: o último estoque carregado fica salvo em disco (estoque-cache.json.gz)
 * e aparece na hora ao abrir o aplicativo — inclusive sem rede.
 *
 * Auto-correção: se o banco configurado falhar (servidor fora do ar, caminho
 * errado, banco sem a tabela de produtos), procura o banco certo na máquina e na
 * rede e SOBRESCREVE a configuração (fbHostAuto=true). fbHostFixo=true desliga.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.6.0 — Sem cópia repetida: atualização pedida pelo relógio enquanto outra está em
 *           andamento é descartada (só um pedido do usuário ou uma mudança de banco
 *           refaz depois) — antes, a primeira cópia era seguida de outra na hora.
 *           status.temMinimo (o banco tem estoque mínimo preenchido?); mensagens de
 *           erro legíveis (AggregateError) e textos neutros.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const FB = require("./firebird.js");
const Dados = require("./estoque-dados.js");
const Busca = require("./estoque-busca.js");
const Config = require("./config.js");
const Localizar = require("./localizar-banco.js");
const Copia = require("./copia-gbak.js");
const InstalarFb = require("./instalar-firebird.js");

const VERSAO = "1.6.0";
const ARQ_CACHE = "estoque-cache.json.gz";
const CHAVES_CONEXAO = ["modo", "metodoCopia", "fbHost", "fbPorta", "fdbPath", "fbUser", "fbPass", "gbakPath", "pastaCopias", "copiaTimeoutMin"];

/**
 * dep: { pastaDados, arquivoConfig, log (registro.js), Firebird (blindado),
 *        aoStatus(status), aoDadosNovos(info), localizar (testes), localizarGbak (testes),
 *        versaoGbak (testes) }
 */
function criarMotor(dep) {
    const d = dep || {};
    const reg = d.log || { info() {}, aviso() {}, erro() {}, busca() {}, copia() {} };
    const Firebird = d.Firebird !== undefined ? d.Firebird : FB.carregarDriver();
    const localizarBanco = d.localizar || Localizar.localizar;
    const localizarGbak = d.localizarGbak || Copia.localizarGbak;
    const portaAberta = d.portaAberta || FB.portaAberta;
    const arqCache = path.join(d.pastaDados, ARQ_CACHE);

    let cfg = Config.carregar(d.arquivoConfig).cfg;
    let retrato = null;
    let estado = "iniciando";          // iniciando | carregando | pronto | erro
    let mensagem = "Iniciando...";
    let ultimoErro = null;
    let tipoUltimoErro = null;
    let ocupado = false;
    let ocupadoDesde = 0;
    let procurando = false;
    let metodoEfetivo = null;          // gbak | instantaneo | direto
    let gbak = "";
    let gbakProcurado = false;
    let gbakPromessa = null;           // procura em andamento (compartilhada)
    let copia = null;
    let duracaoUltimaCopia = 0;
    let falhasSeguidas = 0;
    let timer = null;
    let proximaEm = 0;
    let encerrado = false;
    let pedidoPendente = false;
    let ultimaBuscaAutomatica = 0;
    let conexaoViva = null;            // { p: Promise<db> } reaproveitada para o item ao vivo (modo direto)
    let conexaoVivaTimer = null;
    let geracao = 0;                   // invalida ciclos antigos quando a configuração muda
    let semSmall = null;
    let estimativaDisco;
    let versaoServ = { chave: "", v: null };   // versão do Firebird do servidor (por servidor+caminho)
    let versaoLoc = { gbak: "", v: null };     // versão do gbak deste computador
    let avisouVersao = "";               // duração da última cópia gbak (copia.json); undefined = não lida               // { quando, outros: [...] } — última busca sem SMALL.FDB em lugar nenhum

    // ── Status para a tela ────────────────────────────────────────────────────
    const statusAtual = () => {
        const cst = copia ? copia.status() : { emAndamento: false, etapa: "", decorridoMs: 0, estimativaMs: estimativaSalva() };
        return {
            estado, mensagem, ocupado, ocupadoDesde: ocupado ? ocupadoDesde : 0, procurando,
            modo: cfg.modo, metodoCopia: cfg.metodoCopia, metodoEfetivo: metodoEfetivo || (retrato && retrato.modo) || null,
            fonte: cfg.fdbPath ? { host: cfg.fbHost || "127.0.0.1", caminho: cfg.fdbPath } : null,
            fbHostAuto: cfg.fbHostAuto, fbHostFixo: cfg.fbHostFixo,
            itens: retrato ? retrato.linhas.length : 0,
            tabela: retrato ? retrato.tabela : null,
            carregadoEm: retrato ? retrato.carregadoEm : 0,
            dadosDoDisco: !!(retrato && retrato.doDisco),
            versaoDados: retrato ? retrato.versao : null,
            temCusto: !!(retrato && retrato.idxPapel.custo >= 0),
            proximaEm,
            erro: ultimoErro,
            temMinimo: temMinimo(),
            metaBusca: cfg.metaBusca,
            firebird: situacaoFirebird(),
            buscaSemSmall: semSmall && semSmall.outros.length ? { quando: semSmall.quando, outros: semSmall.outros.length } : null,
            copia: cst
        };
    };
    // ── Versões do Firebird (servidor × este computador) ─────────────────────
    const situacaoFirebird = () => {
        const sv = versaoServ.v, lv = versaoLoc.v;
        return {
            servidor: sv ? sv.texto : null, local: lv ? lv.texto : null,
            pacote: sv ? InstalarFb.chaveParaVersao(sv) : null,
            localMaisAntiga: !!(sv && lv && InstalarFb.localMaisAntiga(lv, sv)),
            gbak: gbak || ""
        };
    };
    /** Versão do servidor: um SELECT de uma linha (só leitura). Guardada só quando lida. */
    const lerVersaoServidor = async () => {
        if (!Firebird || !cfg.fdbPath) return versaoServ.v;
        const chave = (cfg.fbHost || "127.0.0.1") + "|" + cfg.fdbPath;
        if (versaoServ.chave === chave && versaoServ.v) return versaoServ.v;
        let db = null;
        try {
            db = await FB.conectar(Firebird, alvoPrincipal(), 8000);
            const r = await FB.consultar(db, "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE", [], 8000);
            const bruto = r && r[0] ? (r[0].V != null ? r[0].V : r[0].v) : null;
            const v = InstalarFb.lerVersao(Buffer.isBuffer(bruto) ? FB.decodificarTexto(bruto) : bruto);
            if (v) {
                versaoServ = { chave, v };
                reg.info("Firebird do servidor: " + v.texto + ".");
            }
        } catch (_) { /* servidor fora do ar ou versão antiga sem ENGINE_VERSION: segue sem saber */ }
        finally { if (db) FB.matarConexao(db); }
        return versaoServ.chave === chave ? versaoServ.v : null;
    };
    const lerVersaoLocal = async () => {
        if (!gbak) return null;
        if (versaoLoc.gbak === gbak) return versaoLoc.v;
        let v = null;
        try { v = await (d.versaoGbak || InstalarFb.versaoDoGbak)(gbak); } catch (_) {}
        versaoLoc = { gbak, v };
        if (v) reg.copia("Firebird deste computador (gbak): " + v.texto + ".");
        return v;
    };

    /** Banco/configuração mudou: a rodada em andamento é descartada e refeita logo depois. */
    const invalidar = () => { geracao++; if (ocupado) pedidoPendente = true; };

    /** O estoque tem a coluna de mínimo com algum valor acima de zero? (senão "Abaixo do mínimo" não faz sentido) */
    let minimoCache = { r: null, v: false };
    const temMinimo = () => {
        if (!retrato) return false;
        if (minimoCache.r === retrato) return minimoCache.v;
        const k = retrato.idxPapel && retrato.idxPapel.qtdMin;
        let v = false;
        if (k >= 0) for (const l of retrato.linhas) { const n = Number(l[k]); if (n > 0) { v = true; break; } }
        minimoCache = { r: retrato, v };
        return v;
    };

    /** Duração da última cópia gbak guardada no copia.json (lida uma vez; null se não houver). */
    const estimativaSalva = () => {
        if (estimativaDisco === undefined) {
            estimativaDisco = null;
            try {
                const m = JSON.parse(fs.readFileSync(path.join(cfg.pastaCopias || Copia.pastaPadrao(), "copia.json"), "utf8"));
                if (Number(m.duracaoMs) > 0) estimativaDisco = Number(m.duracaoMs);
            } catch (_) {}
        }
        return estimativaDisco;
    };
    const emitir = () => { if (typeof d.aoStatus === "function") { try { d.aoStatus(statusAtual()); } catch (_) {} } };
    const definir = (e, msg) => { estado = e; mensagem = msg; emitir(); };

    // ── Cache em disco ────────────────────────────────────────────────────────
    const lerCacheDisco = async () => {
        try {
            const buf = await fs.promises.readFile(arqCache);
            // Descompacta fora da linha principal (não segura a abertura da janela).
            const txt = await new Promise((res, rej) => zlib.gunzip(buf, (e, b) => e ? rej(e) : res(b)));
            const obj = JSON.parse(txt.toString("utf8"));
            return Dados.doDisco(obj);
        } catch (_) { return null; }
    };
    const salvarCacheDisco = async r => {
        try {
            const buf = await new Promise((res, rej) => zlib.gzip(Buffer.from(JSON.stringify(Dados.paraDisco(r))), { level: 6 }, (e, b) => e ? rej(e) : res(b)));
            const tmp = arqCache + ".tmp";
            await fs.promises.writeFile(tmp, buf);
            try { await fs.promises.rename(tmp, arqCache); }
            catch (_) { await fs.promises.writeFile(arqCache, buf); try { await fs.promises.unlink(tmp); } catch (__) {} }
        } catch (e) { reg.aviso("Não foi possível salvar o estoque em disco: " + e.message); }
    };

    const trocarRetrato = (novo, origemTxt) => {
        const anterior = retrato;
        retrato = novo;
        reg.info("Estoque carregado (" + origemTxt + "): " + novo.linhas.length + " itens da tabela " + novo.tabela +
            " (código: " + (novo.papeis.codigo || "—") + ", descrição: " + (novo.papeis.descricao || "—") + ", barras: " + (novo.papeis.barras || "—") +
            ", estoque: " + (novo.papeis.qtd || "—") + ", preço: " + (novo.papeis.preco || "—") + ").");
        if (novo.papeis.ativo && (!anterior || anterior.doDisco)) {
            reg.info("Coluna de situação " + novo.papeis.ativo + ": " + Object.keys(novo.contagemAtivo || {}).map(k => k + "=" + novo.contagemAtivo[k]).join(", ") +
                (novo.inverterAtivo ? " → lida ao contrário (a maioria daria \"inativo\")." : " → lida direto."));
        }
        if (typeof d.aoDadosNovos === "function") { try { d.aoDadosNovos({ versao: novo.versao, itens: novo.linhas.length }); } catch (_) {} }
    };

    // ── Conexões ──────────────────────────────────────────────────────────────
    const alvoPrincipal = () => ({
        host: cfg.fbHost || "127.0.0.1", porta: cfg.fbPorta, caminho: cfg.fdbPath, usuario: cfg.fbUser, senha: cfg.fbPass
    });
    const fecharConexaoViva = () => {
        if (conexaoVivaTimer) { clearTimeout(conexaoVivaTimer); conexaoVivaTimer = null; }
        if (conexaoViva) { const c = conexaoViva; conexaoViva = null; c.p.then(db => FB.desconectar(db), () => {}); }
    };
    const obterConexaoViva = async () => {
        if (!conexaoViva) conexaoViva = { p: FB.conectar(Firebird, alvoPrincipal(), 4000) };
        const c = conexaoViva;
        try { return await c.p; }
        catch (e) { if (conexaoViva === c) conexaoViva = null; throw e; }
    };

    /** Lê a tabela de um alvo e devolve o retrato. */
    const lerDe = async (alvo, origem) => {
        const db = await FB.conectar(Firebird, alvo, 15000);
        try {
            return await Dados.carregarTabela(db, { origem, octetsRecusado: retrato && retrato.octets === false, log: m => reg.info(m) });
        } catch (e) {
            FB.matarConexao(db);
            throw e;
        } finally {
            FB.desconectar(db);
        }
    };

    /** Valida host+caminho para a descoberta: abre e confere a tabela de produtos. */
    const validar = async (host, caminho) => {
        let db = null;
        try {
            db = await FB.conectar(Firebird, { host, porta: cfg.fbPorta, caminho, usuario: cfg.fbUser, senha: cfg.fbPass }, 12000);
            const ok = await Dados.temTabelaProduto(db);
            return ok ? { ok: true } : { ok: false, motivo: "o banco abriu, mas não tem a tabela de produtos" };
        } catch (e) {
            const t = FB.tipoErro(e);
            return { ok: false, auth: t === "auth", inacessivel: t === "inacessivel", motivo: FB.mensagemDe(e).slice(0, 200) };
        } finally {
            if (db) FB.matarConexao(db);
        }
    };

    // ── Método efetivo da cópia ───────────────────────────────────────────────
    /** Procura o gbak uma vez por vez (tela e ciclo pedindo juntos dividem a mesma procura). */
    const procurarGbak = () => {
        if (gbak) return Promise.resolve(gbak);
        if (!gbakPromessa) {
            gbakPromessa = Promise.resolve().then(() => localizarGbak(cfg.gbakPath)).catch(() => "")
                .then(g => { gbakPromessa = null; return g || ""; });
        }
        return gbakPromessa;
    };
    const decidirMetodo = async () => {
        if (cfg.modo === "direto") return "direto";
        if (cfg.metodoCopia === "instantaneo") return "instantaneo";
        if (!gbak && !gbakProcurado) {
            gbakProcurado = true;
            gbak = await procurarGbak();
            reg.copia(gbak ? "gbak encontrado: " + gbak : "gbak não encontrado nesta máquina.");
        }
        const fbLocal = await portaAberta("127.0.0.1", 3050, 1500).catch(() => false);
        await lerVersaoServidor();
        if (gbak && fbLocal) {
            const sv = versaoServ.v, lv = await lerVersaoLocal();
            if (sv && lv && InstalarFb.localMaisAntiga(lv, sv)) {
                const msg = "O Firebird deste computador (" + lv.texto + ") é mais antigo que o do servidor (" + sv.texto + "): a cópia gbak não funciona com ele.";
                if (cfg.metodoCopia === "gbak") { const e = new Error(msg + " Troque o Firebird deste computador ou use o método Instantâneo."); e.codigo = "GBAK"; throw e; }
                if (avisouVersao !== lv.texto + ">" + sv.texto) { avisouVersao = lv.texto + ">" + sv.texto; reg.aviso(msg + " Usando a cópia instantânea até a troca."); }
                return "instantaneo";
            }
            return "gbak";
        }
        if (cfg.metodoCopia === "gbak") {
            const e = new Error(!gbak
                ? "Método gbak escolhido, mas o gbak não foi encontrado nesta máquina (instale o Firebird ou informe o caminho do gbak.exe em Configurações)."
                : "Método gbak escolhido, mas o Firebird desta máquina não está rodando (a cópia é aberta por ele).");
            e.codigo = "GBAK";
            throw e;
        }
        return "instantaneo";
    };

    // ── Descoberta automática ─────────────────────────────────────────────────
    const buscaLiberada = () => !cfg.fbHostFixo;
    /**
     * Servidor conhecido, caminho não: procura o SMALL.FDB só NESSE servidor
     * (caminhos típicos de C: a H: e o anterior). Rápido: servidor que responde
     * recusa um caminho errado em milissegundos. Não troca o servidor.
     */
    async function procurarCaminhoNoServidor(host, motivo) {
        if (!host) return false;
        reg.busca("Procurando o caminho do SMALL.FDB no servidor " + host + (motivo ? " (" + motivo + ")" : "") + "...");
        definir(estado === "pronto" ? "pronto" : "carregando", "Procurando o SMALL.FDB no servidor " + host + "...");
        try {
            const r = await Localizar.caminhoNoServidor({ host, cfg, validar, portaAberta, log: m => reg.busca(m) });
            if (!r.achado) { reg.aviso(r.mensagem); ultimoErro = r.mensagem; return false; }
            if (cfg.fdbPath === r.achado.caminho && cfg.fbHost === host) return true;
            reg.busca("SMALL.FDB encontrado em " + host + ":" + r.achado.caminho + " — configuração atualizada automaticamente.");
            cfg = Config.mesclar(cfg, { fdbPath: r.achado.caminho });
            try { Config.salvar(d.arquivoConfig, cfg); } catch (e) { reg.erro("Falha ao salvar config.json: " + e.message); }
            return true;
        } catch (e) {
            reg.erro("Falha ao procurar o caminho no servidor: " + FB.mensagemDe(e));
            return false;
        } finally { emitir(); }
    }

    async function procurarBanco(motivo) {
        if (procurando) return false;
        procurando = true;
        ultimaBuscaAutomatica = Date.now();
        definir(estado === "pronto" ? "pronto" : "carregando", "Procurando o banco de dados" + (motivo ? " (" + motivo + ")" : "") + "...");
        reg.busca("Busca automática do banco iniciada" + (motivo ? " — motivo: " + motivo : "") + ".");
        try {
            const r = await localizarBanco({
                cfg, validar, portaAberta, log: m => { reg.busca(m); },
                cancelado: () => encerrado
            });
            if (encerrado) return false;
            if (!r.achado) {
                reg.aviso(r.mensagem);
                ultimoErro = r.mensagem;
                semSmall = { quando: Date.now(), outros: Array.isArray(r.outros) ? r.outros : [] };
                return false;
            }
            semSmall = null;
            const { host, caminho } = r.achado;
            if (cfg.fbHost === host && cfg.fdbPath === caminho) { reg.busca("O banco configurado já é o correto (" + host + ":" + caminho + ")."); return true; }
            reg.busca("Banco encontrado em " + host + ":" + caminho + " — configuração atualizada automaticamente.");
            cfg = Config.mesclar(cfg, { fbHost: host, fdbPath: caminho, fbHostAuto: true });
            try { Config.salvar(d.arquivoConfig, cfg); } catch (e) { reg.erro("Falha ao salvar config.json: " + e.message); }
            return true;
        } catch (e) {
            reg.erro("Falha na busca automática: " + FB.mensagemDe(e));
            return false;
        } finally {
            procurando = false;
            emitir();
        }
    }

    // ── Ciclo de atualização ──────────────────────────────────────────────────
    const agendar = ms => {
        if (timer) clearTimeout(timer);
        if (encerrado) return;
        proximaEm = Date.now() + ms;
        timer = setTimeout(() => { timer = null; ciclo().catch(() => {}); }, ms);
        if (timer.unref) timer.unref();
        emitir();
    };
    const intervaloNormal = () => {
        if (cfg.modo === "direto") return cfg.diretoRecarregarSeg * 1000;
        const base = cfg.copiaACadaMin * 60000;
        // Nunca ocupa o banco do caixa mais que 1/3 do tempo.
        return metodoEfetivo === "gbak" ? Math.max(base, 3 * duracaoUltimaCopia) : base;
    };
    const intervaloErro = () => Math.min(10 * 60000, 30000 * Math.pow(2, Math.max(0, falhasSeguidas - 1)));

    async function carregarUmaVez(gen) {
        metodoEfetivo = await decidirMetodo();
        if (gen !== geracao) return;
        const alvo = alvoPrincipal();
        const origem = alvo.host + ":" + alvo.caminho;
        if (metodoEfetivo === "gbak") {
            if (!copia) copia = Copia.criarCopiaGbak({ pasta: cfg.pastaCopias || Copia.pastaPadrao(), gbak, porta: 3050, usuario: cfg.fbUser, senha: cfg.fbPass, timeoutMs: cfg.copiaTimeoutMin * 60000, log: m => reg.copia(m) });
            const gerCopia = copia;
            definir(estado === "pronto" ? "pronto" : "carregando", "Fazendo a cópia do banco (gbak)...");
            const r = await gerCopia.executar(alvo);
            duracaoUltimaCopia = r.duracaoMs;
            if (gen !== geracao) return;
            const novo = await lerDe({ host: "127.0.0.1", porta: 3050, caminho: r.arquivo, usuario: cfg.fbUser, senha: cfg.fbPass }, origem);
            novo.modo = "gbak";
            if (gen !== geracao) return;
            trocarRetrato(novo, "cópia gbak de " + origem);
            gerCopia.limpar();
        } else {
            definir(estado === "pronto" ? "pronto" : "carregando", metodoEfetivo === "direto" ? "Lendo o banco (leitura direta)..." : "Lendo o estoque do banco...");
            const novo = await lerDe(alvo, origem);
            novo.modo = metodoEfetivo;
            if (gen !== geracao) return;
            trocarRetrato(novo, (metodoEfetivo === "direto" ? "leitura direta de " : "cópia instantânea de ") + origem);
        }
        await salvarCacheDisco(retrato);
    }

    /**
     * Uma atualização. Chamada pelo relógio (agendar): se já houver uma em
     * andamento, este pedido é DESCARTADO (a que está rodando já resolve) — refazer
     * na sequência fazia uma segunda cópia completa logo depois da primeira. Quem
     * precisa mesmo de outra rodada (Atualizar/F5, banco trocado) marca pedidoPendente.
     */
    async function ciclo() {
        if (encerrado) return;
        if (ocupado) return;
        ocupado = true;
        ocupadoDesde = Date.now();
        const gen = geracao;
        if (timer) { clearTimeout(timer); timer = null; }
        emitir();
        try {
            // Servidor informado sem o caminho: o caminho é procurado nele.
            if (!cfg.fdbPath && cfg.fbHost) await procurarCaminhoNoServidor(cfg.fbHost, "caminho não informado");
            if (!cfg.fdbPath) {
                if (!buscaLiberada()) throw Object.assign(new Error("Banco não configurado. Informe o servidor e o caminho do SMALL.FDB em Configurações → Banco de dados."), { codigo: "SEMCFG" });
                await procurarBanco("primeira execução");
                if (!cfg.fdbPath) throw Object.assign(new Error(ultimoErro || "Banco de dados não encontrado."), { codigo: "NAOACHOU" });
            }
            try {
                await carregarUmaVez(gen);
            } catch (e) {
                const t = FB.tipoErro(e);
                // Banco configurado com problema de LOCAL (não de senha): procura o certo e tenta de novo.
                // (busca pesada: no máximo uma a cada 5 min enquanto o erro persistir)
                const corrigivel = ["inacessivel", "arquivo", "tabela"].indexOf(t) >= 0 && !/restaura/i.test(String(e.message));
                // Servidor respondeu mas o caminho está errado: primeiro procura o
                // caminho nele mesmo (vale também com fbHostFixo — não troca o servidor).
                let resolvido = false;
                if ((t === "arquivo" || t === "tabela") && cfg.fbHost && !/restaura/i.test(String(e.message))) {
                    const antesCam = cfg.fdbPath;
                    if (await procurarCaminhoNoServidor(cfg.fbHost, "o caminho configurado falhou") && cfg.fdbPath !== antesCam) {
                        await carregarUmaVez(gen);
                        resolvido = true;
                    }
                }
                if (resolvido) { /* carregado pelo caminho achado */ }
                else if (corrigivel && buscaLiberada() && Date.now() - ultimaBuscaAutomatica > 5 * 60000) {
                    reg.aviso("O banco configurado (" + (cfg.fbHost || "127.0.0.1") + ":" + cfg.fdbPath + ") falhou: " + FB.explicarErro(e) + " Procurando o banco correto...");
                    const antes = cfg.fbHost + "|" + cfg.fdbPath;
                    if (await procurarBanco("o banco configurado falhou") && antes !== cfg.fbHost + "|" + cfg.fdbPath) {
                        await carregarUmaVez(gen);
                    } else throw e;
                } else throw e;
            }
            if (gen !== geracao) return;
            falhasSeguidas = 0;
            ultimoErro = null;
            tipoUltimoErro = null;
            definir("pronto", "Estoque atualizado.");
            agendar(intervaloNormal());
            // Banco adotado sozinho NESTA máquina (ou que não é SMALL.FDB): a meta é
            // a rede — procura o servidor em segundo plano e troca se achar.
            const ident = Localizar.identidadesDestaMaquina();
            if (buscaLiberada() && !procurando && Date.now() - ultimaBuscaAutomatica > 30 * 60000 &&
                Localizar.bancoAutoSuspeito(cfg, h => !String(h || "").trim() || Localizar.ehLocal(h) || ident.has(String(h).trim().toLowerCase()))) {
                reg.busca("O banco em uso (" + (cfg.fbHost || "127.0.0.1") + ":" + cfg.fdbPath + ") foi escolhido automaticamente e está fora da meta (" +
                    (cfg.metaBusca === "local" ? "este computador" : "a rede") + ") — procurando de novo em segundo plano...");
                const antes = cfg.fbHost + "|" + cfg.fdbPath;
                setImmediate(() => procurarBanco("banco adotado fora da meta").then(ok => {
                    if (ok && antes !== cfg.fbHost + "|" + cfg.fdbPath && !encerrado) { invalidar(); agendar(0); }
                }).catch(() => {}));
            }
        } catch (e) {
            if (gen !== geracao) return;
            falhasSeguidas++;
            tipoUltimoErro = e.codigo === "CANCELADA" ? "cancelada" : FB.tipoErro(e);
            ultimoErro = e.codigo === "CANCELADA" ? "Cópia cancelada." : (["GBAK", "SEMCFG", "NAOACHOU"].indexOf(e.codigo) >= 0 ? e.message : FB.explicarErro(e));
            reg.erro("Falha ao atualizar o estoque: " + FB.mensagemDe(e).slice(0, 400));
            if (retrato) definir("pronto", "Mostrando o estoque de " + new Date(retrato.carregadoEm).toLocaleString("pt-BR") + " — " + ultimoErro);
            else definir("erro", ultimoErro);
            agendar(e.codigo === "CANCELADA" ? Math.max(intervaloNormal(), 30 * 60000) : intervaloErro());
        } finally {
            ocupado = false;
            emitir();
            if (pedidoPendente && !encerrado) { pedidoPendente = false; setImmediate(() => ciclo().catch(() => {})); }
        }
    }

    // ── Busca ─────────────────────────────────────────────────────────────────
    /** Item que deve abrir sozinho após Enter/leitura: 1 resultado, ou 1 exato em barras/código/referência. */
    const escolherAutoAbrir = (r, res, q) => {
        if (res.length === 1) return res[0].i;
        const alvo = String(q || "").replace(/\s+/g, "").toUpperCase();
        if (!alvo) return -1;
        const soDig = /^\d+$/.test(alvo);
        const dig = s => String(s == null ? "" : s).replace(/\D+/g, "");
        let achado = -1, n = 0;
        for (const x of res) {
            const ok = ["barras", "codigo", "referencia"].some(p => {
                const k = r.idxPapel[p];
                if (k < 0) return false;
                const v = r.linhas[x.i][k];
                if (v == null || v === "") return false;
                const s = String(v).replace(/\s+/g, "").toUpperCase();
                return s === alvo || (soDig && dig(v) === alvo) || (soDig && p === "codigo" && /^\d+$/.test(s) && Number(s) === Number(alvo));
            });
            if (ok) { n++; achado = x.i; if (n > 1) return -1; }
        }
        return n === 1 ? achado : -1;
    };

    function pesquisar(p) {
        const par = p || {};
        if (!retrato) return { ok: false, semDados: true, mensagem: mensagem, itens: [], total: 0, totalItens: 0 };
        const fonte = Dados.fonteDe(retrato);
        const res = Busca.pesquisar(fonte, {
            q: String(par.q || "").slice(0, 300), estoque: ["todos", "com", "sem", "negativo", "abaixo"].indexOf(par.estoque) >= 0 ? par.estoque : "todos",
            ordem: ["", "descricao", "codigo", "qtd", "qtdAsc", "preco", "precoAsc"].indexOf(par.ordem || "") >= 0 ? (par.ordem || "") : "",
            ativos: !!par.ativos, contem: par.contem !== false, coringa: cfg.buscaCoringa, preco: cfg.buscaPreco,
            pagina: par.pagina, limite: par.limite || cfg.limitePagina
        }, i => Dados.resumo(retrato, i));
        let abrir = null;
        if (par.enter && String(par.q || "").trim()) {
            let i = escolherAutoAbrir(retrato, res._res, par.q);
            // Leitura sem resultado por causa de um filtro (ex.: "Só ativos" e o
            // produto está inativo): o produto lido aparece mesmo assim.
            if (i < 0 && res.total === 0 && (par.ativos || (par.estoque && par.estoque !== "todos") || par.contem === false)) {
                const semFiltro = Busca.pesquisar(fonte, { q: String(par.q).slice(0, 300), limite: 1, coringa: cfg.buscaCoringa, preco: cfg.buscaPreco }, () => null);
                i = escolherAutoAbrir(retrato, semFiltro._res, par.q);
                if (i >= 0) { abrir = Dados.resumo(retrato, i); abrir.foraDoFiltro = true; }
            } else if (i >= 0) abrir = Dados.resumo(retrato, i);
        }
        delete res._res;
        res.abrir = abrir;
        res.versao = retrato.versao;
        res.carregadoEm = retrato.carregadoEm;
        return res;
    }

    async function item(pedido) {
        if (!retrato) return { ok: false, mensagem: "Estoque ainda não carregado." };
        const r = retrato;
        const i = Dados.acharIndice(r, pedido);
        if (i < 0) return { ok: false, mensagem: "Item não encontrado (o estoque foi atualizado — refaça a pesquisa)." };
        const det = Dados.detalhe(r, i);
        det.aoVivo = false;
        // Modo direto: estoque e preço do instante, relidos do banco principal.
        if (cfg.modo === "direto" && cfg.diretoItemAoVivo && Firebird && cfg.fdbPath && r.idxPapel.codigo >= 0) {
            const cod = r.linhas[i][r.idxPapel.codigo];
            try {
                const db = await obterConexaoViva();
                if (conexaoVivaTimer) clearTimeout(conexaoVivaTimer);
                conexaoVivaTimer = setTimeout(fecharConexaoViva, 30000);
                if (conexaoVivaTimer.unref) conexaoVivaTimer.unref();
                const lin = await Dados.lerItem(db, r, cod);
                if (lin && retrato === r && Dados.aplicarLinha(r, i, lin)) {
                    const novo = Dados.detalhe(r, i);
                    novo.aoVivo = true;
                    return novo;
                }
            } catch (e) {
                if (conexaoViva) { const c = conexaoViva; conexaoViva = null; c.p.then(db => FB.matarConexao(db), () => {}); }
                det.avisoAoVivo = "Não foi possível reler este item ao vivo: " + FB.explicarErro(e);
            }
        }
        return det;
    }

    function exportarCsv(p) {
        if (!retrato) return null;
        const fonte = Dados.fonteDe(retrato);
        const par = p || {};
        const res = Busca.ordenar(fonte, Busca.filtrar(fonte, par.q, { estoque: par.estoque, ativos: !!par.ativos, contem: par.contem !== false, coringa: cfg.buscaCoringa, preco: cfg.buscaPreco }), String(par.ordem || ""));
        return { texto: Dados.csv(retrato, res.map(x => x.i)), linhas: res.length };
    }

    // ── Configuração ──────────────────────────────────────────────────────────
    function salvarConfig(parcial) {
        const antes = cfg;
        const p = Object.assign({}, parcial || {});
        delete p.fbHostAuto; // só o próprio aplicativo marca o endereço como "automático"
        delete p.senhaAdmin; // a senha só muda por definirSenhaAdmin
        delete p.versaoConfig;
        // Servidor trocado e caminho não mexido: o caminho será procurado no servidor novo.
        if (p.fbHost !== undefined && Config.validarValor("fbHost", p.fbHost) !== antes.fbHost &&
            (p.fdbPath === undefined || Config.validarValor("fdbPath", p.fdbPath) === antes.fdbPath)) p.fdbPath = "";
        const novo = Config.mesclar(antes, p);
        // Endereço trocado pelo usuário: vale como escolha dele (não é mais "automático").
        if (novo.fbHost !== antes.fbHost || novo.fdbPath !== antes.fdbPath) novo.fbHostAuto = false;
        cfg = novo;
        Config.salvar(d.arquivoConfig, cfg);
        reg.info("Configuração salva: " + JSON.stringify(Config.semSenha(cfg)));
        const mudouConexao = CHAVES_CONEXAO.some(k => antes[k] !== cfg[k]);
        if (mudouConexao) {
            invalidar(); // a rodada atual (se houver) é descartada e refeita com o banco novo
            if (copia) { copia.cancelar(); copia = null; }
            if (antes.gbakPath !== cfg.gbakPath) { gbak = ""; gbakProcurado = false; }
            if (antes.pastaCopias !== cfg.pastaCopias) estimativaDisco = undefined;
            fecharConexaoViva();
            falhasSeguidas = 0;
            ultimaBuscaAutomatica = 0;
            agendar(200);
        } else if (antes.metaBusca !== cfg.metaBusca) {
            // Meta trocada: sem banco, procura já; com banco adotado sozinho, confere a meta logo após o próximo ciclo.
            reg.busca("Meta da busca automática: " + (cfg.metaBusca === "local" ? "este computador primeiro." : "a rede primeiro."));
            ultimaBuscaAutomatica = 0;
            if (!cfg.fdbPath || cfg.fbHostAuto) agendar(200);
        } else if (antes.copiaACadaMin !== cfg.copiaACadaMin || antes.diretoRecarregarSeg !== cfg.diretoRecarregarSeg) {
            if (!ocupado && estado === "pronto") agendar(intervaloNormal());
        }
        emitir();
        return cfg;
    }

    return {
        VERSAO,
        async iniciar() {
            const doDisco = await lerCacheDisco();
            if (doDisco && !retrato) {
                retrato = doDisco;
                reg.info("Estoque salvo em disco carregado: " + doDisco.linhas.length + " itens de " + new Date(doDisco.carregadoEm).toLocaleString("pt-BR") + ".");
                definir("pronto", "Mostrando o estoque salvo — atualizando...");
                if (typeof d.aoDadosNovos === "function") { try { d.aoDadosNovos({ versao: doDisco.versao, itens: doDisco.linhas.length }); } catch (_) {} }
            } else {
                definir("carregando", "Carregando o estoque...");
            }
            if (!Firebird) {
                ultimoErro = "O módulo node-firebird não foi carregado — reinstale o aplicativo.";
                reg.erro(ultimoErro);
                definir(retrato ? "pronto" : "erro", ultimoErro);
                return;
            }
            // A tela abre primeiro; a atualização vem logo depois. No modo cópia, cópia
            // salva ainda no prazo (e do mesmo banco) não é refeita só porque o aplicativo abriu.
            let espera = 1500;
            if (doDisco && retrato === doDisco && cfg.modo === "copia" && cfg.fdbPath) {
                const idade = Date.now() - (Number(doDisco.carregadoEm) || 0);
                const prazo = cfg.copiaACadaMin * 60000;
                const mesmoBanco = String(doDisco.origem || "") === (cfg.fbHost || "127.0.0.1") + ":" + cfg.fdbPath;
                if (mesmoBanco && idade >= 0 && idade < prazo) {
                    espera = Math.max(espera, prazo - idade);
                    reg.info("A cópia salva tem " + Math.round(idade / 60000) + " min (prazo de " + cfg.copiaACadaMin + " min): a próxima cópia fica para " +
                        new Date(Date.now() + espera).toLocaleTimeString("pt-BR") + " (ou Atualizar/F5).");
                    definir("pronto", "Estoque salvo em dia.");
                }
            }
            agendar(espera);
            // Versões do Firebird (servidor × este computador) logo ao abrir, mesmo com a
            // cópia em dia: a tela oferece a troca se o Firebird daqui for mais antigo.
            if (cfg.modo === "copia" && cfg.metodoCopia !== "instantaneo") {
                const t = setTimeout(async () => {
                    if (encerrado || ocupado) return;
                    try {
                        await lerVersaoServidor();
                        if (!gbak) gbak = await procurarGbak();
                        await lerVersaoLocal();
                    } catch (_) {}
                    emitir();
                }, Math.min(espera + 1500, 4000));
                if (t.unref) t.unref();
            }
        },
        pesquisar,
        item,
        exportarCsv,
        status: statusAtual,
        config: () => Object.assign({}, cfg),
        /** Grava o registro (hash) da senha do administrador. */
        definirSenhaAdmin(registro) {
            cfg = Config.mesclar(cfg, {});
            cfg.senhaAdmin = Config.validarValor("senhaAdmin", registro);
            Config.salvar(d.arquivoConfig, cfg);
            reg.info(cfg.senhaAdmin ? "Senha do administrador definida." : "Senha do administrador removida.");
            return !!cfg.senhaAdmin;
        },
        salvarConfig,
        atualizarAgora() { falhasSeguidas = 0; if (ocupado) { pedidoPendente = true; return false; } agendar(0); return true; },
        async procurarAgora() {
            if (procurando) return false;
            const ok = await procurarBanco("pedido pelo usuário");
            if (ok) { invalidar(); agendar(0); }
            return ok;
        },
        cancelarCopia() { return copia ? copia.cancelar() : false; },
        /** Abre (somente leitura) cada .FDB achado na última busca sem SMALL.FDB, para o usuário escolher. */
        async outrosFdb() {
            const lista = semSmall ? semSmall.outros : [];
            if (!lista.length) return [];
            reg.busca("Testando os outros arquivos .FDB achados (" + lista.length + ")...");
            const r = await Localizar.validarOutros({ outros: lista, validar, portaAberta, porta: cfg.fbPorta });
            r.forEach(x => reg.busca((x.ok ? "Pode ser usado: " : "Não serve: ") + x.exibir + (x.ok ? " → " + x.host + ":" + x.caminho : " (" + x.motivo + ")")));
            return r;
        },
        /** Adota o banco escolhido pelo usuário (confere antes que ele abre e tem a tabela de produtos). */
        async usarBanco(escolha) {
            const e = escolha && typeof escolha === "object" ? escolha : {};
            const host = String(e.host || "").trim(), caminho = String(e.caminho || "").trim();
            if (!host || !/\.fdb$/i.test(caminho) || host.length > 255 || caminho.length > 1000) return { ok: false, mensagem: "Escolha inválida." };
            let aberta = false;
            try { aberta = await portaAberta(host, cfg.fbPorta, 2000); } catch (_) {}
            if (!aberta) return { ok: false, mensagem: "O Firebird de " + host + " não respondeu na porta " + cfg.fbPorta + "." };
            const v = await validar(host, caminho);
            if (!v.ok) return { ok: false, mensagem: "Não foi possível usar " + host + ":" + caminho + ": " + (v.motivo || "o banco não abriu") + "." };
            reg.busca("Banco escolhido pelo usuário: " + host + ":" + caminho + ".");
            semSmall = null;
            salvarConfig({ fbHost: host, fdbPath: caminho });
            return { ok: true };
        },
        /** Este computador tem Firebird (gbak ou serviço ligado na porta 3050)? */
        async firebirdLocal() {
            let ligado = false;
            try { ligado = await portaAberta("127.0.0.1", 3050, 1500); } catch (_) {}
            let gb = gbak;
            if (!gb) gb = await procurarGbak();
            return { instalado: !!(ligado || gb), ligado, gbak: gb || "" };
        },
        /** Firebird recém-instalado: esquece o gbak procurado antes e atualiza já. */
        redetectarFirebird() {
            gbak = ""; gbakProcurado = false; gbakPromessa = null; versaoLoc = { gbak: "", v: null }; avisouVersao = "";
            ultimaBuscaAutomatica = 0;
            if (!ocupado) agendar(500); else pedidoPendente = true;
        },
        encerrar() {
            encerrado = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (copia) copia.cancelar();
            fecharConexaoViva();
        },
        _interno: () => ({ retrato, cfg, gbak, metodoEfetivo, falhasSeguidas })
    };
}

module.exports = { VERSAO, criarMotor, ARQ_CACHE };
