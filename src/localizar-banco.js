"use strict";
/**
 * localizar-banco.js
 * @version 1.2.0
 * @author Ruda Gabriel
 * @description Descobre sozinho ONDE está o banco do Small Commerce (servidor +
 *              caminho do SMALL.FDB), sem o usuário digitar nada.
 *
 * A meta é ler o banco PELA REDE; o Firebird desta máquina é a ÚLTIMA opção.
 * Só arquivos chamados SMALL.FDB são aceitos (nunca padrao.fdb, exemplo.fdb...).
 * Ordem:
 *   1. a configuração do próprio Small Commerce: .ini/.cfg desta máquina, das
 *      unidades de rede mapeadas e dos compartilhamentos do servidor (o Small
 *      costuma rodar de \\SERVIDOR\SmallSoft\Small Commerce) e os atalhos do
 *      Small na Área de Trabalho/Menu Iniciar — com o servidor citado neles;
 *   1b. o SMALL.FDB procurado nas pastas compartilhadas da rede (atalhos do
 *      Small, unidades mapeadas, \\SERVIDOR\SmallSoft...). A pasta serve só
 *      para ACHAR o arquivo e o servidor: o banco é aberto pelo Firebird do
 *      servidor (SERVIDOR:C:\...\SMALL.FDB), nunca pela pasta compartilhada;
 *   2. os servidores da rede: os citados nessas pistas (pelo NOME, que não
 *      muda quando o IP muda), o configurado, o nome "SERVIDOR" e os achados
 *      na varredura (LAN 192.168 > 10 > 172.16-31 > Tailscale 100.64 > outras >
 *      cabo direto 169.254);
 *   3. por último, o Firebird desta máquina, com o SMALL.FDB do disco local.
 * Uma combinação só é aceita quando o banco ABRE e tem a tabela de produtos
 * (a validação é feita por quem chama, sempre em somente leitura). Servidor que
 * não responde na porta é descartado na hora. O .FDB achado num compartilhamento
 * nunca é aberto pela pasta (abrir .FDB por compartilhamento corrompe o banco):
 * só a lista da pasta é lida, com prazo, e só em servidor com a porta 445 aberta.
 * A busca em disco desta máquina continua ignorando unidades de rede e de CD.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.2.0 — SMALL.FDB procurado nas pastas compartilhadas da rede (busca geral e
 *           caminhoNoServidor) e convertido no caminho do disco do servidor.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const VERSAO = "1.2.0";

// Pastas que nunca têm o banco do Small Commerce (ou são cópias de sistemas de consulta).
const PASTAS_IGNORADAS = new Set([
    "windows", "$recycle.bin", "system volume information", "recovery", "perflogs",
    "$windows.~bt", "$windows.~ws", "msocache", "windowsapps", "winsxs",
    "node_modules", ".git", "appdata", "intel", "amd", "nvidia", "examples",
    "consultaestoquedesktop", "relatoriossmallsoftoffline", "copias"
]);
// Bancos do próprio Firebird, de exemplo ou cópias de consulta: nunca são o banco em uso.
const FDB_IGNORADOS = /^(security\d*|employee|help|isc4|mon\$.*|small_offline_.*)\.fdb$/i;

const ehLocal = h => { const s = String(h || "").trim().toLowerCase(); return s === "127.0.0.1" || s === "localhost" || s === "::1"; };

// Puro: o arquivo é o banco do Small Commerce? Só "SMALL.FDB" (qualquer caixa)
// — padrao.fdb, exemplo.fdb, off.fdb, monitor.fdb e cópias de consulta nunca.
function ehArquivoSmall(caminho) {
    const s = String(caminho || "").trim().replace(/\//g, "\\");
    return /(?:^|[\\:])small\.fdb$/i.test(s);
}

// Puro: nome do servidor de um caminho UNC ("\\SERVIDOR\SmallSoft" → "SERVIDOR").
function hostDeUnc(unc) {
    const m = /^\\\\([A-Za-z0-9][\w.\-]*)\\/.exec(String(unc || "").trim() + "\\");
    return m ? m[1] : null;
}

// Puro: partes de um caminho UNC ("\\SRV\SmallSoft\Small Commerce\SMALL.FDB"
// → { host: "SRV", compart: "SmallSoft", resto: "\Small Commerce\SMALL.FDB" }).
function partesDeUnc(unc) {
    const s = String(unc || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
    const m = /^\\\\([A-Za-z0-9][\w.\-]*)\\([^\\\x00-\x1f"<>|*?:]+)((?:\\[^\\\x00-\x1f"<>|*?:]+)*)$/.exec(s);
    if (!m) return null;
    return { host: m[1], compart: m[2], resto: m[3] || "" };
}

/**
 * Puro: caminhos prováveis, NO DISCO DO SERVIDOR, de um SMALL.FDB achado num
 * compartilhamento. O Windows não diz para que pasta o compartilhamento aponta,
 * então são testadas as instalações típicas de C: a H: (o Firebird do servidor
 * recusa um caminho errado em milissegundos). Compartilhamento administrativo
 * (\\SRV\C$\...) dá o caminho exato.
 */
