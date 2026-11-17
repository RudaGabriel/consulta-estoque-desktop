"use strict";
/**
 * atualizacoes.js
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Verificação e download de versões novas do aplicativo.
 *
 * A última versão é descoberta pelo arquivo SHA256SUMS.txt da página de versões
 * (".../releases/latest/download/SHA256SUMS.txt"): o nome de cada arquivo traz a
 * versão e cada linha traz a impressão digital SHA-256. Não usa a API do GitHub
 * (limite de consultas por hora, compartilhado por todos os computadores da loja).
 * O SHA-256 prova que o download chegou inteiro e é o arquivo publicado com a
 * versão; não é uma assinatura digital.
 *
 * Regras: só atualiza para versão MAIOR, da mesma variante (moderna/legado), da mesma
 * arquitetura (x64/ia32) e do mesmo tipo (instalador/portátil). Resposta 403/429 do
 * servidor = "tentar mais tarde" (nunca erro na tela). Toda leitura de rede tem prazo.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — comandoAtualizacao: atualização automática, silenciosa (/S --updated
 *           --force-run, sem janelas, reabre o aplicativo) ou com todos os detalhes (o
 *           instalador com as etapas); depois do instalador, o aplicativo é aberto
 *           novamente (se a instalação falhar ou for cancelada, a versão atual volta a abrir).
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const Instalar = require("./instalar-firebird.js");

const VERSAO = "1.1.0";
// Endereço interno da página de versões (nunca exibido na tela).
const REPOSITORIO = "RudaGabriel/consulta-estoque-desktop";
const URL_SOMAS = "https://github.com/" + REPOSITORIO + "/releases/latest/download/SHA256SUMS.txt";
const urlArquivo = (versao, nome) => "https://github.com/" + REPOSITORIO + "/releases/download/v" + versao + "/" + encodeURIComponent(nome);

const DIA = 24 * 3600000;
const FREQUENCIAS = { diaria: DIA, semanal: 7 * DIA, mensal: 30 * DIA };

/** Puro: compara versões "1.10.2" × "1.9.0" (−1, 0, 1). Versão inválida vale 0.0.0. */
function compararVersoes(a, b) {
    const p = v => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]; };
    const x = p(a), y = p(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

/** Puro: linhas "hash  nome" do SHA256SUMS.txt (só as válidas). */
function lerSomas(texto) {
    const out = [];
    String(texto || "").split(/\r?\n/).forEach(l => {
        const m = /^([0-9a-f]{64})\s+\*?(ConsultaEstoque-(\d+\.\d+\.\d+)-[A-Za-z0-9.\-]+\.exe)\s*$/.exec(l.trim());
        if (m) out.push({ hash: m[1], nome: m[2], versao: m[3] });
    });
    return out;
}

/**
 * Puro: o arquivo certo para este computador. alvo: { legado, arch ("x64"|"ia32"),
 * portatil }. A versão moderna só existe em x64. Sem arquivo compatível → null.
 */
function escolherArquivo(somas, alvo) {
    const a = alvo || {};
    const arch = a.arch === "ia32" ? "ia32" : "x64";
    if (!a.legado && arch !== "x64") return null;
    const tipo = a.portatil ? "portatil" : "instalador";
    const sufixo = a.legado ? "-legado-win7-a-11-" + arch + "-" + tipo + ".exe" : "-win10-11-x64-" + tipo + ".exe";
    const achados = (somas || []).filter(s => s.nome === "ConsultaEstoque-" + s.versao + sufixo);
    achados.sort((x, y) => compararVersoes(y.versao, x.versao));
    return achados[0] || null;
}

/** Puro: a verificação automática está devida? ("nunca" → nunca; sem verificação anterior → sim.) */
function verificacaoDevida(frequencia, ultimaEm, agora) {
    const periodo = FREQUENCIAS[frequencia];
    if (!periodo) return false;
    const t = agora == null ? Date.now() : agora;
    const u = Number(ultimaEm) || 0;
    return u <= 0 || u > t || t - u >= periodo;
}

/** GET de um texto pequeno (até 64 KB), seguindo redirecionamentos, com prazo. Resolve { status, texto }. */
function baixarTexto(url, opcoes) {
    const o = opcoes || {};
    const get = o.get || https.get;
    const prazo = o.prazoMs || 15000;
    return new Promise(resolve => {
        let fim = false;
        const terminar = r => { if (!fim) { fim = true; clearTimeout(t); resolve(r); } };
        const t = setTimeout(() => terminar({ status: 0, erro: "sem resposta (tempo esgotado)" }), prazo);
        const pedir = (u, saltos) => {
            if (saltos > 6) { terminar({ status: 0, erro: "redirecionamentos demais" }); return; }
            if (!/^https:\/\//i.test(u)) { terminar({ status: 0, erro: "endereço sem HTTPS recusado" }); return; }
            let req;
            try {
                req = get(u, { headers: { "User-Agent": "ConsultaEstoque" } }, res => {
                    const st = res.statusCode || 0;
                    if (st >= 300 && st < 400 && res.headers && res.headers.location) { res.resume(); pedir(new URL(res.headers.location, u).toString(), saltos + 1); return; }
                    if (st !== 200) { res.resume(); terminar({ status: st }); return; }
                    let txt = "";
                    res.setEncoding("utf8");
                    res.on("data", c => { txt += c; if (txt.length > 64 * 1024) { res.destroy(); terminar({ status: 0, erro: "resposta grande demais" }); } });
                    res.on("end", () => terminar({ status: 200, texto: txt }));
                    res.on("error", e => terminar({ status: 0, erro: e.message }));
                });
            } catch (e) { terminar({ status: 0, erro: e.message }); return; }
            req.on("error", e => terminar({ status: 0, erro: e.message }));
            req.setTimeout(prazo, () => req.destroy(new Error("sem resposta (tempo esgotado)")));
        };
        pedir(url, 0);
    });
}

/**
 * Verifica se há versão nova. dep: { versaoAtual, alvo, get, prazoMs }.
 * Resolve { ok, adiar, erro, versaoNova, arquivo } — adiar = servidor pediu para
 * tentar mais tarde (403/429) ou sem conexão: nada a mostrar como erro.
 */
async function verificar(dep) {
    const d = dep || {};
    const r = await baixarTexto(URL_SOMAS, { get: d.get, prazoMs: d.prazoMs });
    if (r.status === 403 || r.status === 429) return { ok: false, adiar: true, erro: "O servidor de versões pediu para tentar mais tarde." };
    if (r.status !== 200) return { ok: false, adiar: true, erro: r.status ? "O servidor de versões respondeu " + r.status + "." : "Sem conexão com a internet (" + (r.erro || "sem resposta") + ")." };
    const arquivo = escolherArquivo(lerSomas(r.texto), d.alvo);
    if (!arquivo) return { ok: true, versaoNova: null, arquivo: null };
    if (compararVersoes(arquivo.versao, d.versaoAtual) <= 0) return { ok: true, versaoNova: null, arquivo: null };
    return { ok: true, versaoNova: arquivo.versao, arquivo };
}

/**
 * Baixa o arquivo para `pasta` e confere o SHA-256. Arquivo que não confere é apagado.
 * dep: { arquivo: { nome, hash, versao }, pasta, get, progresso(baixados, total) }. Resolve o caminho.
 */
async function baixarAtualizacao(dep) {
    const d = dep || {};
    const a = d.arquivo || {};
    if (!/^[0-9a-f]{64}$/.test(String(a.hash || "")) || !/^ConsultaEstoque-[A-Za-z0-9.\-]+\.exe$/.test(String(a.nome || ""))) throw new Error("Arquivo da atualização inválido.");
    fs.mkdirSync(d.pasta, { recursive: true });
    const destino = path.join(d.pasta, a.nome);
    const temp = destino + ".baixando";
    try { fs.unlinkSync(temp); } catch (_) {}
    await Instalar.baixar(urlArquivo(a.versao, a.nome), temp, { get: d.get, progresso: d.progresso, prazoMs: 30 * 60000 });
    const hash = await Instalar.sha256Arquivo(temp);
    if (hash !== a.hash) {
        try { fs.unlinkSync(temp); } catch (_) {}
        throw new Error("O arquivo baixado não confere com a impressão digital SHA-256 publicada (download danificado). Tente novamente.");
    }
    try { fs.unlinkSync(destino); } catch (_) {}
    fs.renameSync(temp, destino);
    return destino;
}

/**
 * Puro: linha de comando (cmd /s /c "...") que, uns segundos depois de este aplicativo
 * fechar (instância única), aplica a atualização e garante que o aplicativo volte a abrir.
 *   Instalador silencioso: /S --updated --force-run (sem janelas; mantém o modo da instalação
 *   anterior; o desinstalador antigo recebe --updated e não apaga os dados).
 *   Instalador com todos os detalhes: --updated (as etapas do instalador aparecem).
 *   Depois do instalador, abre o aplicativo: se ele já abriu, a segunda instância sai na hora;
 *   se a instalação falhou ou foi cancelada, a versão atual volta a abrir (o quiosque não
 *   fica fechado).
 *   Portátil: abre a versão nova (baixada na mesma pasta).
 * Caminhos com aspas ou % são recusados (não podem ir para a linha do cmd).
 */
function comandoAtualizacao(o) {
    const d = o || {};
    const arquivo = String(d.arquivo || ""), exeApp = String(d.exeApp || "");
    const invalido = c => !c || /["%\r\n]/.test(c);
    if (invalido(arquivo) || (!d.portatil && invalido(exeApp))) throw new Error("Caminho com caracteres não suportados (aspas ou %).");
    const espera = "ping -n 4 127.0.0.1 >nul";
    if (d.portatil) return "\"" + espera + " & start \"\" \"" + arquivo + "\"\"";
    const args = d.modo === "detalhado" ? "--updated" : "/S --updated --force-run";
    return "\"" + espera + " & start \"\" /wait \"" + arquivo + "\" " + args + " & ping -n 6 127.0.0.1 >nul & start \"\" \"" + exeApp + "\"\"";
}

module.exports = {
    comandoAtualizacao,
    VERSAO, URL_SOMAS, FREQUENCIAS, urlArquivo, compararVersoes, lerSomas, escolherArquivo, verificacaoDevida,
    baixarTexto, verificar, baixarAtualizacao
};
