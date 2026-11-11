"use strict";
/**
 * demo.js
 * @version 1.2.0
 * @author Ruda Gabriel
 * @description Firebird SIMULADO: usado pelos testes automáticos e pelo modo de
 *              demonstração (Consulta Estoque.exe --demo), que mostra a tela com
 *              produtos de exemplo sem precisar de banco nenhum.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.2.0 — Textos neutros.
 *   1.1.0 — Responde a versão do Firebird (ENGINE_VERSION) quando o banco simulado tem `versao`.
 */
// Firebird simulado (substitui o node-firebird).
// bancos: { "host|CAMINHO": { tabela, cols:[{n,tp,tam}], linhas:[{COL: valor}], semTabela, octetsRecusa, authErro, versao } }
// Registra toda SQL recebida em `sql` e toda transação em `transacoes`.

function criarFbFalso(bancos) {
    const sql = [];
    const transacoes = [];
    const attaches = [];
    const chave = (h, c) => String(h) + "|" + String(c).toUpperCase();
    const enc = v => typeof v === "string" ? Buffer.from(v, "latin1") : v; // bytes Windows-1252/latin1

    function responder(banco, q, params) {
        const s = String(q).replace(/\s+/g, " ").trim();
        if (/ENGINE_VERSION/i.test(s)) return banco.versao ? [{ V: banco.versao }] : [];
        if (/^SELECT TRIM\(RDB\$RELATION_NAME\) AS T FROM RDB\$RELATIONS/i.test(s)) {
            return banco.semTabela ? [] : [{ T: banco.tabela || "ESTOQUE" }];
        }
        if (/FROM RDB\$RELATION_FIELDS/i.test(s)) {
            if (banco.semTabela) return [];
            return banco.cols.map((c, i) => ({ T: banco.tabela || "ESTOQUE", C: c.n, TP: c.tp, ST: c.st || 0, TAM: c.tam || 10, ESC: 0, POS: i }));
        }
        if (/^SELECT .* FROM "ESTOQUE"/i.test(s)) {
            const comOct = /character set octets/i.test(s);
            if (comOct && banco.octetsRecusa) throw new Error("Cannot transliterate character between character sets");
            let linhas = banco.linhas;
            const w = /WHERE "([A-Z_]+)" = \?$/.exec(s);
            if (w) linhas = linhas.filter(l => String(l[w[1]]) === String(params[0]));
            const usadas = banco.cols.filter(c => !(c.tp === 261 && c.st !== 1));
            return linhas.map(l => {
                const o = {};
                usadas.forEach((c, i) => {
                    const v = l[c.n];
                    o["C" + i] = v == null ? null : ([14, 37, 40].indexOf(c.tp) >= 0 && comOct ? enc(String(v)) : v);
                });
                return o;
            });
        }
        return [];
    }

    const FB = {
        sql, transacoes, attaches,
        attach(opts, cb) {
            attaches.push({ host: opts.host, database: opts.database, user: opts.user });
            setImmediate(() => {
                const banco = bancos[chave(opts.host, opts.database)];
                if (!banco) {
                    const inacessivel = !Object.keys(bancos).some(k => k.split("|")[0] === opts.host);
                    return cb(new Error(inacessivel ? "connect ECONNREFUSED " + opts.host + ":3050" : "I/O error during \"CreateFile (open)\" operation for file \"" + opts.database + "\""));
                }
                if (banco.authErro) return cb(new Error("Your user name and password are not defined. Ask your database administrator to set up a Firebird login."));
                const connection = {
                    startTransaction(tx, cbt) {
                        transacoes.push(tx);
                        setImmediate(() => cbt(null, {
                            query(q, params, cbq) {
                                sql.push(q);
                                setImmediate(() => {
                                    if (banco.atrasoMs) return setTimeout(() => { try { cbq(null, responder(banco, q, params)); } catch (e) { cbq(e); } }, banco.atrasoMs);
                                    try { cbq(null, responder(banco, q, params)); } catch (e) { cbq(e); }
                                });
                            },
                            execute(q, params, cbq) { this.query(q, params, cbq); },
                            rollback(cbr) { if (cbr) setImmediate(cbr); }
                        }));
                    }
                };
                cb(null, {
                    connection,
                    detach(cbd) { if (cbd) setImmediate(cbd); },
                    query() { throw new Error("db.query original não deveria ser chamado (trava)"); }
                });
            });
        }
    };
    return FB;
}

