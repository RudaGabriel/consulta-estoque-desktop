"use strict";
/**
 * config.js
 * @version 1.4.0
 * @author Ruda Gabriel
 * @description Configuração do aplicativo (config.json na pasta de dados):
 *              valores padrão, validação de cada chave e gravação atômica.
 *
 * Qualquer valor inválido ou fora da faixa volta ao padrão — o aplicativo
 * nunca deixa de abrir por causa de um config.json estragado (o arquivo
 * ilegível é guardado como config.json.corrompido-AAAAMMDD-HHMMSS).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.4.0 — Padrões novos: leitura instantânea (metodoCopia "instantaneo"), aceleração
 *           gráfica desligada e volumeSom (volume do bipe, 10 a 100%, público).
 *           config.json antigo (versaoConfig < 3) migra uma vez: "auto" vira
 *           "instantaneo" e a aceleração gráfica é desligada.
 */

const fs = require("fs");
const path = require("path");

const VERSAO = "1.4.0";
// Versão do formato do config.json (migrações feitas uma vez só).
const VERSAO_CONFIG = 3;

// [padrão, tipo, mínimo, máximo] ou [padrão, lista de valores aceitos].
const ESQUEMA = {
    // Leitura do banco
    modo:                ["copia", ["copia", "direto"]],
    metodoCopia:         ["instantaneo", ["auto", "gbak", "instantaneo"]],
    copiaACadaMin:       [180, "int", 1, 1440],
    copiaTimeoutMin:     [30, "int", 1, 360],
    diretoRecarregarSeg: [60, "int", 15, 3600],
    diretoItemAoVivo:    [true, "bool"],
    // Banco de dados
    fbHost:              ["", "texto"],
    fbPorta:             [3050, "int", 1, 65535],
    fdbPath:             ["", "texto"],
    fbUser:              ["SYSDBA", "texto"],
    fbPass:              ["masterkey", "senha"],
    fbHostFixo:          [false, "bool"],
    fbHostAuto:          [false, "bool"],
    varrerRede:          [true, "bool"],
    metaBusca:           ["", ["", "rede", "local"]],   // "" = ainda não perguntado (vale "rede")
    perguntarFirebird:   [true, "bool"],
    gbakPath:            ["", "texto"],
    pastaCopias:         ["", "texto"],
    // Windows (quiosque)
    iniciarComWindows:   [true, "bool"],
    persistente:         [true, "bool"],
    sempreNoTopo:        [true, "bool"],
    manterFoco:          [true, "bool"],
    impedirDescanso:     [true, "bool"],
    ocultarBarraTarefas: [true, "bool"],
    ocultarCursor:       [false, "bool"],
    reiniciarDiario:     ["", "hora"],
    monitor:             [0, "int", 0, 9],
    aceleracaoGrafica:   [false, "bool"],
    // Tela
    tema:                ["auto", ["auto", "claro", "escuro"]],
    modoLeve:            [false, "bool"],
    som:                 [true, "bool"],
    volumeSom:           [100, "int", 10, 100],
    zoom:                [1, "num", 0.6, 2.5],
    limparAposSeg:       [60, "int", 0, 3600],
    mostrarCusto:        [false, "bool"],
    limitePagina:        [100, "int", 20, 1000],
    nomeLoja:            ["", "texto"],
    tabComoEnter:        [true, "bool"],
    // Busca
    buscaCoringa:        [true, "bool"],
    buscaPreco:          [true, "bool"],
    // Administrador: "pbkdf2$iteracoes$sal$hash" (nunca a senha em texto)
    senhaAdmin:          ["", "hash"],
    configInicial:       [false, "bool"],     // primeira abertura já configurada (nome da loja, senha opcional)
    // Formato do arquivo (interno)
    versaoConfig:        [VERSAO_CONFIG, "int", 0, 99]
};

// Chaves que só mudam com a senha do administrador (a tela de consulta fica
// aberta ao público: cliente não pode trocar o banco, sair do quiosque etc.).
const PUBLICAS = ["tema", "modoLeve", "som", "volumeSom", "zoom", "tabComoEnter"];
const INTERNAS = ["senhaAdmin", "fbHostAuto", "versaoConfig", "configInicial"];
const SENSIVEIS = Object.keys(ESQUEMA).filter(k => PUBLICAS.indexOf(k) < 0 && INTERNAS.indexOf(k) < 0);

function padrao() {
    const o = {};
    Object.keys(ESQUEMA).forEach(k => { o[k] = ESQUEMA[k][0]; });
    return o;
}

/** Puro: valor válido para a chave, ou o padrão. */
function validarValor(chave, v) {
    const e = ESQUEMA[chave];
    if (!e) return undefined;
    const [pad, tipo, min, max] = e;
    if (Array.isArray(tipo)) return tipo.indexOf(v) >= 0 ? v : pad;
    switch (tipo) {
        case "bool": return typeof v === "boolean" ? v : (v === "true" ? true : v === "false" ? false : pad);
        case "int": {
            const n = typeof v === "number" ? v : parseInt(String(v), 10);
            if (!Number.isFinite(n)) return pad;
            return Math.min(max, Math.max(min, Math.round(n)));
        }
        case "num": {
            const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
            if (!Number.isFinite(n)) return pad;
            return Math.min(max, Math.max(min, n));
        }
        case "senha": return v == null ? pad : String(v).slice(0, 200);
        case "hora": {
            const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v == null ? "" : v));
            if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return pad;
            return String(m[1]).padStart(2, "0") + ":" + m[2];
        }
        case "hash": return typeof v === "string" && /^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(v) ? v : pad;
        default: return v == null ? pad : String(v).trim().slice(0, 1000);
    }
}

