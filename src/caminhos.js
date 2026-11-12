"use strict";
/**
 * caminhos.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Funções puras de caminho de pasta (Windows), sem depender do
 *              sistema em que roda (testáveis no Linux).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão: dentroDaPasta (vale também para a raiz de uma
 *           unidade, como D:\, onde o caminho já termina com a barra).
 */

const path = require("path");

const VERSAO = "1.0.0";

/**
 * Puro: `filho` está DENTRO de `pai` (não é o próprio `pai`)? Sem diferenciar
 * maiúsculas (Windows). Funciona com `pai` na raiz de uma unidade ("D:\"),
 * onde somar uma barra ao fim daria "D:\\" e nada casaria.
 */
function dentroDaPasta(pai, filho, p) {
    const P = p || path.win32;
    if (!pai || !filho) return false;
    const rel = P.relative(P.resolve(String(pai)).toLowerCase(), P.resolve(String(filho)).toLowerCase());
    return !!rel && !rel.startsWith("..") && !P.isAbsolute(rel);
}

module.exports = { VERSAO, dentroDaPasta };
