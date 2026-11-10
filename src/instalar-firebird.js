"use strict";
/**
 * instalar-firebird.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Instala o Firebird NESTE computador, quando ele não tem (pedido do
 *              administrador, com a senha). Usado pela cópia gbak e para abrir um
 *              SMALL.FDB deste computador. Nunca mexe no Firebird do servidor nem
 *              no banco do Small Commerce.
 *
 * Passos: baixa o instalador oficial (Firebird 3.0.13, GitHub do projeto
 * Firebird), confere o tamanho e o SHA-256 fixados aqui (arquivo trocado ou
 * corrompido é recusado), roda em modo silencioso com a permissão do Windows
 * (UAC: o Windows pergunta "Deseja permitir...") e confere que o serviço ficou
 * de pé na porta 3050. Cada etapa tem prazo; nada trava a janela.
 *
 * Firebird 3.0: o gbak 3 copia de servidores Firebird 2.5, 3, 4 e 5 e roda no
 * Windows 7 a 11, de 32 e 64 bits. Instalado como serviço (SuperServer), com o
 * usuário SYSDBA/masterkey e a autenticação antiga liberada (programas antigos).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { execFile } = require("child_process");

const VERSAO = "1.0.0";

const BASE = "https://github.com/FirebirdSQL/firebird/releases/download/v3.0.13/";
const PACOTES = {
    x64: { arquivo: "Firebird-3.0.13.33818-0-x64.exe", tamanho: 10895486, sha256: "6e53bb7642a390027118f576669f7913ea7a652eca7d2dc41c86e2be94d3fb06" },
    ia32: { arquivo: "Firebird-3.0.13.33818-0-Win32.exe", tamanho: 7899092, sha256: "6c5aa56ea24ab31a9ecc30958b1c899377701fd27fa163a4cdc4be5fff1170ce" }
};

// Instalação silenciosa (Inno Setup do Firebird 3).
const ARGS_INSTALADOR = [
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/NOICONS",
    "/COMPONENTS=ServerComponent,ClientComponent",
    "/TASKS=UseSuperServerTask,UseServiceTask,AutoStartTask,CopyFbClientToSysTask,EnableLegacyClientAuth",
    "/SYSDBAPASSWORD=masterkey"
];

/** Puro: pacote certo para a arquitetura do Windows (64 bits também quando o app é 32 bits num Windows 64). */
function pacotePara(arch, env) {
    const e = env || {};
    const windows64 = arch === "x64" || arch === "arm64" || /64/.test(String(e.PROCESSOR_ARCHITEW6432 || "")) || /64/.test(String(e.PROCESSOR_ARCHITECTURE || ""));
    return windows64 ? PACOTES.x64 : PACOTES.ia32;
}

/**
 * Baixa `url` para `destino` seguindo redirecionamentos (GitHub → servidor de
 * arquivos), com prazo sem dados e prazo total. `progresso(baixados, total)`.
 */
function baixar(url, destino, opcoes) {
    const o = opcoes || {};
    const prazoTotal = Date.now() + (o.prazoMs || 10 * 60000);
    const semDados = o.semDadosMs || 30000;
    const get = o.get || https.get;
    return new Promise((resolve, reject) => {
        let terminou = false;
        const falhar = e => { if (!terminou) { terminou = true; try { fs.unlinkSync(destino); } catch (_) {} reject(e); } };
        const pedir = (u, saltos) => {
            if (saltos > 6) { falhar(new Error("redirecionamentos demais")); return; }
            let req;
            try {
                req = get(u, { headers: { "User-Agent": "ConsultaEstoque" } }, res => {
                    const st = res.statusCode || 0;
                    if (st >= 300 && st < 400 && res.headers && res.headers.location) {
                        res.resume();
                        pedir(new URL(res.headers.location, u).toString(), saltos + 1);
                        return;
                    }
                    if (st !== 200) { res.resume(); falhar(new Error("o servidor de download respondeu " + st)); return; }
                    const total = Number(res.headers && res.headers["content-length"]) || 0;
                    let baixados = 0;
                    const arq = fs.createWriteStream(destino);
                    let parado = setTimeout(() => res.destroy(new Error("download parado (sem dados por " + Math.round(semDados / 1000) + " s)")), semDados);
                    res.on("data", c => {
                        baixados += c.length;
                        clearTimeout(parado);
                        if (Date.now() > prazoTotal) { res.destroy(new Error("download demorou demais")); return; }
                        parado = setTimeout(() => res.destroy(new Error("download parado (sem dados por " + Math.round(semDados / 1000) + " s)")), semDados);
                        if (typeof o.progresso === "function") { try { o.progresso(baixados, total); } catch (_) {} }
                    });
                    res.on("error", e => { clearTimeout(parado); arq.destroy(); falhar(e); });
                    res.on("aborted", () => { clearTimeout(parado); arq.destroy(); falhar(new Error("download interrompido")); });
                    arq.on("error", e => { clearTimeout(parado); res.destroy(); falhar(e); });
                    arq.on("finish", () => { clearTimeout(parado); if (!terminou) { terminou = true; resolve(baixados); } });
                    res.pipe(arq);
                });
            } catch (e) { falhar(e); return; }
            req.on("error", falhar);
            req.setTimeout(semDados, () => req.destroy(new Error("sem resposta do servidor de download")));
        };
        pedir(url, 0);
    });
}

