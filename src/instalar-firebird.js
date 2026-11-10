"use strict";
/**
 * instalar-firebird.js
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Instala (ou troca) o Firebird NESTE computador, na MESMA versão do
 *              servidor do Small Commerce (pedido do administrador, com a senha e
 *              sempre com confirmação). Usado pela cópia gbak e para abrir um
 *              SMALL.FDB deste computador. Nunca mexe no Firebird do servidor nem
 *              no banco do Small Commerce.
 *
 * Passos: escolhe o pacote da versão do servidor (2.5, 3.0, 4.0 ou 5.0; sem a
 * versão conhecida, 3.0), baixa o instalador oficial (GitHub do projeto
 * Firebird), confere o tamanho e o SHA-256 fixados aqui (arquivo trocado ou
 * corrompido é recusado), roda em modo silencioso com a permissão do Windows
 * (UAC: o Windows pergunta "Deseja permitir...") e confere que o serviço ficou
 * de pé na porta 3050. Na TROCA, o desinstalador do Firebird antigo roda antes,
 * na mesma permissão. Cada etapa tem prazo; nada trava a janela.
 *
 * Instalado como serviço (SuperServer), com servidor, cliente e as ferramentas
 * de administração (gbak), usuário SYSDBA/masterkey e, do 3.0 em diante, a
 * autenticação antiga liberada (programas antigos).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — Versão do servidor: pacotes 2.5.9, 3.0.13, 4.0.6 e 5.0.3 (escolha pela
 *           versão do servidor), troca do Firebird local (desinstala o antigo e
 *           instala o novo numa só permissão do Windows), versão do gbak local
 *           (versaoDoGbak) e as ferramentas de administração no pacote (o gbak
 *           faltava na instalação da 1.0.0).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { execFile } = require("child_process");

const VERSAO = "1.1.0";

const BASE = "https://github.com/FirebirdSQL/firebird/releases/download/";
// Instaladores oficiais (tamanho e SHA-256 conferidos no download).
const VERSOES = {
    "2.5": {
        nome: "2.5.9", tag: "R2_5_9",
        x64: { arquivo: "Firebird-2.5.9.27139_0_x64.exe", tamanho: 10014146, sha256: "619715d4e2683504647f778f58669c9f52627921a532da716b8aebf9ede80966" },
        ia32: { arquivo: "Firebird-2.5.9.27139_0_Win32.exe", tamanho: 6563348, sha256: "cbecbd98317940d6e96c88086116ee28af92f776a9911fd1457e6f8e99101424" }
    },
    "3.0": {
        nome: "3.0.13", tag: "v3.0.13",
        x64: { arquivo: "Firebird-3.0.13.33818-0-x64.exe", tamanho: 10895486, sha256: "6e53bb7642a390027118f576669f7913ea7a652eca7d2dc41c86e2be94d3fb06" },
        ia32: { arquivo: "Firebird-3.0.13.33818-0-Win32.exe", tamanho: 7899092, sha256: "6c5aa56ea24ab31a9ecc30958b1c899377701fd27fa163a4cdc4be5fff1170ce" }
    },
    "4.0": {
        nome: "4.0.6", tag: "v4.0.6",
        x64: { arquivo: "Firebird-4.0.6.3221-0-x64.exe", tamanho: 26296445, sha256: "a5fbda77a51f55b85bce9289e275c603ed9018eb078caf6cf614571521fb8889" },
        ia32: { arquivo: "Firebird-4.0.6.3221-0-Win32.exe", tamanho: 16140796, sha256: "4d754c188417600f282a1ce8e5df3859aa21ed030f9d5fc7f1b7331da4be496a" }
    },
    "5.0": {
        nome: "5.0.3", tag: "v5.0.3",
        x64: { arquivo: "Firebird-5.0.3.1683-0-windows-x64.exe", tamanho: 26220110, sha256: "2affb4b29a01fc35f1747684cba6263cb30a519f3f5343a105a14472c757cb53" },
        ia32: { arquivo: "Firebird-5.0.3.1683-0-windows-x86.exe", tamanho: 15281547, sha256: "9bffda77806fd238febd04a0938e3e374b6f24efa3d78d53e06a171724605163" }
    }
};
const PADRAO = "3.0";
const PACOTES = VERSOES[PADRAO]; // compatibilidade (1.0.0)

/** Puro: argumentos da instalação silenciosa (Inno Setup) de cada versão. */
function argumentosInstalador(chave) {
    const base = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/NOICONS",
        "/COMPONENTS=ServerComponent,DevAdminComponent,ClientComponent"];
    if (chave === "2.5") return base.concat(["/TASKS=UseSuperServerTask,UseServiceTask,AutoStartTask,CopyFbClientToSysTask"]);
    return base.concat(["/TASKS=UseSuperServerTask,UseServiceTask,AutoStartTask,CopyFbClientToSysTask,EnableLegacyClientAuth", "/SYSDBAPASSWORD=masterkey"]);
}
const ARGS_INSTALADOR = argumentosInstalador(PADRAO);

