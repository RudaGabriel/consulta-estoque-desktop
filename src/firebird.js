"use strict";
/**
 * firebird.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Acesso ao Firebird do Small Commerce, SEMPRE em somente leitura.
 *
 * Duas travas em toda conexão aberta por este aplicativo:
 *   1. Comando: só passa SQL que começa com SELECT ou WITH; qualquer outro
 *      (UPDATE, INSERT, DELETE, EXECUTE, ALTER...) é recusado ANTES de sair.
 *   2. Transação: READ COMMITTED + REC_VERSION, somente leitura e sem espera
 *      (isc_tpb 15 + 17). A leitura nunca fica presa esperando o caixa gravar,
 *      e o próprio Firebird recusaria qualquer escrita.
 * A trava vale só para as conexões deste aplicativo: o banco NÃO é colocado em
 * modo somente leitura e o PDV continua gravando normalmente.
 *
 * Também: conexão e consulta com prazo, corte imediato do socket, teste de
 * porta TCP, decodificação de texto (UTF-8 → Windows-1252 → latin1) e
 * mensagens de erro em linguagem simples.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */

const net = require("net");
const { TextDecoder } = require("util");

const VERSAO = "1.0.0";
const SQL_LEITURA = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with)\b/i;
const ISO_REC_VERSION = [15, 17]; // isc_tpb_read_committed + isc_tpb_rec_version

// ── Texto ────────────────────────────────────────────────────────────────────
const _decUtf8 = (() => { try { return new TextDecoder("utf-8", { fatal: true }); } catch (_) { return null; } })();
const _dec1252 = (() => { try { return new TextDecoder("windows-1252"); } catch (_) { return null; } })();

/** Bytes de coluna sem charset (Small Commerce) → texto com acentos corretos. */
function decodificarTexto(buf) {
    if (!Buffer.isBuffer(buf)) return buf;
    if (_decUtf8) { try { return _decUtf8.decode(buf); } catch (_) { /* não é UTF-8 */ } }
    if (_dec1252) { try { return _dec1252.decode(buf); } catch (_) { /* segue */ } }
    return buf.toString("latin1");
}

// ── Trava de somente leitura ─────────────────────────────────────────────────
function _versaoMaiorDriver() {
    try { return parseInt(String(require("node-firebird/package.json").version).split(".")[0], 10); }
    catch (_) { return NaN; }
}

/**
 * Envolve o módulo node-firebird (ou um simulado, nos testes) para que toda
 * conexão seja somente leitura. `versaoMaior` permite forçar a versão do driver.
 */
function blindar(FB, versaoMaior) {
    if (!FB || FB.__somenteLeitura) return FB;
    const maior = versaoMaior != null ? versaoMaior : _versaoMaiorDriver();
    // Só o 0.x CONFIRMADO recebe a lista: do 1.x em diante uma lista vira
    // transação de ESCRITA com espera — versão desconhecida usa o objeto.
    const TX = maior === 0 ? ISO_REC_VERSION : { isolation: ISO_REC_VERSION, readOnly: true, wait: false };
    const recusar = (sql, cb) => {
        const cmd = String(sql || "").trim().split(/\s+/)[0] || "(vazio)";
        const e = new Error("Bloqueado: o aplicativo é somente leitura — o comando " + cmd.toUpperCase() + " não é enviado ao banco.");
        if (typeof cb === "function") setImmediate(() => cb(e));
        return e;
    };
    const blindarTx = tx => {
        ["query", "execute"].forEach(m => {
            const orig = tx[m];
            if (typeof orig !== "function") return;
            tx[m] = function (sql, params, cb) {
                if (!SQL_LEITURA.test(String(sql || ""))) return recusar(sql, typeof params === "function" ? params : cb);
                return orig.apply(tx, arguments);
            };
        });
        return tx;
    };
    const blindarDb = db => {
        if (!db || db.__somenteLeitura) return db;
        db.__somenteLeitura = true;
        const conn = db.connection;
        db.transaction = db.startTransaction = function (_ignorado, cb) {
            if (typeof _ignorado === "function") cb = _ignorado;
            conn.startTransaction(TX, (err, tx) => cb(err, tx ? blindarTx(tx) : tx));
            return db;
        };
        db.query = db.execute = function (sql, params, cb) {
            if (typeof params === "function") { cb = params; params = []; }
            if (!SQL_LEITURA.test(String(sql || ""))) return recusar(sql, cb);
            db.transaction(null, (errTx, tx) => {
                if (errTx || !tx) { if (cb) cb(errTx || new Error("transação não iniciada")); return; }
                tx.query(sql, params || [], (e, rows) => {
                    // Leitura pura: rollback encerra sem custo de commit.
                    try { tx.rollback(() => {}); } catch (_) {}
                    if (cb) cb(e || null, rows);
                });
            });
            return db;
        };
        return db;
    };
    const api = Object.create(FB);
    api.__somenteLeitura = true;
    api.__tx = TX;
    api.attach = function (opts, cb) {
        return FB.attach(opts, (err, db) => cb(err, db ? blindarDb(db) : db));
    };
    return api;
}

/** node-firebird já blindado, ou null se o módulo não carregar. */
function carregarDriver() {
    try { return blindar(require("node-firebird")); } catch (_) { return null; }
}

// ── Conexão e consulta com prazo ─────────────────────────────────────────────
/**
 * Abre o banco. alvo: { host, porta, caminho, usuario, senha, charset }.
 * Resolve com o `db` ou rejeita (erro do driver ou prazo esgotado).
 */
