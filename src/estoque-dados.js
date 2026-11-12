"use strict";
/**
 * estoque-dados.js
 * @version 1.1.1
 * @author Ruda Gabriel
 * @description Lê a tabela de produtos (ESTOQUE) e monta o
 *              "retrato" do estoque em memória, pronto para a busca.
 *
 * O esquema não é fixo: as colunas vêm do catálogo do Firebird e são
 * classificadas pelo nome (CODIGO, DESCRICAO, REFERENCIA/EAN/GTIN, QTD_ATUAL,
 * PRECO...). Coluna desconhecida aparece no detalhe e entra na busca do mesmo
 * jeito. Texto é lido como bytes (OCTETS) e decodificado aqui, porque o banco
 * do sistema de gestão não declara charset e tem acentos.
 *
 * Funções puras (sem banco): indexar, fonteDe, resumo, detalhe, acharIndice,
 * paraDisco/doDisco, csv. Com banco: lerCatalogo, carregarTabela, lerItem,
 * temTabelaProduto — sempre por conexão blindada (somente leitura).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.1 — Comentários sem o nome de nenhum sistema (projeto autônomo e neutro).
 */

const Busca = require("./estoque-busca.js");
const { consultar, decodificarTexto } = require("./firebird.js");

const VERSAO = "1.1.1";
const FORMATO_DISCO = 1;
const TABELAS = ["ESTOQUE", "PRODUTOS", "PRODUTO", "CADPRO", "MERCADORIAS"];

// Papéis das colunas, em ordem de preferência (o 1º nome que existir vence).
const PAPEIS = {
    codigo:     ["CODIGO", "COD", "CODPRODUTO", "COD_PRODUTO", "CODIGO_PRODUTO", "ID_PRODUTO", "IDPRODUTO", "ID"],
    descricao:  ["DESCRICAO", "DESCR", "DESCRICAO_PRODUTO", "PRODUTO", "NOME"],
    barras:     ["CODBARRAS", "COD_BARRAS", "CODIGO_BARRAS", "CODIGODEBARRAS", "CODBAR", "BARRAS", "EAN", "EAN13", "GTIN", "CEAN", "REFERENCIA"],
    referencia: ["REFERENCIA", "REF", "REFERENCIA_FORNECEDOR", "REF_FORNECEDOR", "CODFABRICANTE"],
    qtd:        ["QTD_ATUAL", "QTDATUAL", "ESTOQUE_ATUAL", "ESTOQUE", "SALDO", "QTD", "QTDE", "QUANTIDADE"],
    qtdMin:     ["QTD_MINIM", "QTD_MINIMA", "QTDMINIMA", "ESTOQUE_MINIMO", "QTDMIN", "MINIMO"],
    preco:      ["PRECO", "PRECO_VENDA", "PRECOVENDA", "PRECO1", "PR_VENDA", "VENDA", "VALOR"],
    custo:      ["CUSTOCOMPR", "CUSTO_COMPRA", "CUSTOMEDIO", "CUSTO_MEDIO", "PRECO_CUSTO", "CUSTO"],
    unidade:    ["MEDIDA", "UNIDADE", "UN", "UND", "UNID"],
    grupo:      ["NOME_GRUPO", "GRUPO", "CATEGORIA", "SECAO", "DEPARTAMENTO"],
    fornecedor: ["FORNECEDOR", "NOME_FORNECEDOR", "NOMEFORNEC", "FABRICANTE", "MARCA"],
    ncm:        ["NCM", "CLASSIFICACAO_FISCAL", "CLASFISCAL", "CF"],
    local:      ["LOCAL", "LOCALIZACAO", "PRATELEIRA", "ENDERECO"],
    ativo:      ["ATIVO", "INATIVO", "SITUACAO", "STATUS"],
    alteracao:  ["ALTERADO", "DATA_ALTERACAO", "DT_ALTERACAO", "ULTIMA_ALTERACAO", "ALTERACAO"],
    ultVenda:   ["ULT_VENDA", "ULTIMA_VENDA", "DT_ULT_VENDA", "DATA_ULT_VENDA"]
};
const CAMPOS_RESUMO_TEXTO = ["codigo", "descricao", "barras", "referencia", "unidade", "grupo", "fornecedor", "ncm", "local"];
const CAMPOS_RESUMO_NUM = ["qtd", "qtdMin", "preco", "custo"];