/** Puro: configuração completa e válida a partir de qualquer objeto. Chaves desconhecidas são descartadas. */
function normalizar(obj) {
    const src = obj && typeof obj === "object" ? obj : {};
    const o = padrao();
    Object.keys(ESQUEMA).forEach(k => { if (src[k] !== undefined) o[k] = validarValor(k, src[k]); });
    // config.json de uma versão anterior (sem versaoConfig ou menor que 2):
    // "Ocultar da barra de tarefas" passa a vir ligado, uma vez só.
    const versao = Number(src.versaoConfig);
    if (Object.keys(src).length && !(versao >= 2)) o.ocultarBarraTarefas = true;
    // Antes da 3: leitura instantânea passa a ser o padrão e a aceleração gráfica vem desligada.
    if (Object.keys(src).length && !(versao >= 3)) {
        if (o.metodoCopia === "auto") o.metodoCopia = "instantaneo";
        o.aceleracaoGrafica = false;
    }
    o.versaoConfig = VERSAO_CONFIG;
    return o;
}

/** Puro: aplica só as chaves conhecidas de `parcial` sobre `atual`. */
function mesclar(atual, parcial) {
    const o = normalizar(atual);
    const p = parcial && typeof parcial === "object" ? parcial : {};
    Object.keys(p).forEach(k => { if (ESQUEMA[k]) o[k] = validarValor(k, p[k]); });
    return o;
}

const _carimbo = () => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
};

/** Lê o config.json. Devolve { cfg, aviso }. Nunca lança erro. */
function carregar(arquivo) {
    let texto;
    try { texto = fs.readFileSync(arquivo, "utf8"); }
    catch (e) { return { cfg: padrao(), aviso: e && e.code === "ENOENT" ? null : "config.json ilegível (" + e.message + ") — usando os padrões." }; }
    try {
        const obj = JSON.parse(texto.replace(/^﻿/, ""));
        return { cfg: normalizar(obj), aviso: null };
    } catch (e) {
        const guardado = arquivo + ".corrompido-" + _carimbo();
        try { fs.renameSync(arquivo, guardado); } catch (_) {}
        return { cfg: padrao(), aviso: "config.json corrompido (" + e.message + ") — guardado como " + path.basename(guardado) + "; usando os padrões." };
    }
}

/** Grava de forma atômica (arquivo temporário + rename; se o rename falhar, grava direto). */
function gravarAtomico(arquivo, conteudo) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = arquivo + ".tmp-" + process.pid + "-" + Date.now();
    try {
        fs.writeFileSync(tmp, conteudo);
        try { fs.renameSync(tmp, arquivo); }
        catch (e) {
            // Windows: antivírus ou indexador segurando o arquivo destino.
            fs.writeFileSync(arquivo, conteudo);
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}

function salvar(arquivo, cfg) {
    gravarAtomico(arquivo, JSON.stringify(normalizar(cfg), null, 2) + "\n");
}

/** Cópia segura para mostrar/registrar (sem senhas). */
function semSenha(cfg) {
    const o = Object.assign({}, cfg);
    if (o.fbPass) o.fbPass = "••••";
    if (o.senhaAdmin) o.senhaAdmin = "(definida)";
    return o;
}

// ── Senha do administrador ───────────────────────────────────────────────────
const crypto = require("crypto");
const ITER = 120000;

/** Gera o registro "pbkdf2$iter$sal$hash" de uma senha. */
function gerarHashSenha(senha) {
    const sal = crypto.randomBytes(16);
    const h = crypto.pbkdf2Sync(String(senha), sal, ITER, 32, "sha256");
    return "pbkdf2$" + ITER + "$" + sal.toString("hex") + "$" + h.toString("hex");
}

/** Confere a senha contra o registro (comparação em tempo constante). */
function conferirSenha(senha, registro) {
    const m = /^pbkdf2\$(\d+)\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(String(registro || ""));
    if (!m || senha == null) return false;
    const iter = Math.min(Math.max(parseInt(m[1], 10) || ITER, 1000), 10000000);
    const h = crypto.pbkdf2Sync(String(senha), Buffer.from(m[2], "hex"), iter, 32, "sha256");
    const esperado = Buffer.from(m[3], "hex");
    return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
}

/** Puro: chaves sensíveis que `parcial` realmente muda em relação a `atual`. */
function sensiveisAlteradas(atual, parcial) {
    const a = normalizar(atual);
    const p = parcial && typeof parcial === "object" ? parcial : {};
    return SENSIVEIS.filter(k => p[k] !== undefined && validarValor(k, p[k]) !== a[k]);
}

module.exports = {
    VERSAO, VERSAO_CONFIG, ESQUEMA, PUBLICAS, INTERNAS, SENSIVEIS, padrao, validarValor, normalizar, mesclar, carregar, salvar, gravarAtomico, semSenha,
    gerarHashSenha, conferirSenha, sensiveisAlteradas
};