/** Puro: "4.0.6.3221", "WI-V3.0.13.33818", "2.5.9" → { maior, menor, texto } ou null. */
function lerVersao(txt) {
    const m = /(?:^|[^\d])(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?/.exec(String(txt == null ? "" : txt));
    if (!m) return null;
    const maior = Number(m[1]), menor = Number(m[2]);
    if (!(maior >= 1 && maior <= 20)) return null;
    return { maior, menor, texto: maior + "." + menor + (m[3] != null ? "." + m[3] : "") };
}

/** Puro: chave do pacote para a versão do servidor ("2.1" → "2.5", "3.0.10" → "3.0"...). null = sem pacote (versão nova demais). */
function chaveParaVersao(versao) {
    const v = typeof versao === "object" && versao ? versao : lerVersao(versao);
    if (!v) return null;
    if (v.maior <= 2) return "2.5";
    const k = v.maior + ".0";
    return VERSOES[k] ? k : null;
}

/** Puro: a versão local é mais antiga que a do servidor (gbak local não serve)? */
function localMaisAntiga(local, servidor) {
    const l = typeof local === "object" && local ? local : lerVersao(local);
    const s = typeof servidor === "object" && servidor ? servidor : lerVersao(servidor);
    if (!l || !s) return false;
    return l.maior < s.maior || (l.maior === s.maior && l.menor < s.menor);
}

const _execTexto = (exe, args, ms) => new Promise(resolve => {
    try {
        execFile(exe, args, { timeout: ms, windowsHide: true, encoding: "latin1" }, (err, out, errOut) => resolve(String(out || "") + "\n" + String(errOut || "")));
    } catch (_) { resolve(""); }
});

/** Versão do gbak (= do Firebird) deste computador: "gbak -z" mostra "WI-V3.0.13.33818". null se não der. */
async function versaoDoGbak(gbak, executar) {
    if (!gbak) return null;
    const txt = await (executar || _execTexto)(gbak, ["-z"], 8000);
    const m = /[A-Z]{2}-[VTBX](\d+\.\d+(?:\.\d+)?)/.exec(String(txt || ""));
    return m ? lerVersao(m[1]) : null;
}

/** Desinstalador do Firebird instalado (unins000.exe na pasta do gbak ou acima dela). */
function acharDesinstalador(gbak) {
    if (!gbak) return null;
    const dir = path.dirname(gbak);
    for (const d of [dir, path.dirname(dir)]) {
        try {
            const n = fs.readdirSync(d).find(x => /^unins\d{3}\.exe$/i.test(x));
            if (n) return path.join(d, n);
        } catch (_) {}
    }
    return null;
}

/** Puro: pacote certo para a arquitetura do Windows (64 bits também quando o app é 32 bits num Windows 64). */
function pacotePara(arch, env, chave) {
    const e = env || {};
    const windows64 = arch === "x64" || arch === "arm64" || /64/.test(String(e.PROCESSOR_ARCHITEW6432 || "")) || /64/.test(String(e.PROCESSOR_ARCHITECTURE || ""));
    const v = VERSOES[chave] || VERSOES[PADRAO];
    return windows64 ? v.x64 : v.ia32;
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

// Argumentos entre aspas simples do PowerShell (aspas simples duplicadas).
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const codificar = ps => Buffer.from(ps, "utf16le").toString("base64");

/**
 * Puro: script (rodado JÁ com a permissão do Windows) que desinstala o Firebird
 * antigo, espera o desinstalador terminar de verdade (ele se copia para a pasta
 * temporária e sai na hora: o fim é quando ele apaga a si mesmo) e instala o novo.
 * Código 90 = o antigo não saiu em 3 minutos.
 */
function scriptTroca(desinstalador, exe, args) {
    return "$ErrorActionPreference='Stop'; " +
        "Start-Process -FilePath " + q(desinstalador) + " -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait; " +
        "$i = 0; while ((Test-Path -LiteralPath " + q(desinstalador) + ") -and $i -lt 180) { Start-Sleep -Seconds 1; $i++ }; " +
        "if (Test-Path -LiteralPath " + q(desinstalador) + ") { exit 90 }; Start-Sleep -Seconds 3; " +
        "$p = Start-Process -FilePath " + q(exe) + " -ArgumentList @(" + args.map(q).join(",") + ") -Wait -PassThru; exit $p.ExitCode";
}

/**
 * Roda o instalador pedindo a permissão do Windows (UAC). Com `desinstalador`,
 * desinstala o Firebird antigo antes, na mesma permissão. Resolve o código de saída.
 */
function executarComPermissao(exe, args, prazoMs, desinstalador) {
    return new Promise(resolve => {
        const alvo = desinstalador
            ? "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand'," + q(codificar(scriptTroca(desinstalador, exe, args))) + ") -WindowStyle Hidden"
            : "Start-Process -FilePath " + q(exe) + " -ArgumentList @(" + args.map(q).join(",") + ")";
        const ps = "$ErrorActionPreference='Stop'; try { $p = " + alvo + " -Verb RunAs -Wait -PassThru; exit $p.ExitCode } " +
            // Recusa no UAC: "A operação foi cancelada pelo usuário" / "canceled by the user".
            "catch { if ([string]$_.Exception.Message -match 'cancel') { exit 1223 } else { exit 1 } }";
        const cod = codificar(ps);
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
 * Instala (ou troca) o Firebird. dep:
 *   portaAberta(h, porta, ms)  (obrigatório)
 *   versao                     versão do servidor ("4.0.6"); sem ela, 3.0
 *   desinstalador              unins000.exe do Firebird antigo → TROCA (desinstala antes)
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
    const chave = d.versao ? chaveParaVersao(d.versao) : PADRAO;
    if (!chave) return { ok: false, mensagem: "O servidor usa o Firebird " + d.versao + ", mais novo que os instaladores que este aplicativo conhece — instale essa versão à mão (firebirdsql.org)." };
    const nomeVersao = VERSOES[chave].nome;
    const troca = !!d.desinstalador;
    const pac = pacotePara(d.arch || process.arch, d.env || process.env, chave);
    const pasta = d.pasta || path.join(os.tmpdir(), "ConsultaEstoque-firebird");
    const arq = path.join(pasta, pac.arquivo);
    try {
        if (!troca) {
            try {
                if (await d.portaAberta("127.0.0.1", 3050, 1500)) return { ok: true, mensagem: "Este computador já tem um Firebird ligado (porta 3050)." };
            } catch (_) {}
        } else if (!fs.existsSync(d.desinstalador)) {
            return { ok: false, mensagem: "O desinstalador do Firebird antigo não foi encontrado — desinstale-o pelo Painel de Controle e use \"Instalar o Firebird\"." };
        }
        fs.mkdirSync(pasta, { recursive: true });
        // Instalador já baixado e íntegro (tentativa anterior): não baixa de novo.
        let integro = false;
        try { integro = fs.statSync(arq).size === pac.tamanho && await (d.sha256 || sha256Arquivo)(arq) === pac.sha256; } catch (_) {}
        if (!integro) {
            etapa("Baixando o Firebird " + nomeVersao + " (" + Math.round(pac.tamanho / 1048576) + " MB)...");
            let ultimo = 0;
            await (d.baixar || baixar)(BASE + VERSOES[chave].tag + "/" + pac.arquivo, arq, {
                progresso: (b, t) => {
                    const pct = Math.floor(100 * b / (t || pac.tamanho));
                    if (pct >= ultimo + 10) { ultimo = pct - (pct % 10); etapa("Baixando o Firebird " + nomeVersao + "... " + Math.min(100, pct) + "%"); }
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
        etapa((troca ? "Trocando o Firebird deste computador pelo " : "Instalando o Firebird ") + nomeVersao +
            "... confirme a pergunta do Windows (\"Deseja permitir que este aplicativo faça alterações?\").");
        const codigo = await (d.executar || executarComPermissao)(arq, argumentosInstalador(chave), 15 * 60000, troca ? d.desinstalador : null);
        if (codigo === 1223) return { ok: false, codigo, mensagem: "Instalação cancelada: a permissão do Windows não foi dada." };
        if (codigo === 90) return { ok: false, codigo, mensagem: "O Firebird antigo não terminou de desinstalar em 3 minutos — reinicie o computador e tente de novo." };
        if (codigo !== 0) return { ok: false, codigo, mensagem: "O instalador do Firebird terminou com o código " + codigo + ". Veja o log ou instale o Firebird " + nomeVersao + " à mão (firebirdsql.org)." };
        etapa("Ligando o serviço do Firebird...");
        for (let i = 0; i < 30; i++) {
            let ok = false;
            try { ok = await d.portaAberta("127.0.0.1", 3050, 1000); } catch (_) {}
            if (ok) {
                try { fs.unlinkSync(arq); } catch (_) {}
                return { ok: true, versao: nomeVersao, mensagem: "Firebird " + nomeVersao + (troca ? " instalado no lugar do antigo" : " instalado") + " e ligado neste computador." };
            }
            await esperar(d.esperaMs != null ? d.esperaMs : 1000);
        }
        return { ok: false, mensagem: "O Firebird foi instalado, mas o serviço não respondeu na porta 3050. Reinicie o computador e confira o serviço \"Firebird Server\"." };
    } catch (e) {
        return { ok: false, mensagem: "Não foi possível instalar o Firebird: " + String(e && e.message || e) };
    }
}

module.exports = {
    VERSAO, VERSOES, PACOTES, ARGS_INSTALADOR, argumentosInstalador, pacotePara, lerVersao, chaveParaVersao, localMaisAntiga,
    versaoDoGbak, acharDesinstalador, scriptTroca, baixar, sha256Arquivo, instalar
};
