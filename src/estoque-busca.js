/**
 * estoque-busca.js
 * @version 1.2.0
 * @author Ruda Gabriel
 * @description Regras da busca do estoque, num só lugar (as mesmas da página
 *              de busca do estoque, com o coringa "*" e o filtro de
 *              preço ">valor" / "<valor").
 *
 * "fonte" é qualquer conjunto de itens que responda:
 *   n                 quantidade de itens
 *   busca(i)          texto de busca do item (campos normalizados separados por \u0001)
 *   digitos(i)        só os dígitos dos campos (\u0001 entre eles)
 *   val(i, papel)     valor do campo (codigo, descricao, barras, referencia, qtd, qtdMin, preco...)
 *   ativo(i)          true / false / null (sem coluna de situação)
 *   temQtd, temPreco, temAtivo
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.2.0 — Sem totais de estoque e de valor em estoque na pesquisa (removidos do
 *           aplicativo); textos neutros.
 */
(function (raiz, fabrica) {
    if (typeof module === "object" && module.exports) module.exports = fabrica();
    else raiz.EstoqueBusca = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";
    var VERSAO = "1.2.0";

    var semAcento = function (s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, ""); };
    var normalizar = function (s) { return semAcento(s).toUpperCase().replace(/\s+/g, " ").trim(); };
    var soDigitos = function (s) { return String(s || "").replace(/\D+/g, ""); };
    // "Contém" desmarcado: o texto digitado (inteiro) precisa estar no COMEÇO de
    // algum campo. A busca tem os campos separados por \u0001.
    var noInicioDoCampo = function (hs, t) { return hs.indexOf("\u0001" + t) >= 0; };
    /** Lê o valor como número (ou null). */
    var num = function (v) {
        if (v == null || v === "") return null;
        var n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
        return isFinite(n) ? n : null;
    };

    var escRe = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
    /** Puro: valor digitado ("49,90", "49.90", "1.500", "1.500,00") → número ou null. */
    function lerValor(txt) {
        var s = String(txt == null ? "" : txt).trim();
        if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
        else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
        var n = Number(s);
        return s !== "" && isFinite(n) ? n : null;
    }
    // ">50", "> 50", ">=50", "<R$ 49,90"... (o valor fica sozinho, sem letras grudadas).
    var RE_PRECO = /(^|\s)([<>]=?)\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?=\s|$)/gi;
    /**
     * Puro: tira do texto os filtros de preço. ">" vale "o valor ou mais" e "<"
     * vale "o valor ou menos" (o próprio valor entra nos dois). Devolve
     * { texto, min, max } — min/max null quando não há filtro.
     */
    function separarPreco(texto) {
        var min = null, max = null;
        var resto = String(texto == null ? "" : texto).replace(RE_PRECO, function (_, antes, op, valor) {
            var n = lerValor(valor);
            if (n == null) return antes + op + valor;
            if (op[0] === ">") min = min == null ? n : Math.max(min, n);
            else max = max == null ? n : Math.min(max, n);
            return antes + " ";
        });
        return { texto: resto.replace(/\s+/g, " ").trim(), min: min, max: max };
    }
    /** Puro: termo com "*" vira um teste ("*" = qualquer coisa dentro do mesmo campo). */
    function testeCoringa(termo, soInicioCampo) {
        var partes = String(termo).split("*");
        var re = new RegExp((soInicioCampo ? "\u0001" : "") + partes.map(escRe).join("[^\u0001]*"));
        return function (hs) { return re.test(hs); };
    }
    var temTexto = function (t) { return String(t).replace(/\*/g, "") !== ""; };

    /**
     * Busca. Termos separados por espaço = todos precisam aparecer (em qualquer
     * coluna). Só números: também compara com os dígitos de cada campo (código
     * de barras com ou sem pontuação). Aspas: frase exata. "-termo" exclui.
     * Coringa (f.coringa, padrão ligado): "RACAO*10KG". Preço (f.preco, padrão
     * ligado): ">50" e "<50" no texto. Devolve [{ i, pts }].
     */
    function filtrar(fonte, consulta, filtros) {
        var f = filtros || {};
        var coringa = f.coringa !== false;
        var bruto = String(consulta || "").slice(0, 300);
        var faixa = { min: null, max: null };
        if (f.preco !== false) { faixa = separarPreco(bruto); bruto = faixa.texto; }
        var comPreco = (faixa.min != null || faixa.max != null) && fonte.temPreco !== false;
        var frases = [], excl = [], termos = [];
        var resto = bruto.replace(/"([^"]+)"/g, function (_, x) { var n = normalizar(x); if (n) frases.push(n); return " "; });
        resto.split(/\s+/).forEach(function (t) {
            if (!t) return;
            if (t[0] === "-" && t.length > 1) { var e = normalizar(t.slice(1)); if (e && (!coringa || temTexto(e))) excl.push(e); return; }
            var n = normalizar(t); if (n && (!coringa || temTexto(n))) termos.push(n);
        });
        var qNum = /^\d{3,}$/.test(bruto.trim()) ? bruto.trim() : "";
        // "Contém" (padrão): cada termo pode estar em qualquer parte do texto.
        // Desmarcado: o texto digitado inteiro precisa estar no começo de algum campo
        // ("RACAO" acha "RACAO GATO 1KG", mas "GATO" não). "-termo" continua excluindo.
        var soInicio = f.contem === false;
        var prefixo = soInicio ? normalizar(bruto.replace(/"/g, " ").split(/\s+/).filter(function (t) { return t && !(t[0] === "-" && t.length > 1); }).join(" ")) : "";
        // Código numérico com zeros à esquerda: "4203" também acha "04203".
        var prefNum = soInicio && /^\d+$/.test(prefixo) ? prefixo.replace(/^0+(?=\d)/, "") : "";
        var contem = function (hs, t) { return hs.indexOf(t) >= 0; };
        // Coringa: cada termo com "*" ganha um teste próprio (feito uma vez só).
        var testes = {};
        var acha = function (hs, t) {
            if (!coringa || t.indexOf("*") < 0) return contem(hs, t);
            if (!testes[t]) testes[t] = testeCoringa(t, false);
            return testes[t](hs);
        };
        var prefCoringa = soInicio && coringa && prefixo.indexOf("*") >= 0 && temTexto(prefixo) ? testeCoringa(prefixo, true) : null;
        var semEstrela = function (t) { return coringa ? (String(t).split("*").filter(Boolean)[0] || "") : t; };
        var res = [];
        for (var i = 0; i < fonte.n; i++) {
            var hs = fonte.busca(i);
            var ok = true, k;
            if (soInicio) {
                if (prefCoringa) { if (!prefCoringa(hs)) ok = false; }
                else if (prefixo && !noInicioDoCampo(hs, prefixo) && !noInicioDoCampo(fonte.digitos(i), prefixo)) {
                    var cv = fonte.val(i, "codigo");
                    var cod0 = prefNum ? String(cv == null ? "" : cv).trim().replace(/^0+(?=\d)/, "") : "";
                    if (!(prefNum && /^\d+$/.test(cod0) && cod0.indexOf(prefNum) === 0)) ok = false;
                }
            } else {
                for (k = 0; k < termos.length && ok; k++) if (!acha(hs, termos[k]) && !(qNum && contem(fonte.digitos(i), termos[k]))) ok = false;
                for (k = 0; k < frases.length && ok; k++) if (!contem(hs, frases[k])) ok = false;
            }
            for (k = 0; k < excl.length && ok; k++) if (acha(hs, excl[k])) ok = false;
            if (!ok) continue;
            if (comPreco) {
                var pr = num(fonte.val(i, "preco"));
                if (pr == null || (faixa.min != null && pr < faixa.min) || (faixa.max != null && pr > faixa.max)) continue;
            }
            if (f.estoque && f.estoque !== "todos" && fonte.temQtd) {
                var q = num(fonte.val(i, "qtd"));
                if (f.estoque === "com" && !(q > 0)) continue;
                if (f.estoque === "sem" && !(q === 0 || q == null)) continue;
                if (f.estoque === "negativo" && !(q < 0)) continue;
                if (f.estoque === "abaixo") { var mn = num(fonte.val(i, "qtdMin")); if (!(q != null && mn != null && q < mn)) continue; }
            }
            if (f.ativos && fonte.temAtivo && fonte.ativo(i) === false) continue;
            // Relevância: código/barras exatos primeiro, depois começo da descrição.
            var pts = 0;
            if (qNum || termos.length === 1) {
                var alvo = qNum || semEstrela(termos[0]);
                var cod = normalizar(fonte.val(i, "codigo")), bar = normalizar(fonte.val(i, "barras")), ref = normalizar(fonte.val(i, "referencia"));
                // "123" também acha o código "00123" (zeros à esquerda).
                if (cod === alvo || (/^\d+$/.test(alvo) && /^\d+$/.test(cod) && Number(cod) === Number(alvo))) pts += 1000;
                if (bar === alvo || (qNum && soDigitos(bar) === qNum)) pts += 900;
                if (ref === alvo) pts += 800;
            }
            if (termos.length) {
                var desc = normalizar(fonte.val(i, "descricao"));
                var t0 = semEstrela(termos[0]);
                if (t0 && desc.indexOf(t0) === 0) pts += 100;
                else if (t0 && desc.indexOf(" " + t0) >= 0) pts += 50;
                if (termos.every(function (t) { return acha("\u0001" + desc, t); })) pts += 30;
            }
            res.push({ i: i, pts: pts });
        }
        return res;
    }

    function ordenar(fonte, res, ordem) {
        var desc = function (i) { return normalizar(fonte.val(i, "descricao")); };
        var cmpTxt = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
        var numDe = function (i, p) { var n = num(fonte.val(i, p)); return n == null ? -Infinity : n; };
        var cod = function (i) { var v = fonte.val(i, "codigo"); var n = num(v); return n != null && /^\s*\d+\s*$/.test(String(v)) ? n : Infinity; };
        var ord = {
            descricao: function (a, b) { return cmpTxt(desc(a.i), desc(b.i)); },
            codigo: function (a, b) { return (cod(a.i) - cod(b.i)) || cmpTxt(normalizar(fonte.val(a.i, "codigo")), normalizar(fonte.val(b.i, "codigo"))); },
            qtd: function (a, b) { return numDe(b.i, "qtd") - numDe(a.i, "qtd"); },
            qtdAsc: function (a, b) { return numDe(a.i, "qtd") - numDe(b.i, "qtd"); },
            preco: function (a, b) { return numDe(b.i, "preco") - numDe(a.i, "preco"); },
            precoAsc: function (a, b) { return numDe(a.i, "preco") - numDe(b.i, "preco"); }
        }[ordem];
        if (ord) res.sort(function (a, b) { return ord(a, b) || cmpTxt(desc(a.i), desc(b.i)); });
        else res.sort(function (a, b) { return (b.pts - a.pts) || cmpTxt(desc(a.i), desc(b.i)); });
        return res;
    }

    /**
     * Pesquisa paginada (mesmo formato da /api/estoque).
     * p: { q, estoque, ordem, ativos, contem, coringa, preco, pagina, limite }; resumo(i) → objeto do item.
     */
    function pesquisar(fonte, p, resumo) {
        p = p || {};
        var res = ordenar(fonte, filtrar(fonte, p.q, p), String(p.ordem || ""));
        var limite = Math.min(Math.max(parseInt(p.limite, 10) || 100, 1), 1000);
        var pagina = Math.max(parseInt(p.pagina, 10) || 1, 1);
        var ini = (pagina - 1) * limite;
        return {
            ok: true, total: res.length, totalItens: fonte.n, pagina: pagina, limite: limite,
            paginas: Math.max(1, Math.ceil(res.length / limite)),
            itens: res.slice(ini, ini + limite).map(function (r) { return resumo(r.i); }),
            _res: res
        };
    }

    return { VERSAO: VERSAO, normalizar: normalizar, soDigitos: soDigitos, num: num, lerValor: lerValor, separarPreco: separarPreco, filtrar: filtrar, ordenar: ordenar, pesquisar: pesquisar };
});
