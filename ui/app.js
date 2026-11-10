/**
 * app.js — Consulta Estoque (tela)
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Tela de consulta de preço e estoque. Pensada para o leitor de
 *              código de barras USB/Bluetooth (que "digita" o código e manda
 *              Enter): o campo de busca fica sempre em foco, o texto é
 *              selecionado depois de cada leitura (a próxima substitui a
 *              anterior) e o produto lido abre num cartão de preço grande.
 *              Compatível com o Chromium 108 (versão para Windows 7/8).
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — Senha do administrador (criada na primeira execução; abas Consulta,
 *           Banco de dados, Windows e Administrador travadas), saída com senha
 *           (Ctrl+Shift+Q), modo manutenção, aba Windows, limpeza automática da
 *           busca e do cartão após 1 minuto sem mexer, cursor oculto quando parado.
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
    var algoAberto = function () { return estado.painel || estado.modal; };
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

    // A limpeza automática (inatividade) cuida de fechar o cartão; ler um produto conta como atividade.
    function agendarFecharCartao() { reiniciarInatividade(); }

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
        $("loja").textContent = cfg.nomeLoja || "";
        $("loja").hidden = !cfg.nomeLoja;
        if (!cfg.ocultarCursor) document.body.classList.remove("sem-cursor");
        reiniciarInatividade();
    }

    // ── Administrador: trava das abas sensíveis ──────────────────────────────
    var ABAS_PROTEGIDAS = { consulta: 1, banco: 1, windows: 1, admin: 1 };
    var livre = function () { return !!(estado.admin && estado.admin.desbloqueado); };
    function desenharTrava() {
        var a = estado.admin || {};
        var cad = $("cadeado");
        cad.textContent = !a.temSenha ? "Sem senha definida" : a.desbloqueado ? "🔓 Administrador" : "🔒 Bloqueado";
        cad.classList.toggle("aberto", !!a.desbloqueado);
        $("abas").classList.toggle("livre", !!a.desbloqueado);
        var protegida = !!ABAS_PROTEGIDAS[estado.aba];
        var travada = protegida && !livre();
        $("trava").hidden = !travada;
        var pags = document.querySelectorAll("[data-pagina]");
        for (var k = 0; k < pags.length; k++) pags[k].hidden = travada || pags[k].getAttribute("data-pagina") !== estado.aba;
        if (travada && estado.painel) setTimeout(function () { $("travaSenha").focus(); }, 30);
    }
    async function atualizarAdmin() {
        try { estado.admin = await api.adminEstado(); } catch (_) {}
        desenharTrava();
        return estado.admin;
    }
    async function desbloquear() {
        var senha = $("travaSenha").value;
        var r = await api.desbloquear(senha);
        if (!r || !r.ok) { $("travaErro").textContent = (r && r.mensagem) || "Senha incorreta."; $("travaSenha").select(); return; }
        $("travaSenha").value = "";
        $("travaErro").textContent = "";
        estado.admin = r.estado;
        // Desbloqueado: recarrega a configuração completa (com a senha do Firebird).
        try { estado.cfg = await api.lerConfig(); } catch (_) {}
        preencherFormulario(estado.cfg);
        trocarAba(estado.aba);
    }

    async function abrirPainel(aba) {
        estado.painel = true;
        await atualizarAdmin();
        try { estado.cfg = await api.lerConfig(); } catch (_) {}
        try { estado.info = await api.info(); } catch (_) {}
        preencherFormulario(estado.cfg);
        $("fundo").hidden = false;
        $("painel").hidden = false;
        trocarAba(aba || estado.aba);
    }
    function fecharPainel() {
        if (!estado.painel) return;
        estado.painel = false;
        estado.logAberto = false;
        $("fundo").hidden = true;
        $("painel").hidden = true;
        $("travaSenha").value = "";
        $("travaErro").textContent = "";
        // Fechou as configurações: o administrador sai (a tela é pública).
        if (estado.admin && estado.admin.temSenha) api.bloquear().then(function (a) { estado.admin = a; }, function () {});
        focarBusca(true);
    }
    function trocarAba(aba) {
        estado.aba = aba;
        var botoes = $("abas").querySelectorAll("button");
        for (var i = 0; i < botoes.length; i++) botoes[i].classList.toggle("ativa", botoes[i].getAttribute("data-aba") === aba);
        desenharTrava();
        estado.logAberto = aba === "diag";
        $("bSalvar").hidden = aba === "diag" || aba === "admin" || (!!ABAS_PROTEGIDAS[aba] && !livre());
        if (aba === "banco") desenharInfoBanco();
        if (aba === "diag") carregarDiagnostico();
        if (aba === "admin") desenharInfoAdmin();
        if (aba === "windows") desenharWindows();
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
    function desenharInfoAdmin() {
        var a = estado.admin || {};
        $("infoAdmin").innerHTML = (a.temSenha ? "<b>Senha do administrador:</b> definida." : "<b>Atenção:</b> nenhuma senha definida — qualquer pessoa pode mudar as configurações e sair do aplicativo. Defina uma senha abaixo.") +
            "<br><b>Modo quiosque:</b> " + (a.quiosque ? (a.manutencao ? "suspenso (manutenção)" : "ligado — tela cheia permanente") : "desligado (desenvolvimento)") +
            "<br><b>Persistência:</b> " + (a.podePersistir ? (estado.info && estado.info.vigiaAtivo ? "vigia ativo" : "vigia parado") : "só no aplicativo instalado/portátil");
        $("bManutencao").textContent = a.manutencao ? "Voltar para a tela cheia" : "Modo manutenção (sair da tela cheia)";
        $("bManutencao").hidden = !a.quiosque;
    }
    function desenharWindows() {
        var a = estado.admin || {};
        $("dicaPersistir").textContent = a.podePersistir ? "" : "Persistência e \"Abrir junto com o Windows\" funcionam no aplicativo instalado ou portátil (não no modo demonstração).";
    }

    async function carregarDiagnostico() {
        try { estado.info = await api.info(); } catch (_) {}
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

    function preencherMonitores(atual) {
        var lista = (estado.info && estado.info.monitores) || [];
        if (!lista.length) lista = [{ i: 0, nome: "Monitor 1" }];
        $("cfgMonitor").innerHTML = lista.map(function (m) { return '<option value="' + m.i + '">' + esc(m.nome) + "</option>"; }).join("");
        $("cfgMonitor").value = String(atual || 0);
        if ($("cfgMonitor").value !== String(atual || 0)) $("cfgMonitor").value = "0";
    }

    function preencherFormulario(c) {
        if (!c) return;
        var r = document.querySelector('input[name="modo"][value="' + c.modo + '"]');
        if (r) r.checked = true;
        marcarModo();
        $("cfgMetodo").value = c.metodoCopia; $("cfgCopiaMin").value = c.copiaACadaMin;
        $("cfgDiretoSeg").value = c.diretoRecarregarSeg; $("cfgAoVivo").checked = c.diretoItemAoVivo;
        $("cfgHost").value = c.fbHost; $("cfgPorta").value = c.fbPorta; $("cfgPath").value = c.fdbPath;
        $("cfgUser").value = c.fbUser; $("cfgPass").value = c.fbPass == null ? "" : c.fbPass; $("cfgPass").type = "password";
        $("cfgFixo").checked = c.fbHostFixo; $("cfgVarrer").checked = c.varrerRede;
        $("cfgGbak").value = c.gbakPath; $("cfgPasta").value = c.pastaCopias; $("cfgTimeout").value = c.copiaTimeoutMin;
        $("cfgLoja").value = c.nomeLoja; $("cfgLimpar").value = c.limparAposSeg; $("cfgCusto").checked = c.mostrarCusto;
        $("cfgTema").value = c.tema; $("cfgZoom").value = c.zoom; $("oZoom").textContent = Math.round(c.zoom * 100) + "%";
        $("cfgSom").checked = c.som; $("cfgTab").checked = c.tabComoEnter; $("cfgLeve").checked = c.modoLeve;
        $("cfgIniciar").checked = c.iniciarComWindows; $("cfgPersistente").checked = c.persistente; $("cfgTopo").checked = c.sempreNoTopo;
        $("cfgFoco").checked = c.manterFoco; $("cfgDescanso").checked = c.impedirDescanso; $("cfgBarra").checked = c.ocultarBarraTarefas;
        $("cfgCursor").checked = c.ocultarCursor; $("cfgReiniciar").value = c.reiniciarDiario || ""; $("cfgGpu").checked = c.aceleracaoGrafica;
        preencherMonitores(c.monitor);
        estado.fbPassCarregada = c.fbPass != null;
    }

    function lerFormulario() {
        // Tela pública: só as opções visuais. Desbloqueado: todas.
        var o = {
            tema: $("cfgTema").value, zoom: Number($("cfgZoom").value),
            som: $("cfgSom").checked, tabComoEnter: $("cfgTab").checked, modoLeve: $("cfgLeve").checked
        };
        if (!livre()) return o;
        var modo = document.querySelector('input[name="modo"]:checked');
        Object.assign(o, {
            modo: modo ? modo.value : "copia",
            metodoCopia: $("cfgMetodo").value, copiaACadaMin: $("cfgCopiaMin").value,
            diretoRecarregarSeg: $("cfgDiretoSeg").value, diretoItemAoVivo: $("cfgAoVivo").checked,
            nomeLoja: $("cfgLoja").value.trim(), limparAposSeg: $("cfgLimpar").value, mostrarCusto: $("cfgCusto").checked,
            fbHost: $("cfgHost").value.trim(), fbPorta: $("cfgPorta").value, fdbPath: $("cfgPath").value.trim(),
            fbUser: $("cfgUser").value.trim(),
            fbHostFixo: $("cfgFixo").checked, varrerRede: $("cfgVarrer").checked,
            gbakPath: $("cfgGbak").value.trim(), pastaCopias: $("cfgPasta").value.trim(), copiaTimeoutMin: $("cfgTimeout").value,
            iniciarComWindows: $("cfgIniciar").checked, persistente: $("cfgPersistente").checked, sempreNoTopo: $("cfgTopo").checked,
            manterFoco: $("cfgFoco").checked, impedirDescanso: $("cfgDescanso").checked, ocultarBarraTarefas: $("cfgBarra").checked,
            ocultarCursor: $("cfgCursor").checked, reiniciarDiario: $("cfgReiniciar").value, monitor: Number($("cfgMonitor").value) || 0,
            aceleracaoGrafica: $("cfgGpu").checked
        });
        // Só envia a senha do Firebird se ela foi carregada (nunca apaga por engano).
        if (estado.fbPassCarregada) o.fbPass = $("cfgPass").value;
        return o;
    }

    async function salvarConfig(parcial, fechar) {
        var r;
        try { r = await api.salvarConfig(parcial); } catch (e) { r = { ok: false, mensagem: String(e && e.message || e) }; }
        if (r && r.precisaSenha) { await atualizarAdmin(); toast("Desbloqueie com a senha do administrador para salvar estas configurações."); return false; }
        if (!r || r.ok === false) { toast("Não foi possível salvar: " + (r && r.mensagem || "erro")); return false; }
        estado.cfg = r.cfg;
        aplicarAparencia(r.cfg);
        if (fechar) { fecharPainel(); toast("Configurações salvas."); }
        if (r.reiniciar) {
            var sim = await perguntar({ titulo: "Reiniciar agora?", texto: "A aceleração gráfica só muda depois de reiniciar o aplicativo.", senha: false, ok: "Reiniciar" });
            if (sim) api.reiniciar();
        }
        return true;
    }

    // ── Janela de senha / confirmação ────────────────────────────────────────
    // perguntar({ titulo, texto, senha, repetir, ok, cancelar, validar(v1, v2) → Promise<mensagem de erro | null> })
    // Resolve com o valor digitado (ou true) ao confirmar, null ao cancelar.
    function perguntar(o) {
        return new Promise(function (resolve) {
            estado.modal = true;
            $("modalTitulo").textContent = o.titulo || "";
            $("modalTexto").textContent = o.texto || "";
            $("modalSenha").hidden = !o.senha; $("modalSenha").value = "";
            $("modalSenha2").hidden = !o.repetir; $("modalSenha2").value = "";
            $("modalErro").textContent = "";
            $("modalOk").textContent = o.ok || "OK";
            $("modalOk").disabled = false;
            $("modalCancelar").hidden = o.cancelar === false;
            $("modalFundo").hidden = false; $("modal").hidden = false;
            setTimeout(function () { (o.senha ? $("modalSenha") : $("modalOk")).focus(); }, 30);
            var terminar = function (v) {
                estado.modal = false;
                $("modalFundo").hidden = true; $("modal").hidden = true;
                $("modalOk").onclick = null; $("modalCancelar").onclick = null; perguntar.tecla = null;
                $("modalSenha").value = ""; $("modalSenha2").value = "";
                resolve(v);
                focarBusca(false);
            };
            var confirmar = async function () {
                if ($("modalOk").disabled) return;
                var v1 = $("modalSenha").value, v2 = $("modalSenha2").value;
                if (o.validar) {
                    $("modalOk").disabled = true;
                    var msg = null;
                    try { msg = await o.validar(v1, v2); } catch (e) { msg = String(e && e.message || e); }
                    $("modalOk").disabled = false;
                    if (msg) { $("modalErro").textContent = msg; if (o.senha) $("modalSenha").select(); return; }
                }
                terminar(o.senha ? v1 : true);
            };
            $("modalOk").onclick = confirmar;
            $("modalCancelar").onclick = function () { terminar(null); };
            perguntar.tecla = function (e) {
                if (e.key === "Enter") { e.preventDefault(); confirmar(); }
                else if (e.key === "Escape" && o.cancelar !== false) { e.preventDefault(); terminar(null); }
            };
        });
    }

    async function pedirSaida() {
        if (estado.modal || estado.pedindoSaida) return;
        estado.pedindoSaida = true;
        try { await atualizarAdmin(); } finally { estado.pedindoSaida = false; }
        if (estado.modal) return;
        var a = estado.admin || {};
        var precisa = !!(a.temSenha && !a.desbloqueado);
        await perguntar({
            titulo: "Sair do aplicativo",
            texto: precisa ? "Digite a senha do administrador para fechar o Consulta Estoque." : "Fechar o Consulta Estoque?",
            senha: precisa, ok: "Sair",
            validar: async function (senha) { var r = await api.sair(senha); return r && r.ok ? null : ((r && r.mensagem) || "Senha incorreta."); }
        });
    }

    async function criarSenhaInicial() {
        var criada = await perguntar({
            titulo: "Crie a senha do administrador",
            texto: "Primeira vez neste computador. A senha protege as configurações, a saída do aplicativo e a exportação (a consulta de preço continua livre para todos). Mínimo de 4 caracteres.",
            senha: true, repetir: true, ok: "Criar senha", cancelar: false,
            validar: async function (v1, v2) {
                if (String(v1).length < 4) return "A senha precisa ter pelo menos 4 caracteres.";
                if (v1 !== v2) return "As duas senhas não são iguais.";
                var r = await api.definirSenha({ nova: v1 });
                if (!r || !r.ok) return (r && r.mensagem) || "Não foi possível criar a senha.";
                return null;
            }
        });
        if (criada != null) {
            try { estado.admin = await api.bloquear(); } catch (_) {}
            toast("Senha do administrador criada.");
        }
    }

    // ── Inatividade: limpa a busca e o cartão N segundos após a última ação ─
    function reiniciarInatividade() {
        clearTimeout(estado.timerInatividade);
        var s = estado.cfg ? Number(estado.cfg.limparAposSeg) : 60;
        if (!(s > 0)) return;
        estado.timerInatividade = setTimeout(function () {
            if (estado.painel || estado.modal) { reiniciarInatividade(); return; }
            if (!q.value && $("cartao").hidden) return;
            q.value = "";
            $("bLimpar").hidden = true;
            fecharCartao(false);
            buscar(1);
            focarBusca(false);
        }, s * 1000);
    }
    function atividade() {
        reiniciarInatividade();
        if (estado.cfg && estado.cfg.ocultarCursor) {
            document.body.classList.remove("sem-cursor");
            clearTimeout(estado.timerCursor);
            estado.timerCursor = setTimeout(function () { document.body.classList.add("sem-cursor"); }, 4000);
        }
    }
    ["keydown", "keyup", "input", "mousedown", "wheel", "touchstart"].forEach(function (ev) { document.addEventListener(ev, atividade, true); });
    document.addEventListener("mousemove", function () { if (estado.cfg && estado.cfg.ocultarCursor) atividade(); }, true);

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
    $("bConfig").addEventListener("click", function () { abrirPainel(); });
    $("estado").addEventListener("click", function () { abrirPainel("banco"); });
    $("bVazioProcurar").addEventListener("click", function () { abrirPainel("banco"); });
    $("bVazioTentar").addEventListener("click", function () { api.atualizar(); });
    $("bVazioConfig").addEventListener("click", function () { abrirPainel("banco"); });

    $("abas").addEventListener("click", function (e) { var b = e.target.closest("button[data-aba]"); if (b) trocarAba(b.getAttribute("data-aba")); });
    $("fundo").addEventListener("click", fecharPainel);
    $("bFecharPainel").addEventListener("click", fecharPainel);
    $("bCancelar").addEventListener("click", fecharPainel);
    $("bSalvar").addEventListener("click", function () { salvarConfig(lerFormulario(), true); });
    $("bDesbloquear").addEventListener("click", desbloquear);
    $("travaSenha").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); desbloquear(); } });
    var radios = document.querySelectorAll('input[name="modo"]');
    for (var r = 0; r < radios.length; r++) radios[r].addEventListener("change", marcarModo);
    $("cfgZoom").addEventListener("input", function () { $("oZoom").textContent = Math.round(Number($("cfgZoom").value) * 100) + "%"; });
    $("bVerSenha").addEventListener("click", function () { var p = $("cfgPass"); p.type = p.type === "password" ? "text" : "password"; $("bVerSenha").textContent = p.type === "password" ? "Ver" : "Ocultar"; });
    $("bProcurar").addEventListener("click", async function () {
        $("bProcurar").disabled = true;
        toast("Procurando o banco na rede e nesta máquina...", 5000);
        try {
            var ok = await api.procurarBanco();
            if (ok && ok.precisaSenha) { await atualizarAdmin(); return; }
            estado.cfg = await api.lerConfig();
            preencherFormulario(estado.cfg);
            toast(ok ? "Banco encontrado." : "Banco não encontrado — veja o motivo em Situação.", 5000);
        } finally { $("bProcurar").disabled = false; }
    });
    $("bCancelarCopia").addEventListener("click", function () { api.cancelarCopia(); toast("Cópia cancelada."); });
    $("bCopiarLog").addEventListener("click", function () {
        try { navigator.clipboard.writeText($("log").textContent).then(function () { toast("Log copiado."); }, function () { toast("Não foi possível copiar."); }); }
        catch (_) { toast("Não foi possível copiar."); }
    });

    // Administrador
    var resultadoAdmin = async function (r, ok) {
        if (r && r.precisaSenha) { await atualizarAdmin(); toast("A sessão do administrador expirou — digite a senha de novo."); return false; }
        if (r && r.ok === false) { toast(r.mensagem || "Não foi possível."); return false; }
        if (ok) toast(ok);
        return true;
    };
    $("bTrocarSenha").addEventListener("click", async function () {
        var n1 = $("admNova").value, n2 = $("admNova2").value;
        if (n1.length < 4) { toast("A senha precisa ter pelo menos 4 caracteres."); return; }
        if (n1 !== n2) { toast("As duas senhas não são iguais."); return; }
        var r = await api.definirSenha({ nova: n1 });
        $("admNova").value = ""; $("admNova2").value = "";
        if (await resultadoAdmin(r, "Senha do administrador trocada.")) { estado.admin = r.estado; desenharInfoAdmin(); desenharTrava(); }
    });
    $("bCsv").addEventListener("click", async function () {
        var r = await api.exportarCsv(parametros(1));
        if (r && r.ok) toast(r.linhas.toLocaleString("pt-BR") + " itens exportados.");
        else if (r && !r.cancelado) await resultadoAdmin(r);
    });
    $("bPasta").addEventListener("click", async function () { await resultadoAdmin(await api.abrirPastaDados()); });
    $("bManutencao").addEventListener("click", async function () {
        var r = await api.manutencao(!(estado.admin && estado.admin.manutencao));
        if (!r || r.ok === false) { await resultadoAdmin(r); return; }
        estado.admin = r;
        desenharInfoAdmin();
        toast(r.manutencao ? "Modo manutenção: a tela cheia foi suspensa até você voltar ou reiniciar." : "Tela cheia de volta.");
    });
    $("bReiniciarApp").addEventListener("click", async function () { await resultadoAdmin(await api.reiniciar()); });
    $("bSairApp").addEventListener("click", function () { pedirSaida(); });
    $("bBloquear").addEventListener("click", async function () { estado.admin = await api.bloquear(); trocarAba(estado.aba); });

    // Teclado: atalhos e o leitor de código de barras.
    document.addEventListener("keydown", function (e) {
        if (estado.modal) { if (perguntar.tecla) perguntar.tecla(e); return; }
        var k = e.key;
        if (k === "Escape") {
            if (estado.painel) { fecharPainel(); e.preventDefault(); return; }
            if (!$("cartao").hidden) { fecharCartao(false); focarBusca(true); e.preventDefault(); return; }
            if (document.activeElement === q && q.value) { q.value = ""; $("bLimpar").hidden = true; buscar(1); e.preventDefault(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "q" || k === "Q")) { e.preventDefault(); pedirSaida(); return; }
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
        api.aoPedirSaida(function () { pedirSaida(); });
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
        await atualizarAdmin();
        if (estado.admin && !estado.admin.temSenha) await criarSenhaInicial();
    }
    iniciar();
})();
