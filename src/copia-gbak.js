"use strict";
/**
 * copia-gbak.js
 * @version 1.3.0
 * @author Ruda Gabriel
 * @description Cópia do banco pelo gbak: backup
 *              do banco principal SEM coleta de lixo (-g, leitura numa "foto" da
 *              transação) e restauração SOMENTE LEITURA no Firebird desta
 *              máquina. A consulta lê só a cópia — o banco do caixa recebe
 *              apenas o backup, no intervalo configurado.
 *
 * Garantias:
 *   - usuário/senha vão ao gbak por variável de ambiente (ISC_USER/ISC_PASSWORD),
 *     nunca na linha de comando (que aparece na lista de processos);
 *   - gbak com prioridade abaixo do normal (o caixa tem preferência);
 *   - a cópia nova só entra pronta (arquivo temporário → rename → manifesto);
 *   - só apaga arquivos com nome criado por este módulo, dentro da pasta das cópias;
 *   - prazo por etapa; ao estourar ou cancelar, o processo é encerrado.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.3.0 — Sem nenhum nome de pasta de terceiros: o Firebird embutido na pasta de
 *           algum programa é procurado de forma genérica (Program Files\*\Firebird
 *           e Program Files\*\*\Firebird, com limite e prazo).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const { decodificarTexto } = require("./firebird.js");

const VERSAO = "1.3.0";
const RE_COPIA = /^SMALL_OFFLINE_\d{8}_\d{6}(?:_\d+)?\.FDB$/i;
const RE_TEMP = /^SMALL_OFFLINE_\d{8}_\d{6}(?:_\d+)?\.(?:FBK|FDB)\.tmp$/i;
const MANIFESTO = "copia.json";

/** Pasta padrão: disco local (o Firebird não abre banco em pasta de rede). */
function pastaPadrao() {
    const base = process.platform === "win32" ? (process.env.ProgramData || "C:\\ProgramData") : path.join(os.homedir(), ".local", "share");
    return path.join(base, "ConsultaEstoqueDesktop", "copias");
}

/** "host[/porta]:caminho" para o gbak. */
function alvoGbak(host, porta, caminho) {
    return (host || "127.0.0.1") + (porta && Number(porta) !== 3050 ? "/" + porta : "") + ":" + caminho;
}

const _execTexto = (exe, args, ms) => new Promise(resolve => {
    try {
        cp.execFile(exe, args, { timeout: ms, windowsHide: true, encoding: "buffer" }, (err, out) => resolve(err ? "" : decodificarTexto(out || Buffer.alloc(0))));
    } catch (_) { resolve(""); }
});
const _existe = async p => { try { return !!p && (await fs.promises.stat(p)).isFile(); } catch (_) { return false; } };