function caminhosDoCompartilhamento(unc) {
    const p = partesDeUnc(unc);
    if (!p || !ehArquivoSmall(p.resto)) return [];
    const lista = [];
    const vistos = new Set();
    const add = c => { const k = c.toUpperCase(); if (!vistos.has(k)) { vistos.add(k); lista.push(c); } };
    const adm = /^([A-Za-z])\$$/.exec(p.compart);
    if (adm) { add(adm[1].toUpperCase() + ":" + p.resto); return lista; }
    const pais = ["\\Program Files (x86)\\SmallSoft", "\\Program Files\\SmallSoft", "\\SmallSoft", "\\Program Files (x86)", "\\Program Files", ""];
    for (const u of ["C", "D", "E", "F", "G", "H"]) {
        for (const pai of pais) add(u + ":" + pai + "\\" + p.compart + p.resto);
        add(u + ":" + p.resto); // compartilhamento = raiz da unidade
    }
    return lista;
}

// Puro: caminhos UNC citados num atalho (.lnk) do Small Commerce. O .lnk é
// binário, com os caminhos em ANSI e/ou UTF-16 — procura nos dois.
function extrairUncDeAtalho(buf) {
    const hosts = [], pastas = [];
    if (!buf || !buf.length) return { hosts, pastas };
    const textos = [Buffer.from(buf).toString("latin1"), Buffer.from(buf).toString("utf16le")];
    const re = /\\\\[A-Za-z0-9][\w.\-]*(?:\\[^\\\x00-\x1f"<>|*?]+)+/g;
    for (const t of textos) {
        let m;
        while ((m = re.exec(t)) !== null) {
            let p = m[0].replace(/\\+$/, "");
            if (!/small/i.test(p)) continue;
            if (/\.[a-z0-9]{2,4}$/i.test(p)) p = p.replace(/\\[^\\]+$/, ""); // tira o .exe
            const h = hostDeUnc(p);
            if (!h) continue;
            if (hosts.every(x => x.toLowerCase() !== h.toLowerCase())) hosts.push(h);
            if (pastas.every(x => x.toLowerCase() !== p.toLowerCase())) pastas.push(p);
        }
    }
    return { hosts, pastas };
}

// IPs, nome e "localhost" desta máquina, em minúsculas: nenhum deles conta como
// servidor da rede (o Firebird local é só a última opção).
function identidadesDestaMaquina() {
    const out = new Set(["127.0.0.1", "localhost", "::1"]);
    try {
        const os = require("os");
        out.add(String(os.hostname() || "").toLowerCase());
        const ifs = os.networkInterfaces();
        for (const n of Object.keys(ifs || {})) for (const i of (ifs[n] || [])) if (i && i.address) out.add(String(i.address).toLowerCase());
    } catch (_) {}
    if (process.env.COMPUTERNAME) out.add(String(process.env.COMPUTERNAME).toLowerCase());
    out.delete("");
    return out;
}

// Pura: o banco configurado foi adotado pela busca automática e é suspeito —
// desta máquina (a meta é a rede) ou um arquivo que não é SMALL.FDB. Nesse caso
// a busca roda de novo ao iniciar, procurando primeiro o servidor da rede.
function bancoAutoSuspeito(conf, ehLocal) {
    if (!conf || conf.fbHostAuto !== true || conf.fbHostFixo === true) return false;
    const local = typeof ehLocal === "function" ? ehLocal(conf.fbHost)
        : /^(127\.0\.0\.1|localhost|::1)?$/i.test(String(conf.fbHost || "").trim());
    return local || !ehArquivoSmall(conf.fdbPath != null ? conf.fdbPath : conf.fbPath);
}

// Promessa com prazo (pasta de rede fora do ar não pode travar a busca).
function comPrazo(promessa, ms, padrao) {
    return new Promise(resolve => {
        let feito = false;
        const t = setTimeout(() => { if (!feito) { feito = true; resolve(padrao); } }, ms);
        Promise.resolve(promessa).then(v => { if (!feito) { feito = true; clearTimeout(t); resolve(v); } },
                                       () => { if (!feito) { feito = true; clearTimeout(t); resolve(padrao); } });
    });
}

// Unidades de rede mapeadas: [{ letra: "H:", unc: "\\SERVIDOR\SmallSoft" }].
function unidadesDeRede() {
    return new Promise(resolve => {
        if (process.platform !== "win32") return resolve([]);
        try {
            const { execFile } = require("child_process");
            const ps = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | ForEach-Object { $_.DeviceID + '|' + $_.ProviderName }";
            const cod = Buffer.from(ps, "utf16le").toString("base64");
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", cod],
                { windowsHide: true, timeout: 10000 }, (err, stdout) => {
                    const out = [];
                    String(stdout || "").split(/\r?\n/).forEach(l => {
                        const m = /^([A-Z]:)\|(\\\\.+)$/i.exec(l.trim());
                        if (m) out.push({ letra: m[1].toUpperCase(), unc: m[2].trim() });
                    });
                    resolve(out);
                });
        } catch (_) { resolve([]); }
    });
}

// Atalhos (.lnk) da Área de Trabalho e do Menu Iniciar que apontam para o
// Small Commerce num compartilhamento de rede.
async function pistasDeAtalhos() {
    const pastas = [];
    const e = process.env;
    if (process.platform !== "win32") return { hosts: [], pastas: [] };
    [e.USERPROFILE && path.join(e.USERPROFILE, "Desktop"), e.USERPROFILE && path.join(e.USERPROFILE, "OneDrive", "Desktop"),
     e.PUBLIC && path.join(e.PUBLIC, "Desktop"), e.APPDATA && path.join(e.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
     e.ProgramData && path.join(e.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")].forEach(p => { if (p) pastas.push(p); });
    const arquivos = [];
    const visitar = async (dir, prof) => {
        if (arquivos.length >= 300) return;
        const ents = await comPrazo(fs.promises.readdir(dir, { withFileTypes: true }), 3000, []);
        for (const x of ents) {
            const p = path.join(dir, x.name);
            if (x.isFile() && /\.lnk$/i.test(x.name)) arquivos.push(p);
            else if (x.isDirectory() && prof < 2) await visitar(p, prof + 1);
        }
    };
    for (const p of pastas) await visitar(p, 0);
    const hosts = [], achadas = [];
    for (const a of arquivos) {
        const buf = await comPrazo(fs.promises.readFile(a), 3000, null);
        if (!buf || buf.length > 256 * 1024) continue;
        const r = extrairUncDeAtalho(buf);
        r.hosts.forEach(h => { if (hosts.every(x => x.toLowerCase() !== h.toLowerCase())) hosts.push(h); });
        r.pastas.forEach(q => { if (achadas.every(x => x.toLowerCase() !== q.toLowerCase())) achadas.push(q); });
    }
    return { hosts, pastas: achadas };
}


// ── Puras ────────────────────────────────────────────────────────────────────
/** Bases /24 das interfaces IPv4 úteis, em ordem de preferência. */
function classificarRedes(ifaces) {
    const vistas = new Set();
    const lista = [];
    for (const nome of Object.keys(ifaces || {})) {
        for (const iface of (ifaces[nome] || [])) {
            if (!iface || iface.internal) continue;
            if (!(iface.family === "IPv4" || iface.family === 4)) continue;
            const p = String(iface.address || "").split(".").map(Number);
            if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
            if (p[0] === 127 || p[0] === 0) continue;
            const base = p[0] + "." + p[1] + "." + p[2];
            if (vistas.has(base)) continue;
            vistas.add(base);
            let prio = 4;
            if (p[0] === 192 && p[1] === 168) prio = 0;
            else if (p[0] === 10) prio = 1;
            else if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) prio = 2;
            else if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) prio = 3;
            else if (p[0] === 169 && p[1] === 254) prio = 5;
            lista.push({ base, prio });
        }
    }
    lista.sort((a, b) => a.prio - b.prio);
    return lista.map(x => x.base);
}

/** IPv4 desta máquina (para não tratar a própria máquina como "servidor da rede"). */
function ipsLocais(ifaces) {
    const out = new Set(["127.0.0.1"]);
    for (const nome of Object.keys(ifaces || {})) {
        for (const i of (ifaces[nome] || [])) if (i && (i.family === "IPv4" || i.family === 4) && i.address) out.add(String(i.address));
    }
    return out;
}

/**
 * Caminhos possíveis do banco no disco do SERVIDOR: o configurado, os `extras`
 * (do .ini e das pastas achadas no disco local — servidores costumam repetir a
 * estrutura) e as instalações típicas de C: a H:. Só caminhos de SMALL.FDB.
 */
function caminhosConhecidos(configurado, extras) {
    const unidades = ["C", "D", "E", "F", "G", "H"];
    const sufixos = [
        "\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "\\Program Files\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "\\Small Commerce\\SMALL.FDB",
        "\\SmallCommerce\\SMALL.FDB",
        "\\SmallSoft\\SMALL.FDB",
        "\\Dados\\SMALL.FDB",
        "\\Small\\SMALL.FDB",
        "\\SMALL.FDB"
    ];
    const lista = [configurado];
    for (const e of (extras || [])) lista.push(e);
    lista.push("C:\\ProgramData\\SmallSoft\\Small Commerce\\SMALL.FDB");
    for (const u of unidades) for (const s of sufixos) lista.push(u + ":" + s);
    const vistos = new Set();
    const out = [];
    for (const c of lista) {
        if (!c || !ehArquivoSmall(c)) continue;
        const t = String(c).trim();
        const k = t.toUpperCase();
        if (!t || vistos.has(k)) continue;
        vistos.add(k);
        out.push(t);
    }
    return out;
}

/**
 * Extrai do texto de um .ini as referências a banco Firebird ("C:\...\X.FDB",
 * "servidor:C:\...\X.FDB", "servidor/3050:C:\...") e os hosts de chaves como
 * Servidor=, Server=, Host=, IP=, Computador=. Independe do formato do .ini.
 */
function extrairBancosDeIni(texto) {
    const bancos = [];
    const hosts = [];
    const vistos = new Set();
    const txt = String(texto || "");
    const reBanco = /(?:([A-Za-z0-9][\w.\-]*)(?:\/\d+)?:)?([A-Za-z]:\\[^\r\n"';=|<>]*?\.fdb)\b/gi;
    let m;
    while ((m = reBanco.exec(txt)) !== null) {
        const host = m[1] && m[1].length > 1 ? m[1] : null; // "C" sozinho é unidade, não host
        const caminho = m[2];
        const k = (host || "") + "|" + caminho.toUpperCase();
        if (vistos.has(k)) continue;
        vistos.add(k);
        bancos.push({ host, caminho });
    }
    const reHost = /^\s*(?:servidor|server|host|ip|hostname|ipservidor|computador|maquina)\s*=\s*([A-Za-z0-9][\w.\-]*)\s*$/gim;
    while ((m = reHost.exec(txt)) !== null) {
        if (hosts.indexOf(m[1]) === -1) hosts.push(m[1]);
    }
    return { bancos, hosts };
}

/** Ordem de preferência entre .FDB locais: SMALL.FDB, pasta de instalação, mais recente. */
function compararLocais(a, b) {
    const nome = x => x.nome || path.posix.basename(String(x.caminho || "").replace(/\\/g, "/"));
    const sa = /^small\.fdb$/i.test(nome(a)) ? 0 : 1;
    const sb = /^small\.fdb$/i.test(nome(b)) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const pasta = c => path.posix.basename(path.posix.dirname(String(c || "").replace(/\\/g, "/"))).toLowerCase();
    const ia = /^(small ?commerce|smallsoft)$/.test(pasta(a.caminho)) ? 0 : 1;
    const ib = /^(small ?commerce|smallsoft)$/.test(pasta(b.caminho)) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    return (b.mtime || 0) - (a.mtime || 0);
}

/**
 * Tenta as combinações {host, caminho} em ordem; devolve a primeira em que
 * `validar` resolver { ok: true }, mais as falhas (para o diagnóstico).
 * Servidor marcado como inacessível é pulado nas combinações seguintes.
 */
async function primeiraQueAbre(combos, validar, prazoMs) {
    const limite = Date.now() + (prazoMs || 90000);
    const falhas = [];
    const inacessiveis = new Set();
    for (const c of (combos || [])) {
        if (Date.now() > limite) break;
        if (inacessiveis.has(c.host)) continue;
        let r = null;
        try { r = await validar(c.host, c.caminho); }
        catch (e) { r = { ok: false, motivo: String((e && e.message) || e) }; }
        if (r && r.ok) return { combo: c, falhas };
        if (r && r.inacessivel) inacessiveis.add(c.host);
        falhas.push({ host: c.host, caminho: c.caminho, motivo: (r && r.motivo) || "", auth: !!(r && r.auth), inacessivel: !!(r && r.inacessivel) });
    }
    return { combo: null, falhas };
}

// ── Disco ────────────────────────────────────────────────────────────────────
function unidadesExistentes() {
    if (process.platform !== "win32") return [];
    const out = [];
    for (let c = 67; c <= 90; c++) {
        const raiz = String.fromCharCode(c) + ":\\";
        try { if (fs.existsSync(raiz)) out.push(raiz); } catch (_) {}
    }
    return out;
}

/** Unidades seguras para procurar: exclui as de REDE (tipo 4) e de CD/DVD (tipo 5). */
function unidadesSeguras(log) {
    return new Promise(resolve => {
        const todas = unidadesExistentes();
        if (process.platform !== "win32" || !todas.length) { resolve(todas); return; }
        try {
            const ps = "Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + '|' + $_.DriveType }";
            const cod = Buffer.from(ps, "utf16le").toString("base64");
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", cod],
                { windowsHide: true, timeout: 10000 }, (err, stdout) => {
                    if (err || !stdout) { resolve(todas); return; }
                    const bloquear = new Set();
                    String(stdout).split(/\r?\n/).forEach(l => {
                        const m = /^([A-Z]):\|(\d+)/i.exec(l.trim());
                        if (m && (m[2] === "4" || m[2] === "5")) bloquear.add(m[1].toUpperCase());
                    });
                    if (bloquear.size && log) log("Unidades de rede/CD ignoradas na busca: " + Array.from(bloquear).join(": ") + ":");
                    resolve(todas.filter(r => !bloquear.has(r.charAt(0).toUpperCase())));
                });
        } catch (_) { resolve(todas); }
    });
}

/**
 * Procura .FDB no disco local com limites de profundidade, quantidade e tempo.
 * Pastas com "small", "dados", "banco" no nome são visitadas primeiro. Anota em
 * `opcoes.pastasIni` as pastas "do Small" que têm arquivos .ini/.cfg.
 */
async function buscarFdbLocais(raizes, opcoes) {
    const o = opcoes || {};
    const maxProf = o.maxProf != null ? o.maxProf : 6;
    const maxArq = o.maxArquivos || 15;
    const prazo = Date.now() + (o.prazoMs || 25000);
    const pastasIni = Array.isArray(o.pastasIni) ? o.pastasIni : null;
    const achados = [];
    const fila = (raizes || []).map(r => ({ dir: r, prof: 0 }));
    const prioritaria = nome => /small|dados|banco|fdb|commerce/i.test(nome);
    while (fila.length && achados.length < maxArq && Date.now() < prazo) {
        const { dir, prof } = fila.shift();
        let ents;
        try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
        const subPrio = [], subNormal = [];
        let temIni = false;
        for (const e of ents) {
            const nome = e.name;
            const caminho = path.join(dir, nome);
            if (e.isFile() && /\.fdb$/i.test(nome)) {
                if (FDB_IGNORADOS.test(nome) || !ehArquivoSmall(nome)) continue;
                let mtime = 0;
                try { mtime = (await fs.promises.stat(caminho)).mtimeMs; } catch (_) {}
                achados.push({ caminho, nome, mtime });
                if (achados.length >= maxArq) break;
            } else if (e.isFile() && /\.(ini|cfg|conf)$/i.test(nome)) {
                temIni = true;
            } else if (e.isDirectory() && prof < maxProf) {
                if (PASTAS_IGNORADAS.has(nome.toLowerCase())) continue;
                (prioritaria(nome) ? subPrio : subNormal).push({ dir: caminho, prof: prof + 1 });
            }
        }
        if (pastasIni && temIni && /small/i.test(dir) && pastasIni.indexOf(dir) === -1) pastasIni.push(dir);
        fila.unshift(...subPrio);
        fila.push(...subNormal);
    }
    achados.sort(compararLocais);
    return achados.map(a => ({ caminho: a.caminho, mtime: a.mtime }));
}

/**
 * Procura o SMALL.FDB nas pastas COMPARTILHADAS da rede (caminhos UNC). Só lê a
 * lista das pastas — o arquivo nunca é aberto por aqui. Cada leitura tem prazo,
 * servidor sem a porta 445 (compartilhamento) é pulado sem tocar na pasta, e há
 * limite de profundidade, de pastas e de tempo total. Devolve os UNC achados.
 * opcoes: { hostAcessivel(host) → Promise<bool>, log, maxProf, maxPastas,
 *           maxArquivos, prazoMs, prazoPastaMs, lerPasta (testes) }
 */
async function buscarFdbNaRede(pastas, opcoes) {
    const o = opcoes || {};
    const lerPasta = typeof o.lerPasta === "function" ? o.lerPasta
        : (process.platform === "win32" ? (p => fs.promises.readdir(p, { withFileTypes: true })) : null);
    if (!lerPasta) return [];
    const log = typeof o.log === "function" ? o.log : null;
    const maxProf = o.maxProf != null ? o.maxProf : 3;
    const maxPastas = o.maxPastas || 150;
    const maxArq = o.maxArquivos || 5;
    const prazo = Date.now() + (o.prazoMs || 20000);
    const prazoPasta = o.prazoPastaMs || 4000;
    const hostOk = typeof o.hostAcessivel === "function" ? o.hostAcessivel : async () => true;
    const statusHost = new Map();
    const achados = [];
    const vistos = new Set();
    const fila = [];
    for (const p of (pastas || [])) {
        const s = String(p || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
        if (partesDeUnc(s)) fila.push({ dir: s, prof: 0 });
    }
    const prioritaria = nome => /small|dados|banco|fdb|commerce/i.test(nome);
    let visitadas = 0;
    while (fila.length && achados.length < maxArq && visitadas < maxPastas && Date.now() < prazo) {
        const { dir, prof } = fila.shift();
        const k = dir.toUpperCase();
        if (vistos.has(k)) continue;
        vistos.add(k);
        const host = hostDeUnc(dir);
        if (!host) continue;
        const hk = host.toLowerCase();
        if (!statusHost.has(hk)) {
            const ok = await comPrazo(Promise.resolve().then(() => hostOk(host)), 3000, false);
            statusHost.set(hk, ok === true);
            if (ok !== true && log) log("Pastas compartilhadas de " + host + " fora do alcance (porta 445) — puladas.");
        }
        if (!statusHost.get(hk)) continue;
        visitadas++;
        const ents = await comPrazo(Promise.resolve().then(() => lerPasta(dir)), prazoPasta, null);
        if (!Array.isArray(ents)) continue;
        const subPrio = [], subNormal = [];
        for (const e of ents) {
            const nome = e && typeof e.name === "string" ? e.name : "";
            if (!nome) continue;
            let arquivo = false, pasta = false;
            try { arquivo = e.isFile(); pasta = e.isDirectory(); } catch (_) { continue; }
            const caminho = dir + "\\" + nome;
            if (arquivo && /\.fdb$/i.test(nome)) {
                if (FDB_IGNORADOS.test(nome) || !ehArquivoSmall(nome)) continue;
                if (achados.every(a => a.toUpperCase() !== caminho.toUpperCase())) achados.push(caminho);
                if (achados.length >= maxArq) break;
            } else if (pasta && prof < maxProf && !nome.endsWith("$")) {
                if (PASTAS_IGNORADAS.has(nome.toLowerCase())) continue;
                (prioritaria(nome) ? subPrio : subNormal).push({ dir: caminho, prof: prof + 1 });
            }
        }
        fila.unshift(...subPrio);
        fila.push(...subNormal);
    }
    if (achados.length && log) log("SMALL.FDB encontrado na pasta compartilhada: " + achados.join(" | ") + " — será aberto pelo Firebird do servidor, nunca pela pasta.");
    return achados;
}

/** Lê os .ini/.cfg das pastas do Small Commerce (típicas + `pastasExtras`). */
async function lerConfiguracoesSmall(pastasExtras, log, hostDaPasta) {
    const pastas = [];
    for (const u of ["C", "D", "E", "F", "G", "H"]) {
        pastas.push(u + ":\\Program Files (x86)\\SmallSoft\\Small Commerce");
        pastas.push(u + ":\\Program Files\\SmallSoft\\Small Commerce");
        pastas.push(u + ":\\SmallSoft\\Small Commerce");
        pastas.push(u + ":\\Small Commerce");
        pastas.push(u + ":\\SmallSoft");
    }
    for (const p of (pastasExtras || [])) pastas.push(p);
    const vistas = new Set();
    const bancos = [], hosts = [];
    for (const pasta of pastas) {
        const kp = String(pasta).toUpperCase();
        if (vistas.has(kp)) continue;
        vistas.add(kp);
        // Pasta de rede fora do ar não pode travar a busca: prazo em cada leitura.
        const ents = await comPrazo(fs.promises.readdir(pasta, { withFileTypes: true }), 4000, null);
        if (!ents) continue;
        const origemHost = typeof hostDaPasta === "function" ? hostDaPasta(pasta) : null;
        for (const e of ents) {
            if (!e.isFile() || !/\.(ini|cfg|conf)$/i.test(e.name)) continue;
            const arq = path.join(pasta, e.name);
            try {
                const st = await comPrazo(fs.promises.stat(arq), 4000, null);
                if (!st || st.size > 512 * 1024) continue;
                const texto = await comPrazo(fs.promises.readFile(arq, "latin1"), 4000, null);
                if (texto == null) continue;
                const r = extrairBancosDeIni(texto);
                r.bancos.forEach(b => bancos.push(Object.assign({}, b, { origemHost })));
                r.hosts.forEach(h => { if (hosts.indexOf(h) === -1) hosts.push(h); });
                if ((r.bancos.length || r.hosts.length) && log) log("Configuração do Small Commerce lida em " + arq);
            } catch (_) {}
        }
    }
    return { bancos, hosts };
}

// ── Rede ─────────────────────────────────────────────────────────────────────
/** Firebird (porta aberta) numa /24. Só teste de porta, sem login. */
async function escanearSubnet(portaAberta, porta, base, limite, log) {
    if (!base) return [];
    if (log) log("Procurando servidores Firebird na rede " + base + ".0/24 (porta " + porta + ")...");
    const LOTE = 32;
    const achados = [];
    for (let ini = 1; ini <= 254; ini += LOTE) {
        const hosts = [];
        for (let i = ini; i < Math.min(ini + LOTE, 255); i++) hosts.push(base + "." + i);
        const r = await Promise.all(hosts.map(h => portaAberta(h, porta, 400).catch(() => false)));
        for (let i = 0; i < hosts.length; i++) {
            if (!r[i]) continue;
            achados.push(hosts[i]);
            if (achados.length >= (limite || 10)) return achados;
        }
    }
    return achados;
}

/**
 * Procura o caminho do SMALL.FDB num servidor JÁ conhecido (o configurado pelo
 * usuário ou o achado antes): caminhos típicos de C: a H: e o anterior.
 * dep: { host, cfg, validar, portaAberta, log, extras }. Não troca o servidor.
 */
async function caminhoNoServidor(dep) {
    const d = dep || {};
    const cfg = d.cfg || {};
    const porta = Number(cfg.fbPorta) || 3050;
    const host = String(d.host || "").trim();
    if (!host) return { achado: null, falhas: [], mensagem: "Servidor não informado." };
    let aberta = false;
    try { aberta = await d.portaAberta(host, porta, 2000); } catch (_) {}
    if (!aberta) return { achado: null, falhas: [], mensagem: "O servidor " + host + " não respondeu na porta " + porta + "." };
    // Pastas compartilhadas DESSE servidor: o SMALL.FDB achado lá vira o caminho no disco dele.
    let doCompart = [];
    try {
        doCompart = await (d.buscarRede || buscarFdbNaRede)(
            ["\\SmallSoft\\Small Commerce", "\\Small Commerce", "\\SmallSoft"].map(x => "\\\\" + host + x),
            { log: d.log, prazoMs: 10000, hostAcessivel: h => d.portaAberta(h, 445, 1500) });
    } catch (_) {}
    const extras = [];
    (Array.isArray(doCompart) ? doCompart : []).forEach(u => caminhosDoCompartilhamento(u).forEach(c => extras.push(c)));
    (Array.isArray(d.extras) ? d.extras : []).forEach(c => extras.push(c));
    const combos = caminhosConhecidos(cfg.fdbPath, extras).map(c => ({ host, caminho: c }));
    const r = await primeiraQueAbre(combos, d.validar, 60000);
    if (r.combo) return { achado: r.combo, falhas: r.falhas, mensagem: "SMALL.FDB encontrado em " + host + ":" + r.combo.caminho + "." };
    const auth = r.falhas.find(f => f.auth);
    return {
        achado: null, falhas: r.falhas,
        mensagem: auth ? "O servidor " + host + " recusou o usuário/senha do Firebird. Ajuste em Configurações → Banco de dados."
            : "O SMALL.FDB não foi encontrado nos caminhos típicos do servidor " + host + ". Informe o caminho em Configurações → Banco de dados."
    };
}

// ── Orquestração ─────────────────────────────────────────────────────────────
/**
 * Procura o banco. dep:
 *   cfg            configuração atual (fbHost, fbPorta, fdbPath, varrerRede)
 *   validar(h, c)  → Promise<{ ok, auth, inacessivel, motivo }> (abre em somente leitura)
 *   portaAberta(h, porta, ms) → Promise<bool>
 *   log(msg)
 *   interfaces     (opcional) os.networkInterfaces()
 *   identidades    (opcional) Set com IPs/nomes desta máquina, em minúsculas
 *   raizesDisco    (opcional) raízes para a busca em disco (padrão: unidades seguras)
 *   lerIni         (opcional) substitui lerConfiguracoesSmall (testes)
 *   unidadesRede   (opcional) substitui unidadesDeRede (testes)
 *   atalhos        (opcional) substitui pistasDeAtalhos (testes)
 *   buscarRede     (opcional) substitui buscarFdbNaRede (testes)
 *   cancelado()    (opcional) → true interrompe entre as etapas
 * Resolve { achado: {host, caminho} | null, falhas, mensagem }.
 */
async function localizar(dep) {
    const d = dep || {};
    const cfg = d.cfg || {};
    const log = typeof d.log === "function" ? d.log : () => {};
    const porta = Number(cfg.fbPorta) || 3050;
    const cancelado = typeof d.cancelado === "function" ? d.cancelado : () => false;
    const portaAberta = d.portaAberta;
    const hostAtual = String(cfg.fbHost || "").trim();
    const ifaces = d.interfaces || os.networkInterfaces();
    const proprios = d.identidades || identidadesDestaMaquina();
    ipsLocais(ifaces).forEach(ip => proprios.add(ip));
    const daMaquina = h => ehLocal(h) || proprios.has(String(h || "").trim().toLowerCase());

    const vistos = new Set();
    const adicionar = (lista, host, caminho) => {
        if (!host || !caminho || !ehArquivoSmall(caminho)) return;
        const k = String(host).toLowerCase() + "|" + String(caminho).toUpperCase();
        if (vistos.has(k)) return;
        vistos.add(k);
        lista.push({ host, caminho });
    };
    let falhas = [];
    let achado = null;
    const validarComPorta = async (host, caminho) => {
        let aberta = false;
        try { aberta = await portaAberta(host, porta, 1500); } catch (_) {}
        if (!aberta) return { ok: false, inacessivel: true, motivo: "servidor não respondeu na porta " + porta };
        return d.validar(host, caminho);
    };
    const tentar = async (combos, prazoMs) => {
        if (achado || !combos.length || cancelado()) return;
        const r = await primeiraQueAbre(combos, validarComPorta, prazoMs);
        falhas = falhas.concat(r.falhas);
        if (r.combo) achado = r.combo;
    };

    let localAtivo = false;
    try { localAtivo = await portaAberta("127.0.0.1", porta, 800); } catch (_) {}

    // Pistas da rede: unidades mapeadas e atalhos do Small Commerce.
    let unidRede = [];
    try { unidRede = await (d.unidadesRede || unidadesDeRede)(); } catch (_) {}
    let atalhos = { hosts: [], pastas: [] };
    try { atalhos = await (d.atalhos || pistasDeAtalhos)(); } catch (_) {}
    const hostsRede = [];
    const addHostRede = h => { if (h && !daMaquina(h) && !hostsRede.some(x => x.toLowerCase() === String(h).toLowerCase())) hostsRede.push(String(h)); };
    unidRede.forEach(u => addHostRede(hostDeUnc(u.unc)));
    atalhos.hosts.forEach(addHostRede);
    if (unidRede.length) log("Unidades de rede: " + unidRede.map(u => u.letra + " = " + u.unc).join(" | "));
    if (atalhos.pastas.length) log("Atalhos do Small Commerce apontam para: " + atalhos.pastas.join(" | "));
    const pastasRede = [];
    const sub = ["", "\\SmallSoft\\Small Commerce", "\\Small Commerce", "\\SmallSoft", "\\Program Files (x86)\\SmallSoft\\Small Commerce"];
    unidRede.forEach(u => sub.forEach(x => { pastasRede.push(u.letra + (x || "\\")); if (u.unc) pastasRede.push(u.unc + x); }));
    atalhos.pastas.forEach(p => pastasRede.push(p));
    hostsRede.concat(["SERVIDOR"]).forEach(h => ["\\SmallSoft\\Small Commerce", "\\Small Commerce", "\\SmallSoft"].forEach(x => pastasRede.push("\\\\" + h + x)));
    const hostDaPasta = p => {
        const s = String(p || "");
        if (s.startsWith("\\\\")) return hostDeUnc(s);
        const u = unidRede.find(x => s.toUpperCase().startsWith(x.letra));
        return u ? hostDeUnc(u.unc) : null;
    };

    // Disco desta máquina (uma vez): SMALL.FDB + pastas do Small com .ini.
    const pastasIni = [];
    let noDisco = [];
    try {
        log("Procurando a configuração do Small Commerce nesta máquina e na rede...");
        const raizes = d.raizesDisco || await unidadesSeguras(log);
        noDisco = await buscarFdbLocais(raizes, { pastasIni });
    } catch (_) {}

    // (1) Configuração do próprio Small Commerce.
    let ini = { bancos: [], hosts: [] };
    try { ini = await (d.lerIni || lerConfiguracoesSmall)(pastasIni.concat(pastasRede), log, hostDaPasta); } catch (_) {}
    ini.hosts.forEach(addHostRede);
    {
        const combos = [];
        for (const b of ini.bancos) {
            if (b.host && !daMaquina(b.host)) { adicionar(combos, b.host, b.caminho); continue; }
            if (b.host) continue; // aponta para esta máquina: fica para o fim
            // Caminho sem servidor num .ini lido do compartilhamento de um servidor = disco DELE.
            if (b.origemHost && !daMaquina(b.origemHost)) adicionar(combos, b.origemHost, b.caminho);
            for (const h of hostsRede) adicionar(combos, h, b.caminho);
        }
        if (combos.length) {
            log("Testando o banco indicado pela configuração do Small Commerce...");
            await tentar(combos, 90000);
        }
    }

    // (1b) SMALL.FDB nas pastas compartilhadas da rede: a pasta só diz QUAL
    // servidor tem o banco e onde; ele é aberto pelo Firebird desse servidor.
    if (!achado && !cancelado()) {
        const pastasFdb = [];
        atalhos.pastas.forEach(p => pastasFdb.push(p));
        unidRede.forEach(u => { if (u.unc) pastasFdb.push(u.unc); });
        hostsRede.concat(["SERVIDOR"]).forEach(h => ["\\SmallSoft\\Small Commerce", "\\Small Commerce", "\\SmallSoft"].forEach(x => pastasFdb.push("\\\\" + h + x)));
        let naRede = [];
        try {
            log("Procurando o SMALL.FDB nas pastas compartilhadas da rede...");
            naRede = await (d.buscarRede || buscarFdbNaRede)(pastasFdb, { log, hostAcessivel: h => portaAberta(h, 445, 1500) });
        } catch (_) {}
        const combos = [];
        for (const unc of (Array.isArray(naRede) ? naRede : [])) {
            const h = hostDeUnc(unc);
            if (!h || daMaquina(h)) continue;
            addHostRede(h);
            for (const c of caminhosDoCompartilhamento(unc)) adicionar(combos, h, c);
        }
        if (combos.length) {
            log("Testando, pelo Firebird do servidor, o SMALL.FDB achado na pasta compartilhada...");
            await tentar(combos, 90000);
        }
    }

    const extras = ini.bancos.map(b => b.caminho).concat(noDisco.map(x => x.caminho));
    const caminhos = caminhosConhecidos(cfg.fdbPath, extras);

    // (2) Servidores da rede.
    if (!achado && !cancelado()) {
        const hosts = [];
        const add = h => { if (h && !daMaquina(h) && !hosts.some(x => x.toLowerCase() === String(h).toLowerCase())) hosts.push(String(h).trim()); };
        hostsRede.forEach(add);
        add(hostAtual);
        add("SERVIDOR");
        if (cfg.varrerRede !== false) {
            for (const base of classificarRedes(ifaces).slice(0, 4)) {
                if (cancelado()) break;
                (await escanearSubnet(portaAberta, porta, base, 10, log)).forEach(add);
            }
        }
        const combos = [];
        for (const h of hosts) for (const c of caminhos) adicionar(combos, h, c);
        if (combos.length) {
            log("Testando o banco nos servidores da rede: " + hosts.join(", ") + "...");
            await tentar(combos, 240000);
        }
    }

    // (3) Última opção: o Firebird desta máquina.
    if (!achado && localAtivo && !cancelado()) {
        const combos = [];
        for (const b of ini.bancos) if (!b.host || daMaquina(b.host)) adicionar(combos, "127.0.0.1", b.caminho);
        for (const x of noDisco) adicionar(combos, "127.0.0.1", x.caminho);
        for (const c of caminhos) adicionar(combos, "127.0.0.1", c);
        if (combos.length) {
            log("Nenhum servidor da rede tem o banco — última opção: o SMALL.FDB desta máquina...");
            await tentar(combos, 90000);
        }
    }

    if (achado) return { achado, falhas, mensagem: "Banco encontrado em " + achado.host + ":" + achado.caminho + (achado.host === "127.0.0.1" ? " (nesta máquina — nenhum servidor da rede respondeu)." : ".") };
    const comAuth = falhas.find(f => f.auth);
    let mensagem;
    if (comAuth) mensagem = "O banco foi encontrado em " + comAuth.host + " (" + comAuth.caminho + "), mas o usuário/senha do Firebird não conferem. Ajuste em Configurações → Banco de dados.";
    else if (hostAtual && !daMaquina(hostAtual) && falhas.some(f => f.host === hostAtual && f.inacessivel))
        mensagem = "O servidor " + hostAtual + " não respondeu na porta " + porta + " e o SMALL.FDB não foi encontrado em outro servidor da rede nem nesta máquina. Verifique se o servidor do Small Commerce está ligado e acessível (mesma rede, cabo ou VPN).";
    else mensagem = "O SMALL.FDB do Small Commerce não foi encontrado na rede nem nesta máquina. Verifique se o servidor está ligado e acessível, ou informe o endereço em Configurações → Banco de dados.";
    return { achado: null, falhas, mensagem };
}

module.exports = {
    VERSAO, classificarRedes, ipsLocais, caminhosConhecidos, extrairBancosDeIni, compararLocais, primeiraQueAbre,
    unidadesSeguras, buscarFdbLocais, lerConfiguracoesSmall, escanearSubnet, localizar, ehLocal, FDB_IGNORADOS,
    caminhoNoServidor, ehArquivoSmall, hostDeUnc, partesDeUnc, caminhosDoCompartilhamento, buscarFdbNaRede, extrairUncDeAtalho, identidadesDestaMaquina, bancoAutoSuspeito, comPrazo, unidadesDeRede, pistasDeAtalhos
};
