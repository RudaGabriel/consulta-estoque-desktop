"use strict";
/**
 * config.js
 * @version 1.0.0
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
 *   1.0.0 — Primeira versão.
 */

const fs = require("fs");
const path = require("path");

const VERSAO = "1.0.0";

// [padrão, tipo, mínimo, máximo] ou [padrão, lista de valores aceitos].
const ESQUEMA = {
    modo:                ["copia", ["copia", "direto"]],
    metodoCopia:         ["auto", ["auto", "gbak", "instantaneo"]],
    fbHost:              ["", "texto"],
    fbPorta:             [3050, "int", 1, 65535],
    fdbPath:             ["", "texto"],
    fbUser:              ["SYSDBA", "texto"],
    fbPass:              ["masterkey", "senha"],
    fbHostFixo:          [false, "bool"],
    fbHostAuto:          [false, "bool"],
    varrerRede:          [true, "bool"],
    copiaACadaMin:       [10, "int", 1, 1440],
    copiaTimeoutMin:     [30, "int", 1, 360],
    gbakPath:            ["", "texto"],
    pastaCopias:         ["", "texto"],
    diretoRecarregarSeg: [60, "int", 15, 3600],
    diretoItemAoVivo:    [true, "bool"],
    tema:                ["auto", ["auto", "claro", "escuro"]],
    modoLeve:            [false, "bool"],
    som:                 [true, "bool"],
    telaCheia:           [false, "bool"],
    sempreNoTopo:        [false, "bool"],
    iniciarComWindows:   [false, "bool"],
    zoom:                [1, "num", 0.6, 2.5],
    fecharDetalheSeg:    [0, "int", 0, 600],
    mostrarCusto:        [false, "bool"],
    limitePagina:        [100, "int", 20, 1000],
    nomeLoja:            ["", "texto"],
    aceleracaoGrafica:   [true, "bool"],
    tabComoEnter:        [true, "bool"]
};

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
        default: return v == null ? pad : String(v).trim().slice(0, 1000);
    }
}

/** Puro: configuração completa e válida a partir de qualquer objeto. Chaves desconhecidas são descartadas. */
function normalizar(obj) {
    const src = obj && typeof obj === "object" ? obj : {};
    const o = padrao();
    Object.keys(ESQUEMA).forEach(k => { if (src[k] !== undefined) o[k] = validarValor(k, src[k]); });
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

/** Cópia segura para mostrar/registrar (sem a senha). */
function semSenha(cfg) {
    const o = Object.assign({}, cfg);
    if (o.fbPass) o.fbPass = "••••";
    return o;
}

module.exports = { VERSAO, ESQUEMA, padrao, validarValor, normalizar, mesclar, carregar, salvar, gravarAtomico, semSenha };