const _pastas = async (dir, prazo) => {
    if (Date.now() > prazo) return [];
    try { return (await fs.promises.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
    catch (_) { return []; }
};
/** Pastas "Firebird" dentro das pastas de programas (dois níveis, com limite e prazo de 5 s). */
async function _gbakEmbutido(raizes, nome) {
    const prazo = Date.now() + 5000;
    const out = [];
    const vistas = new Set();
    for (const r of raizes) {
        const k = String(r).toLowerCase();
        if (vistas.has(k)) continue;
        vistas.add(k);
        const comFirebird = (dir, subs) => {
            const fb = subs.find(n => /^firebird$/i.test(n));
            if (fb) out.push(path.join(dir, fb, "bin", nome), path.join(dir, fb, nome));
        };
        for (const a of (await _pastas(r, prazo)).slice(0, 300)) {
            if (/^firebird$/i.test(a)) continue; // instalação comum: já procurada
            const pa = path.join(r, a);
            const subs = await _pastas(pa, prazo);
            comFirebird(pa, subs);
            for (const b of subs.slice(0, 40)) {
                if (/^firebird$/i.test(b)) continue;
                comFirebird(path.join(pa, b), await _pastas(path.join(pa, b), prazo));
            }
            if (Date.now() > prazo) break;
        }
    }
    return out;
}

/**
 * Procura o gbak: configurado → pasta dos serviços do Firebird (registro do
 * Windows: mesma versão do servidor local) → pastas conhecidas → PATH. "" se
 * não achar.
 * Assíncrona: nunca congela a janela.
 */
async function localizarGbak(preferido) {
    if (preferido && await _existe(preferido)) return preferido;
    const nome = process.platform === "win32" ? "gbak.exe" : "gbak";
    const cands = [];
    if (process.platform === "win32") {
        // Serviços do Firebird pelo registro: "reg" responde em milissegundos.
        const chaves = await _execTexto("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services", "/k", "/f", "Firebird"], 5000);
        for (const l of String(chaves).split(/\r?\n/).slice(0, 10)) {
            const k = l.trim();
            if (!/^HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\[^\\]+$/i.test(k)) continue;
            const v = await _execTexto("reg", ["query", k, "/v", "ImagePath"], 3000);
            const m = /ImagePath\s+REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?\.exe)/i.exec(String(v));
            if (m) cands.push(path.join(path.dirname(m[1].trim()), nome));
        }
        const raizes = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean);
        for (const r of raizes) {
            ["Firebird_5_0", "Firebird_4_0", "Firebird_3_0", "Firebird_2_5", "Firebird_2_1"].forEach(v => cands.push(path.join(r, "Firebird", v, "bin", nome), path.join(r, "Firebird", v, nome)));
            try { (await fs.promises.readdir(path.join(r, "Firebird"))).forEach(d => cands.push(path.join(r, "Firebird", d, "bin", nome), path.join(r, "Firebird", d, nome))); } catch (_) {}
        }
        // Firebird embutido na pasta de algum programa (ex.: Program Files\Sistema\Firebird\bin).
        for (const c of await _gbakEmbutido(raizes, nome)) cands.push(c);
    } else {
        cands.push("/opt/firebird/bin/gbak", "/usr/bin/gbak", "/usr/local/bin/gbak");
    }
    for (const c of cands) if (await _existe(c)) return c;
    const out = await _execTexto(process.platform === "win32" ? "where" : "which", [nome], 5000);
    for (const l of String(out).split(/\r?\n/)) { const p = l.trim(); if (p && await _existe(p)) return p; }
    return "";
}

const _carimbo = d => {
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
};

/**
 * Cria o gerenciador da cópia.
 * o: { pasta, gbak, porta (do Firebird local), usuario, senha, timeoutMs, log }
 */