// Tipos do Firebird (RDB$FIELD_TYPE).
const T_TEXTO = { 14: "CHAR", 37: "VARCHAR", 40: "CSTRING" };
const T_BLOB = 261;
const T_DATA = { 12: "DATE", 13: "TIME", 35: "TIMESTAMP" };
const ERRO_OCTETS = /octets|transliterat|character set|charset|malformed|conversion|truncation|arithmetic/i;

const normalizar = Busca.normalizar;
const soDigitos = s => String(s || "").replace(/\D+/g, "");
const num = Busca.num;
const aspas = n => '"' + String(n).replace(/"/g, '""') + '"';
const campoLinha = (row, nome) => {
    if (!row) return undefined;
    if (row[nome] !== undefined) return row[nome];
    return row[String(nome).toLowerCase()];
};

// ── Situação (ativo/inativo) ─────────────────────────────────────────────────
/** Item ativo? null = não dá para saber. */
function lerAtivo(papel, v) {
    if (!papel || v == null || v === "") return null;
    const s = normalizar(v);
    const positivo = /^(S|SIM|1|T|TRUE|A|ATIVO)$/.test(s);
    const negativo = /^(N|NAO|0|F|FALSE|I|INATIVO)$/.test(s);
    if (!positivo && !negativo) return null;
    return papel === "INATIVO" ? negativo : positivo;
}

/**
 * Cada sistema usa uma convenção (em alguns, "0" pode ser ATIVO). Decide pelos
 * dados: numa loja a grande maioria está ativa — se quase todos dariam
 * "inativo" pela leitura direta, inverte.
 */
function decidirAtivo(papel, idx, linhas) {
    if (!papel || idx < 0) return { inverterAtivo: false, contagemAtivo: null };
    const cont = {};
    let pos = 0, neg = 0;
    for (const l of linhas) {
        const v = l[idx];
        const k = v == null ? "(vazio)" : (String(v).trim() || "(vazio)");
        cont[k] = (cont[k] || 0) + 1;
        const a = lerAtivo(papel, v);
        if (a === true) pos++; else if (a === false) neg++;
    }
    const total = pos + neg;
    return { inverterAtivo: total >= 10 && neg / total > 0.7, contagemAtivo: cont };
}

// ── Catálogo ─────────────────────────────────────────────────────────────────
const SQL_CATALOGO =
    "SELECT TRIM(rf.RDB$RELATION_NAME) AS T, TRIM(rf.RDB$FIELD_NAME) AS C, f.RDB$FIELD_TYPE AS TP, f.RDB$FIELD_SUB_TYPE AS ST, " +
    "COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS TAM, f.RDB$FIELD_SCALE AS ESC, rf.RDB$FIELD_POSITION AS POS " +
    "FROM RDB$RELATION_FIELDS rf JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE " +
    "WHERE TRIM(rf.RDB$RELATION_NAME) IN ('" + TABELAS.join("','") + "') ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION";

/** Puro: escolhe a tabela de produtos e o papel de cada coluna a partir das linhas do catálogo. */
function interpretarCatalogo(linhasCatalogo) {
    const porTabela = {};
    for (const r of (linhasCatalogo || [])) {
        const t = String(campoLinha(r, "T") || "").trim().toUpperCase();
        const c = String(campoLinha(r, "C") || "").trim().toUpperCase();
        if (!t || !c) continue;
        const tp = Number(campoLinha(r, "TP"));
        (porTabela[t] = porTabela[t] || []).push({
            nome: c, tp, st: Number(campoLinha(r, "ST")) || 0, tam: Number(campoLinha(r, "TAM")) || 0
        });
    }
    const tabela = TABELAS.find(t => porTabela[t] && porTabela[t].length);
    if (!tabela) {
        const e = new Error("Tabela de produtos (ESTOQUE) não encontrada no banco.");
        e.codigo = "TABELA";
        throw e;
    }
    const cols = porTabela[tabela];
    const mapa = {};
    cols.forEach(c => { mapa[c.nome] = c; });
    const papeis = {};
    Object.keys(PAPEIS).forEach(p => { papeis[p] = PAPEIS[p].find(n => mapa[n]) || null; });
    // Código de barras e referência não podem ser a mesma coluna duas vezes.
    if (papeis.referencia && papeis.referencia === papeis.barras) papeis.referencia = null;
    if (papeis.descricao && papeis.descricao === papeis.fornecedor) papeis.fornecedor = null;
    return { tabela, cols, papeis };
}

async function lerCatalogo(db) {
    return interpretarCatalogo(await consultar(db, SQL_CATALOGO, [], 20000));
}

/** O banco tem a tabela de produtos? (validação da descoberta) */
async function temTabelaProduto(db) {
    const r = await consultar(db,
        "SELECT TRIM(RDB$RELATION_NAME) AS T FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) IN ('" + TABELAS.join("','") + "')", [], 15000);
    return (r || []).some(x => TABELAS.indexOf(String(campoLinha(x, "T") || "").trim().toUpperCase()) >= 0);
}

// ── SELECT da tabela ─────────────────────────────────────────────────────────
/** Puro: SELECT de todas as colunas úteis (texto como bytes, blob de texto resumido, binário fora). */
function montarSelect(tabela, cols, comOctets) {
    const usadas = cols.filter(c => !(c.tp === T_BLOB && c.st !== 1));
    const oct = comOctets ? " character set octets" : "";
    const partes = usadas.map((c, i) => {
        const al = "C" + i;
        if (T_TEXTO[c.tp]) return "cast(" + aspas(c.nome) + " as varchar(" + Math.min(32000, Math.max(1, c.tam) * 4) + ")" + oct + ") as " + al;
        if (c.tp === T_BLOB) return "cast(substring(" + aspas(c.nome) + " from 1 for 1000) as varchar(4000)" + oct + ") as " + al;
        return aspas(c.nome) + " as " + al;
    });
    return { usadas, sql: "SELECT " + partes.join(", ") + " FROM " + aspas(tabela) };
}

/** Converte uma linha do driver no array de valores (texto decodificado, datas ISO). */
function converterLinha(row, n) {
    const lin = new Array(n);
    for (let k = 0; k < n; k++) {
        let v = campoLinha(row, "C" + k);
        if (Buffer.isBuffer(v)) v = decodificarTexto(v);
        if (v instanceof Date) v = isNaN(v.getTime()) ? null : v.toISOString();
        else if (typeof v === "string") v = v.replace(/\s+$/, "");
        else if (typeof v === "bigint") v = Number(v);
        lin[k] = v == null ? null : v;
    }
    return lin;
}

/**
 * Lê a tabela inteira. opcoes: { origem, octetsRecusado, log }.
 * Devolve o retrato SEM índice de busca (use indexar()).
 */
async function carregarTabela(db, opcoes) {
    const o = opcoes || {};
    const log = typeof o.log === "function" ? o.log : () => {};
    const cat = await lerCatalogo(db);
    let comOctets = !o.octetsRecusado;
    let sel = montarSelect(cat.tabela, cat.cols, comOctets);
    let linhasDb;
    try {
        linhasDb = await consultar(db, sel.sql, [], 120000);
    } catch (e) {
        if (!comOctets || !ERRO_OCTETS.test(String((e && e.message) || e))) throw e;
        log("O Firebird recusou a leitura como bytes (OCTETS) — repetindo sem ela.");
        comOctets = false;
        sel = montarSelect(cat.tabela, cat.cols, false);
        linhasDb = await consultar(db, sel.sql, [], 120000);
    }
    const n = sel.usadas.length;
    const linhas = new Array(linhasDb.length);
    for (let i = 0; i < linhasDb.length; i++) linhas[i] = converterLinha(linhasDb[i], n);
    return montarRetrato({
        origem: o.origem || "",
        tabela: cat.tabela,
        colunas: sel.usadas.map(c => ({ nome: c.nome, tipo: T_TEXTO[c.tp] || T_DATA[c.tp] || (c.tp === T_BLOB ? "BLOB" : "NUM"), tp: c.tp, st: c.st, tam: c.tam })),
        papeis: cat.papeis,
        linhas,
        carregadoEm: Date.now(),
        octets: comOctets
    });
}

/** Puro: completa o retrato (índices dos papéis, situação, versão) e monta a busca. */
function montarRetrato(base) {
    const r = Object.assign({}, base);
    r.idxPapel = {};
    Object.keys(PAPEIS).forEach(p => {
        r.idxPapel[p] = r.papeis && r.papeis[p] ? r.colunas.findIndex(c => c.nome === r.papeis[p]) : -1;
    });
    Object.assign(r, decidirAtivo(r.papeis && r.papeis.ativo, r.idxPapel.ativo, r.linhas));
    r.versao = String(r.origem || "") + "|" + r.carregadoEm;
    return indexar(r);
}

/** Puro: textos de busca e dígitos de cada item (refeitos ao ler do disco). */
function indexar(r) {
    const n = r.linhas.length;
    const ehTexto = r.colunas.map(c => !!T_TEXTO[c.tp] || c.tp === T_BLOB || c.tipo === "CHAR" || c.tipo === "VARCHAR" || c.tipo === "BLOB");
    const numPesq = r.colunas.map((c, k) => k === r.idxPapel.codigo || /COD|BARRA|EAN|GTIN|REF/.test(c.nome));
    r.busca = new Array(n);
    r.digitos = new Array(n);
    for (let i = 0; i < n; i++) {
        const lin = r.linhas[i];
        const txt = [], dig = [];
        for (let k = 0; k < lin.length; k++) {
            const v = lin[k];
            if (v == null || v === "") continue;
            if (ehTexto[k] && typeof v === "string") {
                txt.push(normalizar(v));
                const d = soDigitos(v);
                if (d.length >= 3) dig.push(d);
            } else if (typeof v === "number" && Number.isInteger(v) && numPesq[k]) {
                // Código numérico, EAN em BIGINT...: também pesquisável.
                txt.push(String(v));
                dig.push(String(v));
            }
        }
        r.busca[i] = "\u0001" + txt.join("\u0001") + "\u0001";
        r.digitos[i] = "\u0001" + dig.join("\u0001") + "\u0001";
    }
    return r;
}

// ── Acesso aos itens ─────────────────────────────────────────────────────────
const valor = (r, i, papel) => { const k = r.idxPapel[papel]; return k >= 0 ? r.linhas[i][k] : null; };
const ativoDe = (r, i) => { const a = lerAtivo(r.papeis.ativo, valor(r, i, "ativo")); return a === null ? null : (r.inverterAtivo ? !a : a); };

function fonteDe(r) {
    return {
        n: r.linhas.length,
        busca: i => r.busca[i],
        digitos: i => r.digitos[i],
        val: (i, papel) => valor(r, i, papel),
        ativo: i => ativoDe(r, i),
        temQtd: r.idxPapel.qtd >= 0,
        temPreco: r.idxPapel.preco >= 0,
        temAtivo: !!r.papeis.ativo
    };
}

/** Item resumido para a lista e o cartão de preço. */
function resumo(r, i) {
    const it = { i, versao: r.versao };
    CAMPOS_RESUMO_TEXTO.forEach(p => {
        const v = valor(r, i, p);
        if (v != null && v !== "") it[p] = typeof v === "string" ? v.trim() : v;
    });
    CAMPOS_RESUMO_NUM.forEach(p => { const n = num(valor(r, i, p)); if (n != null) it[p] = n; });
    const at = ativoDe(r, i);
    if (at !== null) it.ativo = at;
    return it;
}

/** Todas as colunas de um item. */
function detalhe(r, i) {
    return {
        ok: true,
        resumo: resumo(r, i),
        campos: r.colunas.map((c, k) => ({ nome: c.nome, tipo: c.tipo, valor: r.linhas[i][k] })),
        carregadoEm: r.carregadoEm
    };
}

/**
 * Índice do item pedido: pelo índice se a versão do retrato for a mesma; senão
 * pelo código (o retrato pode ter sido recarregado entre a busca e o clique).
 */
function acharIndice(r, pedido) {
    if (!r || !pedido) return -1;
    const i = parseInt(pedido.i, 10);
    if (pedido.versao === r.versao && i >= 0 && i < r.linhas.length) return i;
    if (pedido.codigo == null || r.idxPapel.codigo < 0) return -1;
    const alvo = String(pedido.codigo).trim();
    const k = r.idxPapel.codigo;
    for (let j = 0; j < r.linhas.length; j++) {
        const v = r.linhas[j][k];
        if (v != null && String(v).trim() === alvo) return j;
    }
    return -1;
}

/** Relê UM item direto do banco (modo leitura direta: estoque e preço ao vivo). */
async function lerItem(db, r, codigo) {
    if (!r || r.idxPapel.codigo < 0 || codigo == null || codigo === "") return null;
    const cols = r.colunas.map(c => ({ nome: c.nome, tp: c.tp, st: c.st, tam: c.tam }));
    const sel = montarSelect(r.tabela, cols, r.octets !== false);
    const colCod = r.colunas[r.idxPapel.codigo];
    const sql = sel.sql + " WHERE " + aspas(colCod.nome) + " = ?";
    const rows = await consultar(db, sql, [codigo], 10000);
    if (!rows || !rows.length) return null;
    return converterLinha(rows[0], sel.usadas.length);
}

/** Aplica no retrato a linha lida ao vivo (mesma posição), para a lista também mostrar o valor novo. */
function aplicarLinha(r, i, linha) {
    if (!r || !linha || !(i >= 0 && i < r.linhas.length) || linha.length !== r.colunas.length) return false;
    r.linhas[i] = linha;
    const parcial = { linhas: [linha], colunas: r.colunas, idxPapel: r.idxPapel };
    indexar(parcial);
    r.busca[i] = parcial.busca[0];
    r.digitos[i] = parcial.digitos[0];
    return true;
}

// ── Disco ────────────────────────────────────────────────────────────────────
function paraDisco(r) {
    return {
        formato: FORMATO_DISCO, origem: r.origem, tabela: r.tabela, colunas: r.colunas,
        papeis: r.papeis, linhas: r.linhas, carregadoEm: r.carregadoEm, octets: r.octets,
        modo: r.modo || null
    };
}

function doDisco(obj) {
    if (!obj || obj.formato !== FORMATO_DISCO || !Array.isArray(obj.linhas) || !Array.isArray(obj.colunas) || !obj.papeis) return null;
    const n = obj.colunas.length;
    if (obj.linhas.some(l => !Array.isArray(l) || l.length !== n)) return null;
    const r = montarRetrato({
        origem: obj.origem || "", tabela: obj.tabela, colunas: obj.colunas, papeis: obj.papeis,
        linhas: obj.linhas, carregadoEm: Number(obj.carregadoEm) || 0, octets: obj.octets !== false
    });
    r.modo = obj.modo || null;
    r.doDisco = true;
    return r;
}

// ── Exportação ───────────────────────────────────────────────────────────────
/** CSV (;) de todos os resultados, com todas as colunas. BOM UTF-8; protegido contra fórmula. */
function csv(r, indices) {
    const cel = v => {
        if (v == null) return "";
        let s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
        if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const linhas = [r.colunas.map(c => cel(c.nome)).join(";")];
    for (const i of indices) linhas.push(r.linhas[i].map(cel).join(";"));
    return "﻿" + linhas.join("\r\n") + "\r\n";
}

module.exports = {
    VERSAO, TABELAS, PAPEIS, FORMATO_DISCO,
    interpretarCatalogo, lerCatalogo, temTabelaProduto, montarSelect, converterLinha, carregarTabela,
    montarRetrato, indexar, fonteDe, resumo, detalhe, acharIndice, lerItem, aplicarLinha,
    paraDisco, doDisco, csv, lerAtivo, decidirAtivo
};
