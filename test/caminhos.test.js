"use strict";
// Testes das funções de caminho (Windows).
const test = require("node:test");
const assert = require("node:assert");
const { dentroDaPasta } = require("../src/caminhos.js");

test("caminhos: pasta de dados dentro da pasta do portátil, também na raiz de uma unidade", () => {
    assert.strictEqual(dentroDaPasta("D:\\", "D:\\ConsultaEstoque-dados"), true, "portátil na raiz do pendrive");
    assert.strictEqual(dentroDaPasta("D:\\Programas", "d:\\programas\\ConsultaEstoque-dados"), true, "sem diferenciar maiúsculas");
    assert.strictEqual(dentroDaPasta("D:\\Programas", "D:\\Programas"), false, "a própria pasta não conta");
    assert.strictEqual(dentroDaPasta("D:\\Programas", "D:\\ProgramasX\\dados"), false, "nome parecido não conta");
    assert.strictEqual(dentroDaPasta("D:\\Programas", "C:\\Users\\Loja\\AppData\\Roaming\\Consulta Estoque"), false, "pasta de outra unidade (versão instalada) nunca");
    assert.strictEqual(dentroDaPasta("", "D:\\x"), false);
});