function criarCopiaGbak(opcoes) {
    const o = Object.assign({}, opcoes || {});
    const log = typeof o.log === "function" ? o.log : () => {};
    const pasta = path.resolve(String(o.pasta || pastaPadrao()));
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 30 * 60000;
    let filho = null;
    let cancelado = false;
    let emAndamento = false;
    let etapa = "";
    let inicio = 0;
    let etapaDesde = 0;
    let manifestoCache;               // undefined = ainda não lido
    let permissoesFeitas = false;

    const caminhoManifesto = () => path.join(pasta, MANIFESTO);
    const lerManifesto = () => {
        try {
            const m = JSON.parse(fs.readFileSync(caminhoManifesto(), "utf8"));
            if (m && m.arquivo && RE_COPIA.test(path.basename(m.arquivo)) && path.dirname(path.resolve(m.arquivo)) === pasta && fs.existsSync(m.arquivo)) return m;
        } catch (_) {}
        return null;
    };
    const gravarManifesto = m => {
        const tmp = caminhoManifesto() + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
        try { fs.renameSync(tmp, caminhoManifesto()); }
        catch (_) { fs.writeFileSync(caminhoManifesto(), JSON.stringify(m, null, 2)); try { fs.unlinkSync(tmp); } catch (__) {} }
    };
    /** Só nomes criados por este módulo, dentro da pasta, e nunca a cópia ativa. */
    const podeApagar = (arquivo, ativa) => {
        const nome = path.basename(arquivo);
        if (!(RE_COPIA.test(nome) || RE_TEMP.test(nome))) return false;
        if (path.dirname(path.resolve(arquivo)) !== pasta) return false;
        return !(ativa && path.resolve(ativa).toLowerCase() === path.resolve(arquivo).toLowerCase());
    };
    /** Apaga cópias antigas e temporários (o Firebird pode segurar o arquivo: tenta de novo no próximo ciclo). */
    const limpar = () => {
        const m = lerManifesto();
        let n = 0;
        try {
            for (const nome of fs.readdirSync(pasta)) {
                const arq = path.join(pasta, nome);
                if (!podeApagar(arq, m && m.arquivo)) continue;
                try { fs.unlinkSync(arq); n++; } catch (_) {}
            }
        } catch (_) {}
        return n;
    };
    const prepararPasta = () => {
        fs.mkdirSync(pasta, { recursive: true });
        if (permissoesFeitas || process.platform !== "win32") return;
        permissoesFeitas = true;
        // O serviço do Firebird grava a cópia; o grupo Usuários precisa poder apagá-la depois.
        try { cp.execFile("icacls", [pasta, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/C", "/Q"], { windowsHide: true, timeout: 15000 }, () => {}); } catch (_) {}
    };

    const matar = f => {
        if (!f || !f.pid) return;
        try {
            if (process.platform === "win32") cp.spawn("taskkill", ["/F", "/T", "/PID", String(f.pid)], { stdio: "ignore", windowsHide: true });
            else f.kill("SIGKILL");
        } catch (_) {}
    };

    const rodar = (args, rotulo) => new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { ISC_USER: o.usuario || "SYSDBA", ISC_PASSWORD: o.senha == null ? "masterkey" : String(o.senha) });
        let saida = "", fim = false, f;
        const concluir = err => {
            if (fim) return;
            fim = true;
            clearTimeout(tmo);
            if (filho === f) filho = null;
            if (cancelado) err = Object.assign(new Error("cópia cancelada"), { codigo: "CANCELADA" });
            if (err) reject(err); else resolve(saida);
        };
        const tmo = setTimeout(() => {
            matar(f);
            concluir(Object.assign(new Error("tempo esgotado em " + rotulo + " (" + Math.round(timeoutMs / 60000) + " min)"), { codigo: "TEMPO" }));
        }, timeoutMs);
        try {
            // gbak terminado em .js = gbak simulado dos testes (roda pelo próprio Node/Electron).
            f = /\.js$/i.test(o.gbak)
                ? cp.spawn(process.execPath, [o.gbak].concat(args), { env: Object.assign(env, { ELECTRON_RUN_AS_NODE: "1" }), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
                : cp.spawn(o.gbak, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) { concluir(e); return; }
        filho = f;
        try { if (f.pid && os.setPriority) os.setPriority(f.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
        const juntar = b => { saida += decodificarTexto(b); if (saida.length > 20000) saida = saida.slice(-20000); };
        if (f.stdout) f.stdout.on("data", juntar);
        if (f.stderr) f.stderr.on("data", juntar);
        f.on("error", e => concluir(e));
        f.on("close", code => {
            if (code === 0) concluir(null);
            else concluir(new Error(rotulo + " terminou com código " + code + (saida ? ": " + saida.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 400) : "")));
        });
    });

    const renomear = async (de, para) => {
        for (let t = 0; ; t++) {
            try { fs.renameSync(de, para); return; }
            catch (e) { if (t >= 19 || cancelado) throw e; await new Promise(r => setTimeout(r, 500)); }
        }
    };

    /**
     * Faz uma cópia nova de `fonte` ({host, porta, caminho}).
     * Resolve { arquivo, duracaoMs, tamanho }. Mantém a cópia anterior se falhar.
     */
    async function executar(fonte) {
        if (emAndamento) throw new Error("já existe uma cópia em andamento");
        if (!o.gbak) throw new Error("gbak não encontrado nesta máquina.");
        emAndamento = true;
        cancelado = false;
        inicio = Date.now();
        const base = "SMALL_OFFLINE_" + _carimbo(new Date());
        let nome = base, n = 1;
        const fbk = () => path.join(pasta, nome + ".FBK.tmp");
        const fdbTmp = () => path.join(pasta, nome + ".FDB.tmp");
        const fdb = () => path.join(pasta, nome + ".FDB");
        try {
            prepararPasta();
            limpar();
            while (fs.existsSync(fdb()) || fs.existsSync(fdbTmp()) || fs.existsSync(fbk())) nome = base + "_" + (n++);
            etapa = "backup"; etapaDesde = Date.now();
            log("Cópia: backup de " + alvoGbak(fonte.host, fonte.porta, fonte.caminho) + " (sem coleta de lixo)...");
            await rodar(["-b", "-g", alvoGbak(fonte.host, fonte.porta, fonte.caminho), fbk()], "backup (gbak -b)");
            const duracaoBackupMs = Date.now() - inicio;
            etapa = "restauracao"; etapaDesde = Date.now();
            log("Cópia: restaurando em modo somente leitura no Firebird desta máquina...");
            await rodar(["-c", "-mode", "read_only", fbk(), alvoGbak("127.0.0.1", o.porta, fdbTmp())], "restauração (gbak -c)");
            try { fs.unlinkSync(fbk()); } catch (_) {}
            await renomear(fdbTmp(), fdb());
            let tamanho = 0;
            try { tamanho = fs.statSync(fdb()).size; } catch (_) {}
            const duracaoMs = Date.now() - inicio;
            gravarManifesto({ arquivo: fdb(), criadaEm: Date.now(), duracaoMs, duracaoBackupMs, duracaoRestauracaoMs: duracaoMs - duracaoBackupMs, tamanho, fonte: { host: fonte.host, caminho: fonte.caminho } });
            manifestoCache = undefined;
            limpar();
            log("Cópia pronta: " + path.basename(fdb()) + " (" + (tamanho / 1048576).toFixed(1) + " MB em " + Math.round(duracaoMs / 1000) + " s).");
            return { arquivo: fdb(), duracaoMs, tamanho };
        } catch (e) {
            try { fs.unlinkSync(fbk()); } catch (_) {}
            try { fs.unlinkSync(fdbTmp()); } catch (_) {}
            throw e;
        } finally {
            emAndamento = false;
            etapa = "";
        }
    }

    return {
        pasta,
        executar,
        cancelar() { if (!emAndamento) return false; cancelado = true; matar(filho); return true; },
        ativa() { const m = lerManifesto(); return m ? m.arquivo : null; },
        manifesto: lerManifesto,
        limpar,
        /** Andamento: etapa, tempos e a estimativa tirada da última cópia (null na primeira). */
        status() {
            // Manifesto lido uma vez e de novo só depois de cada cópia (status é chamado muitas vezes).
            if (manifestoCache === undefined) manifestoCache = lerManifesto();
            const m = manifestoCache;
            const num = v => (Number(v) > 0 ? Number(v) : null);
            const total = m ? num(m.duracaoMs) : null;
            const bkp = m ? num(m.duracaoBackupMs) : null;
            return {
                emAndamento, etapa, decorridoMs: emAndamento ? Date.now() - inicio : 0,
                inicioEm: emAndamento ? inicio : 0, etapaDesde: emAndamento ? etapaDesde : 0,
                estimativaMs: total,
                estimativaBackupMs: bkp,
                estimativaRestauracaoMs: total && bkp && total > bkp ? total - bkp : null
            };
        },
        definirGbak(g) { o.gbak = g; },
        _podeApagar: podeApagar
    };
}

module.exports = { VERSAO, criarCopiaGbak, localizarGbak, _gbakEmbutido, pastaPadrao, alvoGbak, RE_COPIA, RE_TEMP };