function conectar(FB, alvo, prazoMs) {
    return new Promise((resolve, reject) => {
        if (!FB) { reject(new Error("Módulo node-firebird indisponível.")); return; }
        const ms = prazoMs || 15000;
        let fim = false;
        const t = setTimeout(() => {
            if (fim) return;
            fim = true;
            const e = new Error("o banco não respondeu em " + Math.round(ms / 1000) + " s");
            e.codigo = "TEMPO";
            reject(e);
        }, ms);
        try {
            FB.attach({
                host: alvo.host || "127.0.0.1",
                port: Number(alvo.porta) || 3050,
                database: alvo.caminho,
                user: alvo.usuario || "SYSDBA",
                password: alvo.senha == null ? "masterkey" : alvo.senha,
                role: null,
                charset: alvo.charset || "UTF8",
                lowercase_keys: false
            }, (err, db) => {
                if (fim) { desconectar(db); return; }
                fim = true;
                clearTimeout(t);
                if (err || !db) reject(err || new Error("sem conexão com o banco"));
                else resolve(db);
            });
        } catch (e) {
            if (!fim) { fim = true; clearTimeout(t); reject(e); }
        }
    });
}

/** Consulta com prazo. Resolve com as linhas ou rejeita. */
function consultar(db, sql, params, prazoMs) {
    return new Promise((resolve, reject) => {
        const ms = prazoMs || 20000;
        let fim = false;
        const t = setTimeout(() => {
            if (fim) return;
            fim = true;
            const e = new Error("a consulta demorou mais de " + Math.round(ms / 1000) + " s");
            e.codigo = "TEMPO";
            reject(e);
        }, ms);
        try {
            db.query(sql, params || [], (e, r) => {
                if (fim) return;
                fim = true;
                clearTimeout(t);
                if (e) reject(e); else resolve(r || []);
            });
        } catch (e) {
            if (!fim) { fim = true; clearTimeout(t); reject(e); }
        }
    });
}

/** Fecha a conexão sem nunca lançar erro. */
function desconectar(db) {
    if (!db) return;
    try { db.detach(() => {}); } catch (_) {}
}

/** Corta o socket na hora (o detach normal espera a resposta do banco). */
function matarConexao(db) {
    if (!db) return;
    try {
        const c = db.connection || db._connection;
        const s = c && (c._socket || c._Socket || c.socket || c._sock);
        if (s && typeof s.destroy === "function") s.destroy();
    } catch (_) {}
    desconectar(db);
}

/** Teste de porta TCP (só abre e fecha o socket; nunca faz login). */
function portaAberta(host, porta, prazoMs) {
    return new Promise(resolve => {
        let feito = false;
        const s = new net.Socket();
        const fim = ok => {
            if (feito) return;
            feito = true;
            try { s.destroy(); } catch (_) {}
            resolve(ok);
        };
        s.setTimeout(prazoMs || 400);
        s.once("connect", () => fim(true));
        s.once("timeout", () => fim(false));
        s.once("error", () => fim(false));
        try { s.connect(Number(porta) || 3050, String(host || "127.0.0.1")); } catch (_) { fim(false); }
    });
}

// ── Erros em linguagem simples ───────────────────────────────────────────────
/**
 * Classifica um erro do Firebird/gbak: "auth" (usuário/senha), "inacessivel"
 * (servidor não responde), "arquivo" (caminho do banco errado), "tempo",
 * "bloqueado" (shutdown/uso exclusivo), "tabela" (não é banco do Small), "outro".
 */
function tipoErro(e) {
    const s = String((e && (e.message || e)) || "");
    if (e && e.codigo === "TEMPO") return "tempo";
    if (e && e.codigo === "TABELA") return "tabela";
    if (/password|user name|login|not defined as|autentica|senha/i.test(s)) return "auth";
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|unavailable database|failed to establish|network (?:error|request)|connection refused|getaddrinfo|ENOTFOUND/i.test(s)) return "inacessivel";
    if (/I\/O error|No such file|cannot find|not found|does not exist|ENOENT|CreateFile|open file|is not a valid database/i.test(s)) return "arquivo";
    if (/shutdown|lock time-?out|object .* in use|is in use/i.test(s)) return "bloqueado";
    if (/tempo esgotado|timeout|demorou|não respondeu/i.test(s)) return "tempo";
    return "outro";
}

function explicarErro(e) {
    const s = String((e && (e.message || e)) || "");
    switch (tipoErro(e)) {
        case "auth": return "Usuário ou senha do Firebird recusados. Ajuste em Configurações → Banco de dados.";
        case "inacessivel": return "O servidor do banco não respondeu (computador desligado, serviço do Firebird parado ou porta 3050 bloqueada).";
        case "arquivo": return "O arquivo do banco não foi encontrado nesse servidor (caminho do SMALL.FDB incorreto).";
        case "bloqueado": return "O banco está em manutenção ou bloqueado por outro programa.";
        case "tabela": return "O banco abriu, mas não é um banco do Small Commerce (sem a tabela de produtos).";
        case "tempo": return "O banco demorou demais para responder.";
        default:
            if (/unsupported on-disk structure|ODS|wrong version/i.test(s)) return "Versão do Firebird local incompatível com a do servidor.";
            if (/space|disk full|ENOSPC/i.test(s)) return "Disco cheio.";
            return s.slice(0, 300) || "Erro desconhecido.";
    }
}

module.exports = {
    VERSAO, SQL_LEITURA, blindar, carregarDriver, conectar, consultar, desconectar, matarConexao,
    portaAberta, decodificarTexto, tipoErro, explicarErro
};