/** SHA-256 de um arquivo (em partes, sem carregar tudo na memória). */
function sha256Arquivo(arq) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const s = fs.createReadStream(arq);
        s.on("error", reject);
        s.on("data", c => h.update(c));
        s.on("end", () => resolve(h.digest("hex")));
    });
}

/** Roda o instalador pedindo a permissão do Windows (UAC). Resolve o código de saída. */
function executarComPermissao(exe, args, prazoMs) {
    return new Promise(resolve => {
        // Argumentos entre aspas simples do PowerShell (aspas simples duplicadas).
        const q = s => "'" + String(s).replace(/'/g, "''") + "'";
        const ps = "$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath " + q(exe) +
            " -ArgumentList @(" + args.map(q).join(",") + ") -Verb RunAs -Wait -PassThru; exit $p.ExitCode } " +
            // Recusa no UAC: "A operação foi cancelada pelo usuário" / "canceled by the user".
            "catch { if ([string]$_.Exception.Message -match 'cancel') { exit 1223 } else { exit 1 } }";
        const cod = Buffer.from(ps, "utf16le").toString("base64");
        try {
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", cod],
                { windowsHide: true, timeout: prazoMs || 15 * 60000 }, err => {
                    if (!err) { resolve(0); return; }
                    resolve(typeof err.code === "number" ? err.code : (err.killed ? -2 : -1));
                });
        } catch (_) { resolve(-1); }
    });
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

/**
 * Instala o Firebird. dep:
 *   portaAberta(h, porta, ms)  (obrigatório)
 *   etapa(texto)               avisos para a tela e o log
 *   pasta                      pasta temporária (padrão: %TEMP%\ConsultaEstoque-firebird)
 *   baixar, executar, sha256   (testes)
 *   plataforma, arch, env      (testes)
 * Resolve { ok, mensagem, codigo? }. Nunca lança erro.
 */
async function instalar(dep) {
    const d = dep || {};
    const etapa = typeof d.etapa === "function" ? d.etapa : () => {};
    const plataforma = d.plataforma || process.platform;
    if (plataforma !== "win32") return { ok: false, mensagem: "A instalação automática do Firebird só funciona no Windows." };
    const pac = pacotePara(d.arch || process.arch, d.env || process.env);
    const pasta = d.pasta || path.join(os.tmpdir(), "ConsultaEstoque-firebird");
    const arq = path.join(pasta, pac.arquivo);
    try {
        try {
            if (await d.portaAberta("127.0.0.1", 3050, 1500)) return { ok: true, mensagem: "Este computador já tem um Firebird ligado (porta 3050)." };
        } catch (_) {}
        fs.mkdirSync(pasta, { recursive: true });
        // Instalador já baixado e íntegro (tentativa anterior): não baixa de novo.
        let integro = false;
        try { integro = fs.statSync(arq).size === pac.tamanho && await (d.sha256 || sha256Arquivo)(arq) === pac.sha256; } catch (_) {}
        if (!integro) {
            etapa("Baixando o Firebird 3.0 (" + Math.round(pac.tamanho / 1048576) + " MB)...");
            let ultimo = 0;
            await (d.baixar || baixar)(BASE + pac.arquivo, arq, {
                progresso: (b, t) => {
                    const pct = Math.floor(100 * b / (t || pac.tamanho));
                    if (pct >= ultimo + 10) { ultimo = pct - (pct % 10); etapa("Baixando o Firebird 3.0... " + Math.min(100, pct) + "%"); }
                }
            });
            etapa("Conferindo o arquivo baixado...");
            const tam = fs.statSync(arq).size;
            const hash = await (d.sha256 || sha256Arquivo)(arq);
            if (tam !== pac.tamanho || hash !== pac.sha256) {
                try { fs.unlinkSync(arq); } catch (_) {}
                return { ok: false, mensagem: "O arquivo baixado não confere com o instalador oficial do Firebird (download corrompido ou trocado) — nada foi instalado." };
            }
        }
        etapa("Instalando o Firebird... confirme a pergunta do Windows (\"Deseja permitir que este aplicativo faça alterações?\").");
        const codigo = await (d.executar || executarComPermissao)(arq, ARGS_INSTALADOR, 15 * 60000);
        if (codigo === 1223) return { ok: false, codigo, mensagem: "Instalação cancelada: a permissão do Windows não foi dada." };
        if (codigo !== 0) return { ok: false, codigo, mensagem: "O instalador do Firebird terminou com o código " + codigo + ". Veja o log ou instale o Firebird 3.0 à mão (firebirdsql.org)." };
        etapa("Ligando o serviço do Firebird...");
        for (let i = 0; i < 30; i++) {
            let ok = false;
            try { ok = await d.portaAberta("127.0.0.1", 3050, 1000); } catch (_) {}
            if (ok) {
                try { fs.unlinkSync(arq); } catch (_) {}
                return { ok: true, mensagem: "Firebird 3.0 instalado e ligado neste computador." };
            }
            await esperar(d.esperaMs != null ? d.esperaMs : 1000);
        }
        return { ok: false, mensagem: "O Firebird foi instalado, mas o serviço não respondeu na porta 3050. Reinicie o computador e confira o serviço \"Firebird Server\"." };
    } catch (e) {
        return { ok: false, mensagem: "Não foi possível instalar o Firebird: " + String(e && e.message || e) };
    }
}

module.exports = { VERSAO, PACOTES, ARGS_INSTALADOR, pacotePara, baixar, sha256Arquivo, instalar };
