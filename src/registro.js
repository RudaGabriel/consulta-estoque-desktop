"use strict";
/**
 * registro.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Log do aplicativo (consulta-estoque.log, na pasta de dados), com
 *              rotação automática em 2 MB e as últimas linhas em memória para
 *              a tela de Diagnóstico. Nunca lança erro.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */

const fs = require("fs");
const path = require("path");

const VERSAO = "1.0.0";
const MAX_BYTES = 2 * 1024 * 1024;
const EM_MEMORIA = 400;

function carimbo(d) {
    d = d || new Date();
    const p = n => String(n).padStart(2, "0");
    return "[" + p(d.getDate()) + "-" + p(d.getMonth() + 1) + "-" + d.getFullYear() + "] [" +
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "]";
}

function criarRegistro(pasta, opcoes) {
    const o = opcoes || {};
    const arquivo = pasta ? path.join(pasta, "consulta-estoque.log") : null;
    const ultimas = [];
    const ouvintes = new Set();
    let escritas = 0;
    if (pasta) { try { fs.mkdirSync(pasta, { recursive: true }); } catch (_) {} }

    const rotacionar = () => {
        try {
            if (fs.statSync(arquivo).size <= MAX_BYTES) return;
            try { fs.unlinkSync(arquivo + ".1"); } catch (_) {}
            fs.renameSync(arquivo, arquivo + ".1");
        } catch (_) {}
    };

    function escrever(categoria, msg) {
        const texto = String(msg == null ? "" : msg).replace(/[\r\n]+/g, " | ").slice(0, 4000);
        const linha = carimbo() + " [" + categoria + "] " + texto;
        ultimas.push(linha);
        if (ultimas.length > EM_MEMORIA) ultimas.splice(0, ultimas.length - EM_MEMORIA);
        if (arquivo) {
            if (escritas++ % 50 === 0) rotacionar();
            try { fs.appendFileSync(arquivo, linha + "\r\n"); } catch (_) {}
        }
        if (o.console) { try { process.stdout.write(linha + "\n"); } catch (_) {} }
        for (const f of ouvintes) { try { f(linha); } catch (_) {} }
        return linha;
    }

    return {
        arquivo,
        info: m => escrever("INFO", m),
        aviso: m => escrever("AVISO", m),
        erro: m => escrever("ERRO", m),
        busca: m => escrever("BUSCA", m),
        copia: m => escrever("COPIA", m),
        ultimas: () => ultimas.slice(),
        aoEscrever(f) { ouvintes.add(f); return () => ouvintes.delete(f); }
    };
}

module.exports = { VERSAO, criarRegistro, carimbo };
