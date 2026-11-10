/**
 * app.js — Consulta Estoque (tela)
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Tela de consulta de preço e estoque. Pensada para o leitor de
 *              código de barras USB/Bluetooth (que "digita" o código e manda
 *              Enter): o campo de busca fica sempre em foco, o texto é
 *              selecionado depois de cada leitura (a próxima substitui a
 *              anterior) e o produto lido abre num cartão de preço grande.
 *              Compatível com o Chromium 108 (versão para Windows 7/8).
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */
(function () {
    "use strict";
    var api = window.consulta;
    var $ = function (id) { return document.getElementById(id); };
    var q = $("q");
    var DIACRITICOS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
    var moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    var numero = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });

    var estado = {
        seq: 0, pagina: 1, paginas: 1, total: 0, itens: [], ultimaQ: "",
        status: null, cfg: null, info: null, cartao: null, cartaoSeq: 0, timerCartao: null,
        painel: false, aba: "modo", debounce: null, logAberto: false
    };

    // ── Utilidades ───────────────────────────────────────────────────────────
    var esc = function (s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    };
    var norm = function (s) { return String(s == null ? "" : s).normalize("NFD").replace(DIACRITICOS, "").toUpperCase(); };
    var fmtPreco = function (v) { return typeof v === "number" && isFinite(v) ? moeda.format(v) : "—"; };
    var fmtQtd = function (v) { return typeof v === "number" && isFinite(v) ? numero.format(v) : "—"; };
    var classeQtd = function (v) { return typeof v !== "number" ? "" : v > 0 ? "qtd-pos" : v < 0 ? "qtd-neg" : "qtd-zero"; };
    var fmtData = function (ms) {
        if (!ms) return "";
        var d = new Date(ms), p = function (n) { return String(n).padStart(2, "0"); };
        return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    };
    var guardar = function (k, v) { try { localStorage.setItem("consulta." + k, JSON.stringify(v)); } catch (_) {} };
    var ler = function (k, padrao) { try { var v = localStorage.getItem("consulta." + k); return v == null ? padrao : JSON.parse(v); } catch (_) { return padrao; } };

    /** Destaca os termos buscados (sem acento, sem maiúsculas) mantendo o texto original. */
    function marcar(texto, termos) {
        var t = String(texto == null ? "" : texto);
        if (!termos.length || !t) return esc(t);
        var mapa = [], n = "";
        for (var i = 0; i < t.length; i++) { var c = norm(t[i]); for (var k = 0; k < c.length; k++) mapa.push(i); n += c; }
        var marcas = new Array(t.length + 1).fill(0);
        termos.forEach(function (termo) {
            if (!termo) return;
            var pos = n.indexOf(termo);
            while (pos >= 0) {
                var ini = mapa[pos], fim = mapa[Math.min(pos + termo.length - 1, mapa.length - 1)] + 1;
                for (var j = ini; j < fim; j++) marcas[j] = 1;
                pos = n.indexOf(termo, pos + termo.length);
            }
        });
        var out = "", aberto = false;
        for (var x = 0; x < t.length; x++) {
            if (marcas[x] && !aberto) { out += "<mark>"; aberto = true; }
            if (!marcas[x] && aberto) { out += "</mark>"; aberto = false; }
            out += esc(t[x]);
        }
        return out + (aberto ? "</mark>" : "");
    }
    var termosDe = function (texto) {
        return String(texto || "").replace(/"/g, " ").split(/\s+/).filter(function (x) { return x && x[0] !== "-"; }).map(norm).filter(Boolean).slice(0, 8);
    };

    function toast(msg, ms) {
        var t = $("toast");
        t.textContent = msg;
        t.hidden = false;
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { t.hidden = true; }, ms || 3000);
    }

    // Bipe (Web Audio): agudo curto = achou; dois graves = não achou.
    var audio = null;
    function bipe(tipo) {
        if (!estado.cfg || !estado.cfg.som) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            var tocar = function (freq, ini, dur) {
                var o = audio.createOscillator(), g = audio.createGain();
                o.type = "sine"; o.frequency.value = freq;
                g.gain.setValueAtTime(0.0001, audio.currentTime + ini);
                g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + ini + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ini + dur);
                o.connect(g); g.connect(audio.destination);
                o.start(audio.currentTime + ini); o.stop(audio.currentTime + ini + dur + 0.02);
            };
            if (tipo === "erro") { tocar(330, 0, 0.14); tocar(260, 0.18, 0.18); } else tocar(1320, 0, 0.12);
        } catch (_) {}
    }

    // ── Foco: o campo de busca está sempre pronto para o leitor ─────────────
    var algoAberto = function () { return estado.painel; };
    function focarBusca(selecionar) {
        if (algoAberto()) return;
        // Voltando de outro lugar: seleciona, para a próxima leitura substituir o texto.
        if (document.activeElement !== q) { q.focus(); q.select(); }
        else if (selecionar) q.select();
    }
    var ehCampoDeTexto = function (el) {
        return !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !/^(checkbox|radio|range|button)$/i.test(el.type)) || el.isContentEditable);
    };
    q.addEventListener("blur", function () {
        setTimeout(function () {
            var a = document.activeElement;
            if (algoAberto() || ehCampoDeTexto(a) || (a && a.tagName === "SUMMARY")) return;
            focarBusca(false);
        }, 120);
    });
    window.addEventListener("focus", function () { focarBusca(false); });

    // ── Busca ────────────────────────────────────────────────────────────────
    function parametros(pagina, enter) {
        return {
            q: q.value, estoque: $("fEst").value, ordem: $("fOrd").value,
            contem: $("fCon").checked, ativos: $("fAtv").checked,
            pagina: pagina || 1, limite: estado.cfg ? estado.cfg.limitePagina : 100, enter: !!enter
        };
    }

    async function buscar(pagina, enter) {
        var meu = ++estado.seq;
        var p = parametros(pagina, enter);
        var r;
        try { r = await api.pesquisar(p); } catch (e) { r = { ok: false, mensagem: String(e && e.message || e) }; }
        if (meu !== estado.seq) return; // chegou fora de ordem: descarta
        if (!r || r.ok === false) {
            if (r && r.semDados) { mostrarVazio(); limparTabela(); }
            else toast("Falha na busca: " + (r && r.mensagem || "erro desconhecido"));
            return;
        }
        $("vazio").hidden = true;
        estado.pagina = r.pagina;
        estado.paginas = r.paginas;
        estado.total = r.total;
        estado.ultimaQ = p.q;
        estado.itens = p.pagina > 1 ? estado.itens.concat(r.itens) : r.itens;
        desenharTabela(p.pagina > 1 ? r.itens : null, termosDe(p.q));
        desenharContador(r);
        if (enter) {
            if (r.abrir) { abrirCartao(r.abrir); bipe("ok"); }
            else if (r.total === 0 && String(p.q).trim()) { cartaoNaoAchou(p.q); bipe("erro"); }
            else if (r.total > 0) fecharCartao(false);
            focarBusca(true); // a próxima leitura substitui o código anterior
        }
    }

    function limparTabela() { $("corpo").innerHTML = ""; $("bMais").hidden = true; $("res").textContent = ""; }

    function linhaHtml(it, idx, termos) {
        var bar = it.barras || "";
        if (it.referencia && it.referencia !== bar) bar += (bar ? " / " : "") + it.referencia;
        return '<tr data-idx="' + idx + '"' + (it.ativo === false ? ' class="inat"' : "") + ">" +
            '<td class="cod">' + marcar(it.codigo, termos) + "</td>" +
            "<td>" + marcar(it.descricao, termos) + (it.ativo === false ? '<span class="etq">inativo</span>' : "") + "</td>" +
            '<td class="bar">' + marcar(bar, termos) + "</td>" +
            '<td class="num ' + classeQtd(it.qtd) + '">' + fmtQtd(it.qtd) + "</td>" +
            "<td>" + esc(it.unidade || "") + "</td>" +
            '<td class="num preco">' + fmtPreco(it.preco) + "</td>" +
            '<td class="num cust">' + fmtPreco(it.custo) + "</td></tr>";
    }

    function desenharTabela(novos, termos) {
        var corpo = $("corpo");
        if (novos) {
            var base = estado.itens.length - novos.length;
            corpo.insertAdjacentHTML("beforeend", novos.map(function (it, k) { return linhaHtml(it, base + k, termos); }).join(""));
        } else {
            corpo.innerHTML = estado.itens.map(function (it, k) { return linhaHtml(it, k, termos); }).join("");
            $("principal").scrollTop = 0;
        }
        var restam = estado.total - estado.itens.length;
        $("bMais").hidden = restam <= 0;
        $("bMais").textContent = "Carregar mais (" + restam.toLocaleString("pt-BR") + " restantes)";
    }

    function desenharContador(r) {
        var partes = [];
        partes.push(r.q || estado.ultimaQ ? "mostrando " + estado.itens.length.toLocaleString("pt-BR") + " de " + r.total.toLocaleString("pt-BR") + " encontrados"
            : r.total.toLocaleString("pt-BR") + " itens");
        partes.push(r.totalItens.toLocaleString("pt-BR") + " itens no estoque");
        if (r.somaQtd != null) partes.push("estoque somado: " + numero.format(r.somaQtd));
        if (r.somaValorVenda != null) partes.push("valor de venda em estoque: " + moeda.format(r.somaValorVenda));
        $("res").textContent = partes.join(" · ");
    }

    // ── Cartão de preço ──────────────────────────────────────────────────────
    function preencherCartao(it, aoVivo) {
        var c = $("cartao");
        c.classList.remove("nao-achou");
        $("cCod").textContent = "Código " + (it.codigo != null ? it.codigo : "—");
        $("cDesc").textContent = it.descricao || "(sem descrição)";
        $("cPreco").textContent = fmtPreco(it.preco);
        var cq = $("cQtd");
        cq.textContent = fmtQtd(it.qtd);
        cq.className = classeQtd(it.qtd);
        $("cUn").textContent = it.unidade || "—";
        $("cBar").textContent = it.barras || it.referencia || "—";
        var mostraCusto = !!(estado.cfg && estado.cfg.mostrarCusto) && typeof it.custo === "number";
        $("cCustoBox").hidden = !mostraCusto;
        $("cCusto").textContent = fmtPreco(it.custo);
        $("cMinBox").hidden = typeof it.qtdMin !== "number";
        $("cMin").textContent = fmtQtd(it.qtdMin);
        var selo = $("cSelo");
        selo.hidden = !(aoVivo || it.ativo === false);
        selo.className = "selo " + (it.ativo === false ? "inativo" : "vivo");
        selo.textContent = it.ativo === false ? "Inativo" : "Ao vivo";
        c.hidden = false;
    }

    async function abrirCartao(it) {
        estado.cartao = it;
        var meu = ++estado.cartaoSeq;
        preencherCartao(it, false);
        $("cAviso").hidden = true;
        $("cCampos").innerHTML = "";
        marcarLinha(it);
        agendarFecharCartao();
        var det;
        try { det = await api.item({ i: it.i, versao: it.versao, codigo: it.codigo }); } catch (_) { det = null; }
        if (meu !== estado.cartaoSeq || !det) return;
        if (det.ok === false) { $("cAviso").textContent = det.mensagem || "Detalhes indisponíveis."; $("cAviso").hidden = false; return; }
        if (det.resumo) { estado.cartao = det.resumo; preencherCartao(det.resumo, !!det.aoVivo); atualizarLinha(det.resumo); }
        var avisos = [];
        if (it.foraDoFiltro) avisos.push("Este produto não aparece na lista por causa dos filtros escolhidos.");
        if (det.avisoAoVivo) avisos.push(det.avisoAoVivo);
        if (avisos.length) { $("cAviso").textContent = avisos.join(" "); $("cAviso").hidden = false; }
        $("cCampos").innerHTML = (det.campos || []).map(function (c) {
            var v = c.valor;
            if (v == null || v === "") v = "—";
            else if (c.tipo === "TIMESTAMP" || c.tipo === "DATE") { var d = new Date(v); v = isNaN(d.getTime()) ? v : d.toLocaleString("pt-BR"); }
            return "<dt>" + esc(c.nome) + "</dt><dd>" + esc(v) + "</dd>";
        }).join("");
    }

    function cartaoNaoAchou(texto) {
        estado.cartao = null;
        estado.cartaoSeq++;
        var c = $("cartao");
        c.classList.add("nao-achou");
        $("cCod").textContent = "Código lido: " + String(texto).trim();
        $("cDesc").textContent = "Produto não encontrado";
        $("cPreco").textContent = "Confira o código ou procure pelo nome.";
        ["cQtd", "cUn", "cBar"].forEach(function (id) { $(id).textContent = "—"; $(id).className = ""; });
        $("cCustoBox").hidden = true; $("cMinBox").hidden = true; $("cSelo").hidden = true;
        $("cAviso").hidden = true; $("cCampos").innerHTML = "";
        c.hidden = false;
        agendarFecharCartao();
    }

    function fecharCartao(limparBusca) {
        clearTimeout(estado.timerCartao);
        estado.cartaoSeq++;
        estado.cartao = null;
        $("cartao").hidden = true;
        $("cMais").open = false;
        marcarLinha(null);
        if (limparBusca && q.value) { q.value = ""; $("bLimpar").hidden = true; buscar(1); }
    }

    function agendarFecharCartao() {
        clearTimeout(estado.timerCartao);
        var s = estado.cfg ? estado.cfg.fecharDetalheSeg : 0;
        if (s > 0) estado.timerCartao = setTimeout(function () { fecharCartao(true); }, s * 1000);
    }

    function marcarLinha(it) {
        var linhas = $("corpo").querySelectorAll("tr.sel");
        for (var i = 0; i < linhas.length; i++) linhas[i].classList.remove("sel");
        if (!it) return;
        for (var k = 0; k < estado.itens.length; k++) {
            if (estado.itens[k].i === it.i && estado.itens[k].versao === it.versao) {
                var tr = $("corpo").querySelector('tr[data-idx="' + k + '"]');
                if (tr) tr.classList.add("sel");
                break;
            }
        }
    }
    function atualizarLinha(it) {
        for (var k = 0; k < estado.itens.length; k++) {
            var x = estado.itens[k];
            if (x.codigo === it.codigo && x.versao === it.versao) {
                estado.itens[k] = it;
                var tr = $("corpo").querySelector('tr[data-idx="' + k + '"]');
                if (tr) { tr.outerHTML = linhaHtml(it, k, termosDe(estado.ultimaQ)); marcarLinha(it); }
                break;
            }
        }
    }

    // ── Situação (topo) e tela vazia ─────────────────────────────────────────
    var NOMES_METODO = { gbak: "cópia gbak", instantaneo: "cópia instantânea", direto: "leitura direta" };
    function desenharStatus(s) {
        if (!s) return;
        estado.status = s;
        var ponto = $("estadoPonto"), txt = $("estadoTexto");
        var partes = [];
        var classe = "ok";
        if (s.procurando) { classe = "girando"; partes.push("Procurando o banco..."); }
        else if (s.ocupado && !s.itens) { classe = "girando"; partes.push(s.mensagem || "Carregando..."); }
        else if (s.estado === "erro") { classe = "ruim"; partes.push("Sem conexão com o banco"); }
        else if (s.itens) {
            if (s.erro) classe = "alerta";
            if (s.ocupado) classe = "girando";
            partes.push((s.dadosDoDisco ? "Dados salvos de " : "Atualizado em ") + fmtData(s.carregadoEm));
            partes.push(s.itens.toLocaleString("pt-BR") + " itens");
            if (s.metodoEfetivo) partes.push(NOMES_METODO[s.metodoEfetivo] || s.metodoEfetivo);
            if (s.ocupado) partes.push("atualizando...");
        } else { classe = "girando"; partes.push(s.mensagem || "Iniciando..."); }
        ponto.className = "ponto " + classe;
        txt.textContent = partes.join(" · ");
        $("estado").title = (s.mensagem || "") + (s.erro ? "\n" + s.erro : "") + (s.fonte ? "\nBanco: " + s.fonte.host + ":" + s.fonte.caminho : "");
        var aviso = $("aviso");
        if (s.erro && s.itens) { aviso.className = "aviso alerta"; aviso.textContent = "Mostrando o estoque de " + fmtData(s.carregadoEm) + ". " + s.erro; aviso.hidden = false; }
        else aviso.hidden = true;
        $("bCancelarCopia").hidden = !(s.copia && s.copia.emAndamento);
        $("bAtualizar").disabled = !!s.ocupado && !s.copia.emAndamento;
        if (!s.itens) mostrarVazio();
        if (estado.painel && estado.aba === "banco") desenharInfoBanco();
    }

    function mostrarVazio() {
        var s = estado.status || {};
        var v = $("vazio");
        var carregando = !s.erro && s.estado !== "erro";
        v.classList.toggle("carregando", carregando);
        $("vazioTitulo").textContent = carregando ? (s.procurando ? "Procurando o banco do Small Commerce..." : "Carregando o estoque...") : "Não foi possível carregar o estoque";
        $("vazioTexto").textContent = carregando ? "Na primeira vez pode levar alguns instantes. Depois o estoque fica salvo neste computador e aparece na hora." : (s.erro || s.mensagem || "");
        $("bVazioProcurar").hidden = carregando;
        $("bVazioTentar").hidden = carregando;
        v.hidden = false;
    }

    // ── Configurações ────────────────────────────────────────────────────────
    function aplicarAparencia(cfg) {
        var raiz = document.documentElement;
        if (cfg.tema === "auto") raiz.removeAttribute("data-tema"); else raiz.setAttribute("data-tema", cfg.tema);
        document.body.classList.toggle("leve", !!cfg.modoLeve);
        document.body.classList.toggle("custo", !!cfg.mostrarCusto);
        $("fCus").checked = !!cfg.mostrarCusto;
        $("loja").textContent = cfg.nomeLoja || "";
        $("loja").hidden = !cfg.nomeLoja;
    }

    function abrirPainel(aba) {
        estado.painel = true;
        preencherFormulario(estado.cfg);
        $("fundo").hidden = false;
        $("painel").hidden = false;
        trocarAba(aba || estado.aba);
    }
    function fecharPainel() {
        estado.painel = false;
        estado.logAberto = false;
        $("fundo").hidden = true;
        $("painel").hidden = true;
        focarBusca(true);
    }
    function trocarAba(aba) {
        estado.aba = aba;
        var botoes = $("abas").querySelectorAll("button");
        for (var i = 0; i < botoes.length; i++) botoes[i].classList.toggle("ativa", botoes[i].getAttribute("data-aba") === aba);
        var pags = document.querySelectorAll("[data-pagina]");
        for (var k = 0; k < pags.length; k++) pags[k].hidden = pags[k].getAttribute("data-pagina") !== aba;
        estado.logAberto = aba === "diag";
        if (aba === "banco") desenharInfoBanco();
        if (aba === "diag") carregarDiagnostico();
    }

    function desenharInfoBanco() {
        var s = estado.status || {};
        var html = "";
        if (s.fonte) html += "<b>Banco em uso:</b> " + esc(s.fonte.host + ":" + s.fonte.caminho) + (s.fbHostAuto ? " <i>(encontrado automaticamente)</i>" : "") + "<br>";
        else html += "<b>Banco:</b> ainda não definido — o aplicativo procura sozinho na rede.<br>";
        html += "<b>Situação:</b> " + esc(s.mensagem || "") + (s.erro ? "<br><b>Último erro:</b> " + esc(s.erro) : "");
        if (s.copia && s.copia.emAndamento) html += "<br><b>Cópia:</b> " + esc(s.copia.etapa === "restauracao" ? "restaurando" : "fazendo o backup") + " há " + Math.round(s.copia.decorridoMs / 1000) + " s";
        $("infoBanco").innerHTML = html;
    }

    async function carregarDiagnostico() {
        var i = estado.info || {};
        $("infoApp").innerHTML = "<b>Consulta Estoque</b> " + esc(i.versao) + " (" + esc(i.variante) + ")" + (i.demo ? " — <b>demonstração</b>" : "") +
            "<br><b>Sistema:</b> " + esc(i.sistema) + "<br><b>Electron</b> " + esc(i.electron) + " · <b>Chromium</b> " + esc(i.chrome) + " · <b>Node</b> " + esc(i.node) +
            "<br><b>Pasta de dados:</b> " + esc(i.pastaDados);
        try { var linhas = await api.log(); $("log").textContent = (linhas || []).slice(-250).join("\n"); $("log").scrollTop = 1e9; } catch (_) {}
    }

    function marcarModo() {
        var modo = document.querySelector('input[name="modo"]:checked');
        var v = modo ? modo.value : "copia";
        var cards = document.querySelectorAll(".modo-card");
        for (var i = 0; i < cards.length; i++) cards[i].classList.toggle("marcado", cards[i].querySelector("input").checked);
        $("gCopia").hidden = v !== "copia";
        $("gDireto").hidden = v !== "direto";
    }

    function preencherFormulario(c) {
        if (!c) return;
        var r = document.querySelector('input[name="modo"][value="' + c.modo + '"]');
        if (r) r.checked = true;
        marcarModo();
        $("cfgMetodo").value = c.metodoCopia; $("cfgCopiaMin").value = c.copiaACadaMin;
        $("cfgDiretoSeg").value = c.diretoRecarregarSeg; $("cfgAoVivo").checked = c.diretoItemAoVivo;
        $("cfgHost").value = c.fbHost; $("cfgPorta").value = c.fbPorta; $("cfgPath").value = c.fdbPath;
        $("cfgUser").value = c.fbUser; $("cfgPass").value = c.fbPass; $("cfgPass").type = "password";
        $("cfgFixo").checked = c.fbHostFixo; $("cfgVarrer").checked = c.varrerRede;
        $("cfgGbak").value = c.gbakPath; $("cfgPasta").value = c.pastaCopias; $("cfgTimeout").value = c.copiaTimeoutMin;
        $("cfgLoja").value = c.nomeLoja; $("cfgTema").value = c.tema; $("cfgZoom").value = c.zoom; $("oZoom").textContent = Math.round(c.zoom * 100) + "%";
        $("cfgFechar").value = c.fecharDetalheSeg; $("cfgSom").checked = c.som; $("cfgTab").checked = c.tabComoEnter;
        $("cfgLeve").checked = c.modoLeve; $("cfgCheia").checked = c.telaCheia; $("cfgTopo").checked = c.sempreNoTopo;
        $("cfgIniciar").checked = c.iniciarComWindows; $("cfgGpu").checked = c.aceleracaoGrafica;
    }

    function lerFormulario() {
        var modo = document.querySelector('input[name="modo"]:checked');
        return {
            modo: modo ? modo.value : "copia",
            metodoCopia: $("cfgMetodo").value, copiaACadaMin: $("cfgCopiaMin").value,
            diretoRecarregarSeg: $("cfgDiretoSeg").value, diretoItemAoVivo: $("cfgAoVivo").checked,
            fbHost: $("cfgHost").value.trim(), fbPorta: $("cfgPorta").value, fdbPath: $("cfgPath").value.trim(),
            fbUser: $("cfgUser").value.trim(), fbPass: $("cfgPass").value,
            fbHostFixo: $("cfgFixo").checked, varrerRede: $("cfgVarrer").checked,
            gbakPath: $("cfgGbak").value.trim(), pastaCopias: $("cfgPasta").value.trim(), copiaTimeoutMin: $("cfgTimeout").value,
            nomeLoja: $("cfgLoja").value.trim(), tema: $("cfgTema").value, zoom: Number($("cfgZoom").value),
            fecharDetalheSeg: $("cfgFechar").value, som: $("cfgSom").checked, tabComoEnter: $("cfgTab").checked,
            modoLeve: $("cfgLeve").checked, telaCheia: $("cfgCheia").checked, sempreNoTopo: $("cfgTopo").checked,
            iniciarComWindows: $("cfgIniciar").checked, aceleracaoGrafica: $("cfgGpu").checked
        };
    }

    async function salvarConfig(parcial, fechar) {
        var r;
        try { r = await api.salvarConfig(parcial); } catch (e) { r = { ok: false, mensagem: String(e && e.message || e) }; }
        if (!r || r.ok === false) { toast("Não foi possível salvar: " + (r && r.mensagem || "erro")); return false; }
        estado.cfg = r.cfg;
        aplicarAparencia(r.cfg);
        if (fechar) { fecharPainel(); toast("Configurações salvas."); }
        if (r.reiniciar && window.confirm("A aceleração gráfica só muda depois de reiniciar o aplicativo. Reiniciar agora?")) api.reiniciar();
        return true;
    }

    // ── Eventos ──────────────────────────────────────────────────────────────
    q.addEventListener("input", function () {
        $("bLimpar").hidden = !q.value;
        clearTimeout(estado.debounce);
        estado.debounce = setTimeout(function () { buscar(1); }, 220);
    });
    q.addEventListener("keydown", function (e) {
        var tab = e.key === "Tab" && !e.shiftKey && estado.cfg && estado.cfg.tabComoEnter && q.value.trim();
        if (e.key === "Enter" || tab) {
            e.preventDefault();
            clearTimeout(estado.debounce);
            buscar(1, true);
        }
    });
    $("bLimpar").addEventListener("click", function () { q.value = ""; $("bLimpar").hidden = true; fecharCartao(false); buscar(1); focarBusca(false); });

    ["fEst", "fOrd", "fCon", "fAtv"].forEach(function (id) {
        $(id).addEventListener("change", function () {
            guardar(id, $(id).type === "checkbox" ? $(id).checked : $(id).value);
            buscar(1);
            focarBusca(false);
        });
    });
    $("fCus").addEventListener("change", function () { salvarConfig({ mostrarCusto: $("fCus").checked }, false); focarBusca(false); });

    $("corpo").addEventListener("click", function (e) {
        var tr = e.target.closest("tr[data-idx]");
        if (!tr) return;
        var it = estado.itens[Number(tr.getAttribute("data-idx"))];
        if (it) { abrirCartao(it); $("principal").scrollTop = 0; }
        focarBusca(false);
    });
    $("bMais").addEventListener("click", function () { buscar(estado.pagina + 1); focarBusca(false); });
    $("principal").addEventListener("scroll", function () {
        var m = $("principal");
        if (!$("bMais").hidden && m.scrollTop + m.clientHeight > m.scrollHeight - 300 && !buscar.carregandoMais) {
            buscar.carregandoMais = true;
            buscar(estado.pagina + 1).then(function () { buscar.carregandoMais = false; }, function () { buscar.carregandoMais = false; });
        }
    });
    $("bFecharCartao").addEventListener("click", function () { fecharCartao(false); focarBusca(true); });

    $("bAtualizar").addEventListener("click", function () { api.atualizar(); toast("Atualizando o estoque..."); focarBusca(false); });
    $("bTela").addEventListener("click", function () { api.telaCheia(); focarBusca(false); });
    $("bConfig").addEventListener("click", function () { abrirPainel(); });
    $("estado").addEventListener("click", function () { abrirPainel("banco"); });
    $("bVazioProcurar").addEventListener("click", function () { api.procurarBanco(); toast("Procurando o banco na rede e nesta máquina..."); });
    $("bVazioTentar").addEventListener("click", function () { api.atualizar(); });
    $("bVazioConfig").addEventListener("click", function () { abrirPainel("banco"); });
    $("bCsv").addEventListener("click", async function () {
        var r = await api.exportarCsv(parametros(1));
        if (r && r.ok) toast(r.linhas.toLocaleString("pt-BR") + " itens exportados.");
        else if (r && !r.cancelado) toast("Não foi possível exportar: " + (r.mensagem || "erro"));
        focarBusca(false);
    });

    $("abas").addEventListener("click", function (e) { var b = e.target.closest("button[data-aba]"); if (b) trocarAba(b.getAttribute("data-aba")); });
    $("fundo").addEventListener("click", fecharPainel);
    $("bFecharPainel").addEventListener("click", fecharPainel);
    $("bCancelar").addEventListener("click", fecharPainel);
    $("bSalvar").addEventListener("click", function () { salvarConfig(lerFormulario(), true); });
    var radios = document.querySelectorAll('input[name="modo"]');
    for (var r = 0; r < radios.length; r++) radios[r].addEventListener("change", marcarModo);
    $("cfgZoom").addEventListener("input", function () { $("oZoom").textContent = Math.round(Number($("cfgZoom").value) * 100) + "%"; });
    $("bVerSenha").addEventListener("click", function () { var p = $("cfgPass"); p.type = p.type === "password" ? "text" : "password"; $("bVerSenha").textContent = p.type === "password" ? "Ver" : "Ocultar"; });
    $("bProcurar").addEventListener("click", async function () {
        $("bProcurar").disabled = true;
        toast("Procurando o banco na rede e nesta máquina...", 5000);
        try {
            var ok = await api.procurarBanco();
            estado.cfg = await api.lerConfig();
            preencherFormulario(estado.cfg);
            toast(ok ? "Banco encontrado." : "Banco não encontrado — veja o motivo em Situação.", 5000);
        } finally { $("bProcurar").disabled = false; }
    });
    $("bCancelarCopia").addEventListener("click", function () { api.cancelarCopia(); toast("Cópia cancelada."); });
    $("bPasta").addEventListener("click", function () { api.abrirPastaDados(); });
    $("bCopiarLog").addEventListener("click", function () {
        try { navigator.clipboard.writeText($("log").textContent).then(function () { toast("Log copiado."); }, function () { toast("Não foi possível copiar."); }); }
        catch (_) { toast("Não foi possível copiar."); }
    });

    // Teclado: atalhos e o leitor de código de barras.
    document.addEventListener("keydown", function (e) {
        var k = e.key;
        if (k === "Escape") {
            if (estado.painel) { fecharPainel(); e.preventDefault(); return; }
            if (!$("cartao").hidden) { fecharCartao(false); focarBusca(true); e.preventDefault(); return; }
            if (document.activeElement === q && q.value) { q.value = ""; $("bLimpar").hidden = true; buscar(1); e.preventDefault(); }
            return;
        }
        if (k === "F5") { e.preventDefault(); api.atualizar(); toast("Atualizando o estoque..."); return; }
        if (k === "F10" || (e.ctrlKey && k === ",")) { e.preventDefault(); if (estado.painel) fecharPainel(); else abrirPainel(); return; }
        if (k === "F2" || k === "F3" || (e.ctrlKey && (k === "f" || k === "F"))) { e.preventDefault(); fecharPainel(); focarBusca(true); return; }
        if (e.ctrlKey && (k === "=" || k === "+" || k === "-" || k === "0")) {
            e.preventDefault();
            var z = estado.cfg ? estado.cfg.zoom : 1;
            z = k === "0" ? 1 : Math.round((z + (k === "-" ? -0.1 : 0.1)) * 100) / 100;
            api.zoom(z).then(function (novo) { if (estado.cfg) estado.cfg.zoom = novo; toast("Tamanho do texto: " + Math.round(novo * 100) + "%", 1200); });
            return;
        }
        // Tecla de texto fora de um campo (ex.: leitura com o foco num botão): vai para a busca.
        if (!estado.painel && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !ehCampoDeTexto(document.activeElement)) {
            q.focus();
            q.select();
        }
    }, true);

    // ── Início ───────────────────────────────────────────────────────────────
    async function iniciar() {
        $("fEst").value = ler("fEst", "todos");
        $("fOrd").value = ler("fOrd", "");
        $("fCon").checked = ler("fCon", true) !== false;
        $("fAtv").checked = !!ler("fAtv", false);
        try { estado.info = await api.info(); } catch (_) {}
        try { estado.cfg = await api.lerConfig(); aplicarAparencia(estado.cfg); } catch (_) {}
        api.aoStatus(desenharStatus);
        api.aoDadosNovos(function () {
            // Estoque novo: refaz a busca atual sem mexer no que a pessoa digitou.
            buscar(1);
            if (estado.cartao) abrirCartao(Object.assign({}, estado.cartao, { versao: "" }));
        });
        api.aoLog(function (linha) {
            if (!estado.logAberto) return;
            var el = $("log");
            var noFim = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
            el.textContent += (el.textContent ? "\n" : "") + linha;
            if (noFim) el.scrollTop = 1e9;
        });
        try { desenharStatus(await api.status()); } catch (_) {}
        if (estado.info && estado.info.demo) toast("Modo demonstração: produtos de exemplo, sem banco.", 5000);
        await buscar(1);
        focarBusca(false);
    }
    iniciar();
})();