// Tabela de produtos de exemplo (nomes neutros).
const COLS = [
    { n: "CODIGO", tp: 37, tam: 5 }, { n: "DESCRICAO", tp: 37, tam: 45 }, { n: "REFERENCIA", tp: 37, tam: 20 },
    { n: "QTD_ATUAL", tp: 27, tam: 8 }, { n: "PRECO", tp: 27, tam: 8 }, { n: "MEDIDA", tp: 37, tam: 3 },
    { n: "ATIVO", tp: 14, tam: 1 }, { n: "FORNECEDOR", tp: 37, tam: 30 }, { n: "FOTO", tp: 261, st: 0, tam: 8 }
];
function linhasExemplo() {
    const l = [
        { CODIGO: "00123", DESCRICAO: "RAÇÃO GATO 1KG", REFERENCIA: "7891234567895", QTD_ATUAL: 12, PRECO: 25.9, MEDIDA: "UN", ATIVO: "0", FORNECEDOR: "FORNECEDOR A" },
        { CODIGO: "00124", DESCRICAO: "RAÇÃO CÃO 15KG", REFERENCIA: "7891234567000", QTD_ATUAL: 0, PRECO: 149.9, MEDIDA: "UN", ATIVO: "0", FORNECEDOR: "FORNECEDOR B" },
        { CODIGO: "00125", DESCRICAO: "AREIA HIGIÊNICA 4KG", REFERENCIA: "7890000000017", QTD_ATUAL: -2, PRECO: 19.5, MEDIDA: "PC", ATIVO: "1", FORNECEDOR: "FORNECEDOR A" }
    ];
    for (let i = 0; i < 12; i++) l.push({ CODIGO: String(200 + i).padStart(5, "0"), DESCRICAO: "ITEM GENÉRICO " + i, REFERENCIA: "", QTD_ATUAL: i, PRECO: 1 + i, MEDIDA: "UN", ATIVO: "0", FORNECEDOR: "=CMD" });
    return l;
}
function bancoExemplo(extra) {
    return Object.assign({ tabela: "ESTOQUE", cols: COLS, linhas: linhasExemplo() }, extra || {});
}

// Catálogo de demonstração maior (nomes neutros), para ver a tela cheia.
function bancoDemo() {
    const nomes = ["RAÇÃO GATO", "RAÇÃO CÃO", "AREIA HIGIÊNICA", "PETISCO", "COLEIRA", "SHAMPOO", "BEBEDOURO", "COMEDOURO", "BRINQUEDO", "CAMA"];
    const tam = ["1KG", "3KG", "10KG", "P", "M", "G", "500ML", "UN"];
    const linhas = linhasExemplo().slice(0, 3);
    let n = 0;
    for (const nome of nomes) for (const t of tam) {
        n++;
        const cod = String(300 + n).padStart(5, "0");
        const ean = "789" + String(1000000000 + n * 7919).slice(0, 9);
        let s = 0; for (let i = 0; i < 12; i++) s += Number(ean[i]) * (i % 2 ? 3 : 1);
        linhas.push({
            CODIGO: cod, DESCRICAO: nome + " " + t, REFERENCIA: ean + ((10 - s % 10) % 10),
            QTD_ATUAL: (n * 37) % 23 - 3, PRECO: Math.round((5 + (n * 13.7) % 180) * 100) / 100,
            MEDIDA: t.endsWith("ML") || t.endsWith("KG") ? "UN" : "PC", ATIVO: n % 17 ? "0" : "1", FORNECEDOR: "FORNECEDOR " + "ABCDE"[n % 5]
        });
    }
    return { tabela: "ESTOQUE", cols: COLS, linhas };
}

module.exports = { criarFbFalso, bancoExemplo, linhasExemplo, bancoDemo, COLS };
