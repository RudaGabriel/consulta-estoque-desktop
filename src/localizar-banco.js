"use strict";
/**
 * localizar-banco.js
 * @version 1.5.0
 * @author Ruda Gabriel
 * @description Descobre sozinho ONDE está o banco de dados (servidor +
 *              caminho do SMALL.FDB), sem o usuário digitar nada.
 *
 * Meta (cfg.metaBusca, perguntada ao usuário): "rede" (padrão) testa o servidor
 * da rede primeiro e o Firebird desta máquina por último; "local" testa esta
 * máquina primeiro. Nos dois casos a busca VARRE TUDO: disco local, pastas
 * compartilhadas e a rede inteira. O nome procurado é SMALL.FDB; se não houver
 * nenhum em lugar nenhum, os outros .FDB achados voltam em `outros` para o
 * usuário escolher (validarOutros abre cada um, em somente leitura).
 * Etapas:
 *   1. a configuração do sistema de gestão: .ini/.cfg das pastas de programa
 *      deste computador, das unidades de rede mapeadas e das pastas
 *      compartilhadas dos servidores (o sistema costuma rodar de uma pasta
 *      compartilhada do servidor) e os atalhos da Área de Trabalho/Menu
 *      Iniciar que apontam para a rede — com o servidor citado neles;
 *   2. os servidores da rede: os citados nessas pistas (pelo NOME, que não
 *      muda quando o IP muda), o configurado, o nome "SERVIDOR" e os achados
 *      na varredura (LAN 192.168 > 10 > 172.16-31 > VPN 100.64 > outras >
 *      cabo direto 169.254);
 *   3. o SMALL.FDB nas pastas compartilhadas de todos esses servidores (as das
 *      pistas e as listadas pelo próprio servidor com "net view"). A pasta serve
 *      só para ACHAR o arquivo: o banco é aberto pelo Firebird do servidor,
 *      nunca pela pasta;
 *   4. em cada servidor, os caminhos das pistas (também em outras unidades) e
 *      os genéricos (\SMALL.FDB, \Dados, \Banco);
 *   5. o Firebird desta máquina com o SMALL.FDB do disco local (primeiro, quando
 *      a meta é "local").
 * Uma combinação só é aceita quando o banco ABRE e tem a tabela de produtos
 * (a validação é feita por quem chama, sempre em somente leitura). Servidor que
 * não responde na porta é descartado na hora. O .FDB achado num compartilhamento
 * nunca é aberto pela pasta (abrir .FDB por compartilhamento corrompe o banco):
 * só a lista da pasta é lida, com prazo, e só em servidor com a porta 445 aberta.
 * A busca em disco desta máquina ignora unidades de rede e de CD (a rede é
 * procurada pelos compartilhamentos). Nenhum nome de sistema, marca ou pasta de
 * instalação de terceiros é usado: só o que é achado neste computador e na rede.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.5.0 — Busca genérica, sem nenhum nome de pasta de instalação de terceiros: as
 *           pastas compartilhadas vêm do "net view" do servidor, o caminho no
 *           servidor sai da estrutura de pastas deste computador (a mesma pasta
 *           do compartilhamento) e das pistas em outras unidades, e o .ini é lido
 *           nas pastas de programa achadas na varredura do disco.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const VERSAO = "1.4.0";

// Pastas que nunca têm o banco de dados em uso (ou são cópias feitas por programas de consulta).
const PASTAS_IGNORADAS = new Set([
    "windows", "$recycle.bin", "system volume information", "recovery", "perflogs",
    "$windows.~bt", "$windows.~ws", "msocache", "windowsapps", "winsxs",
    "node_modules", ".git", "appdata", "intel", "amd", "nvidia", "examples",
    "consultaestoquedesktop", "copias"
]);
// Bancos do próprio Firebird, de exemplo ou cópias de consulta: nunca são o banco em uso.
const FDB_IGNORADOS = /^(security\d*|employee|help|isc4|mon\$.*|small_offline_.*)\.fdb$/i;

const ehLocal = h => { const s = String(h || "").trim().toLowerCase(); return s === "127.0.0.1" || s === "localhost" || s === "::1"; };

// Puro: o arquivo é o banco procurado? Só "SMALL.FDB" (qualquer caixa)
// — padrao.fdb, exemplo.fdb, off.fdb, monitor.fdb e cópias de consulta nunca.
function ehArquivoSmall(caminho) {
    const s = String(caminho || "").trim().replace(/\//g, "\\");
    return /(?:^|[\\:])small\.fdb$/i.test(s);
}

// Puro: nome do servidor de um caminho UNC ("\\SERVIDOR\Dados" → "SERVIDOR").
function hostDeUnc(unc) {
    const m = /^\\\\([A-Za-z0-9][\w.\-]*)\\/.exec(String(unc || "").trim() + "\\");
    return m ? m[1] : null;
}

// Puro: partes de um caminho UNC ("\\SRV\Sistema\Dados\SMALL.FDB"
// → { host: "SRV", compart: "Sistema", resto: "\Dados\SMALL.FDB" }).
function partesDeUnc(unc) {
    const s = String(unc || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
    const m = /^\\\\([A-Za-z0-9][\w.\-]*)\\([^\\\x00-\x1f"<>|*?:]+)((?:\\[^\\\x00-\x1f"<>|*?:]+)*)$/.exec(s);
    if (!m) return null;
    return { host: m[1], compart: m[2], resto: m[3] || "" };
}

/**
 * Puro: caminhos prováveis, NO DISCO DO SERVIDOR, de um SMALL.FDB achado num
 * compartilhamento. O Windows não diz para que pasta o compartilhamento aponta,
 * então: primeiro a mesma estrutura deste computador (`estrutura`: pastas locais;
 * a que tiver uma pasta com o nome do compartilhamento dá o caminho — servidores
 * costumam repetir a instalação dos caixas), depois a pasta na raiz e em Program
 * Files, de C: a H: (o Firebird do servidor recusa um caminho errado em
 * milissegundos). Compartilhamento administrativo (\\SRV\C$\...) dá o caminho exato.
 */
function caminhosDoCompartilhamento(unc, qualquerFdb, estrutura) {
    const p = partesDeUnc(unc);
    if (!p || !(qualquerFdb ? /\.fdb$/i.test(p.resto) : ehArquivoSmall(p.resto))) return [];
    const lista = [];
    const vistos = new Set();
    const add = c => { const k = c.toUpperCase(); if (!vistos.has(k)) { vistos.add(k); lista.push(c); } };
    const adm = /^([A-Za-z])\$$/.exec(p.compart);
    if (adm) { add(adm[1].toUpperCase() + ":" + p.resto); return lista; }
    const pais = paisDoNome(p.compart, estrutura).concat(["", "\\Program Files (x86)", "\\Program Files"]);
    for (const u of ["C", "D", "E", "F", "G", "H"]) {
        for (const pai of pais) add(u + ":" + pai + "\\" + p.compart + p.resto);
        add(u + ":" + p.resto); // compartilhamento = raiz da unidade
    }
    return lista;
}

// Puro: pastas-mãe (sem a unidade) onde há uma pasta chamada `nome` nas pastas
// locais de `estrutura` ("C:\\A\\B\\Loja\\Dados" e "Loja" → "\\A\\B").
function paisDoNome(nome, estrutura) {
    const out = [];
    const alvo = String(nome || "").toLowerCase();
    if (!alvo) return out;
    for (const e of (Array.isArray(estrutura) ? estrutura : [])) {
        const m = /^[A-Za-z]:((?:\\[^\\]+)*)$/.exec(String(e || "").trim().replace(/\//g, "\\").replace(/\\+$/, ""));
        if (!m) continue;
        const partes = m[1].split("\\").slice(1);
        for (let i = 0; i < partes.length; i++) {
            if (partes[i].toLowerCase() !== alvo) continue;
            const pai = partes.slice(0, i).map(x => "\\" + x).join("");
            if (out.every(x => x.toLowerCase() !== pai.toLowerCase())) out.push(pai);
        }
        if (out.length >= 6) break;
    }
    return out;
}

// Puro: caminhos UNC citados num atalho (.lnk) do sistema de gestão. O .lnk é
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
            if (pastas.length >= 20) break;
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

// Pura: o banco configurado foi adotado pela busca automática e é suspeito — fora
// da meta (desta máquina com a meta "rede", ou da rede com a meta "local") ou um
// arquivo que não é SMALL.FDB. Nesse caso a busca roda de novo em segundo plano.
function bancoAutoSuspeito(conf, ehLocal) {
    if (!conf || conf.fbHostAuto !== true || conf.fbHostFixo === true) return false;
    const local = typeof ehLocal === "function" ? ehLocal(conf.fbHost)
        : /^(127\.0\.0\.1|localhost|::1)?$/i.test(String(conf.fbHost || "").trim());
    const foraDaMeta = conf.metaBusca === "local" ? !local : local;
    return foraDaMeta || !ehArquivoSmall(conf.fdbPath != null ? conf.fdbPath : conf.fbPath);
}

// Puro: nomes dos compartilhamentos de disco na saída do "net view \\SERVIDOR /all"
// (Windows em português, inglês, espanhol...). IPC$, ADMIN$ e print$ ficam de fora.
function extrairCompartilhamentos(texto) {
    const linhas = String(texto || "").split(/\r?\n/);
    const ini = linhas.findIndex(l => /^-{8,}\s*$/.test(l.trim()));
    if (ini < 0) return [];
    const out = [];
    for (const l of linhas.slice(ini + 1)) {
        if (!l.trim()) break;
        const m = /^(.+?)\s{2,}(Disk|Disco|Disque|Datentr\S*)\b/i.exec(l);
        if (!m) continue;
        const nome = m[1].trim();
        if (!nome || /^(ipc|admin|print)\$$/i.test(nome) || /[\\/:*?"<>|]/.test(nome)) continue;
        if (out.indexOf(nome) < 0) out.push(nome);
    }
    return out;
}

/** Compartilhamentos de disco de um servidor ("net view", com prazo). Só no Windows. */
function compartilhamentosDe(host, prazoMs) {
    return new Promise(resolve => {
        const h = String(host || "").trim();
        if (process.platform !== "win32" || !/^[A-Za-z0-9][\w.\-]*$/.test(h)) { resolve([]); return; }
        try {
            execFile("net", ["view", "\\\\" + h, "/all"], { windowsHide: true, timeout: prazoMs || 8000, encoding: "latin1", maxBuffer: 1024 * 1024 },
                (err, stdout) => resolve(extrairCompartilhamentos(stdout).map(n => "\\\\" + h + "\\" + n)));
        } catch (_) { resolve([]); }
    });
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

// Unidades de rede mapeadas: [{ letra: "H:", unc: "\\SERVIDOR\Sistema" }].
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

// Atalhos (.lnk) da Área de Trabalho e do Menu Iniciar que apontam para uma
// pasta compartilhada da rede (o sistema de gestão costuma rodar de lá).
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
 * estrutura dos caixas), todos esses em outras unidades (C: a H:) e os
 * genéricos (\\SMALL.FDB, \\Dados, \\Banco). Só caminhos de SMALL.FDB.
 */
function caminhosConhecidos(configurado, extras) {
    const unidades = ["C", "D", "E", "F", "G", "H"];
    const sufixos = ["\\SMALL.FDB", "\\Dados\\SMALL.FDB", "\\Banco\\SMALL.FDB"];
    const lista = [configurado];
    const base = [configurado];
    for (const e of (extras || [])) { lista.push(e); base.push(e); }
    for (const e of base) {
        const m = /^[A-Za-z]:(\\.+)$/.exec(String(e || "").trim());
        if (m) for (const u of unidades) lista.push(u + ":" + m[1]);
    }
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

/** Ordem de preferência entre .FDB locais: SMALL.FDB, depois o mais recente. */
function compararLocais(a, b) {
    const nome = x => x.nome || path.posix.basename(String(x.caminho || "").replace(/\\/g, "/"));
    const sa = /^small\.fdb$/i.test(nome(a)) ? 0 : 1;
    const sb = /^small\.fdb$/i.test(nome(b)) ? 0 : 1;
    if (sa !== sb) return sa - sb;
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
 * Pastas com "dados", "banco", "fdb" ou "sistema" no nome são visitadas primeiro.
 * Anota em `opcoes.pastasIni` as pastas de programa (com .ini/.cfg e um .exe ou
 * .fdb) — onde o sistema de gestão guarda a configuração.
 */
async function buscarFdbLocais(raizes, opcoes) {
    const o = opcoes || {};
    const maxProf = o.maxProf != null ? o.maxProf : 10;
    const maxArq = o.maxArquivos || 15;
    const prazo = Date.now() + (o.prazoMs || 60000);
    // Outros .FDB (não SMALL.FDB) achados no caminho, para o usuário escolher se faltar o SMALL.FDB.
    const outros = Array.isArray(o.outros) ? o.outros : null;
    const pastasIni = Array.isArray(o.pastasIni) ? o.pastasIni : null;
    const achados = [];
    const fila = (raizes || []).map(r => ({ dir: r, prof: 0 }));
    const prioritaria = nome => /dados|banco|fdb|sistema|database/i.test(nome);
    while (fila.length && achados.length < maxArq && Date.now() < prazo) {
        const { dir, prof } = fila.shift();
        let ents;
        try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
        const subPrio = [], subNormal = [];
        let temIni = false, temPrograma = false;
        for (const e of ents) {
            const nome = e.name;
            const caminho = path.join(dir, nome);
            if (e.isFile() && /\.(exe|fdb)$/i.test(nome)) temPrograma = true;
            if (e.isFile() && /\.fdb$/i.test(nome)) {
                if (FDB_IGNORADOS.test(nome)) continue;
                if (!ehArquivoSmall(nome)) { if (outros && outros.length < 40 && outros.indexOf(caminho) < 0) outros.push(caminho); continue; }
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
        if (pastasIni && temIni && temPrograma && pastasIni.length < 200 && pastasIni.indexOf(dir) === -1) pastasIni.push(dir);
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
 *           maxArquivos, prazoMs, prazoPastaMs, outros (lista que recebe os
 *           outros .FDB), lerPasta (testes) }
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
    const outros = Array.isArray(o.outros) ? o.outros : null;
    const statusHost = new Map();
    const achados = [];
    const vistos = new Set();
    const fila = [];
    for (const p of (pastas || [])) {
        const s = String(p || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
        if (partesDeUnc(s)) fila.push({ dir: s, prof: 0 });
    }
    const prioritaria = nome => /dados|banco|fdb|sistema|database/i.test(nome);
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
                if (FDB_IGNORADOS.test(nome)) continue;
                if (!ehArquivoSmall(nome)) { if (outros && outros.length < 40 && outros.every(a => a.toUpperCase() !== caminho.toUpperCase())) outros.push(caminho); continue; }
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

/** Lê os .ini/.cfg das pastas informadas (pastas de programa achadas, unidades e compartilhamentos). */
async function lerConfiguracoesSistema(pastasExtras, log, hostDaPasta) {
    const pastas = [];
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
                if ((r.bancos.length || r.hosts.length) && log) log("Configuração do sistema lida em " + arq);
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
 * usuário ou o achado antes): o anterior, o achado nas pastas compartilhadas
 * dele e os genéricos de C: a H:.
 * dep: { host, cfg, validar, portaAberta, log, extras, estrutura, compartilhamentos,
 *        buscarRede }. Não troca o servidor.
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
    // Pastas compartilhadas DESSE servidor (listadas por ele): o SMALL.FDB achado lá vira o caminho no disco dele.
    let doCompart = [];
    try {
        const smbOk = await comPrazo(Promise.resolve().then(() => d.portaAberta(host, 445, 1500)), 3000, false);
        let pastas = [];
        if (smbOk) { try { pastas = await (d.compartilhamentos || compartilhamentosDe)(host, 8000); } catch (_) {} }
        if (Array.isArray(pastas) && pastas.length)
            doCompart = await (d.buscarRede || buscarFdbNaRede)(pastas, { log: d.log, prazoMs: 15000, hostAcessivel: async () => smbOk === true });
    } catch (_) {}
    const extras = [];
    (Array.isArray(doCompart) ? doCompart : []).forEach(u => caminhosDoCompartilhamento(u, false, d.estrutura).forEach(c => extras.push(c)));
    (Array.isArray(d.extras) ? d.extras : []).forEach(c => extras.push(c));
    const combos = caminhosConhecidos(cfg.fdbPath, extras).map(c => ({ host, caminho: c }));
    const r = await primeiraQueAbre(combos, d.validar, 60000);
    if (r.combo) return { achado: r.combo, falhas: r.falhas, mensagem: "SMALL.FDB encontrado em " + host + ":" + r.combo.caminho + "." };
    const auth = r.falhas.find(f => f.auth);
    return {
        achado: null, falhas: r.falhas,
        mensagem: auth ? "O servidor " + host + " recusou o usuário/senha do Firebird. Ajuste em Configurações → Banco de dados."
            : "O SMALL.FDB não foi encontrado nas pastas compartilhadas nem nos caminhos mais comuns do servidor " + host + ". Informe o caminho em Configurações → Banco de dados."
    };
}

// Puro: os outros .FDB achados (não SMALL.FDB), sem repetição, prontos para validarOutros.
function montarOutros(fontes, daMaquina) {
    const f = fontes || {};
    const ehDaqui = typeof daMaquina === "function" ? daMaquina : ehLocal;
    const lista = [];
    const vistos = new Set();
    const add = (item, chave) => {
        const k = String(chave).toUpperCase();
        if (vistos.has(k) || lista.length >= 40) return;
        vistos.add(k);
        lista.push(item);
    };
    for (const b of (f.ini || [])) {
        const nome = String(b.caminho || "").split("\\").pop();
        if (!/\.fdb$/i.test(nome) || ehArquivoSmall(b.caminho) || FDB_IGNORADOS.test(nome)) continue;
        let host = "127.0.0.1";
        if (b.host && !ehDaqui(b.host)) host = b.host;
        else if (!b.host && b.origemHost && !ehDaqui(b.origemHost)) host = b.origemHost;
        add({ origem: "config", host, caminhos: [b.caminho], exibir: host + ":" + b.caminho }, host + "|" + b.caminho);
    }
    for (const unc of (f.rede || [])) {
        const host = hostDeUnc(unc);
        if (!host || ehDaqui(host)) continue;
        const caminhos = caminhosDoCompartilhamento(unc, true, f.estrutura);
        if (caminhos.length) add({ origem: "rede", host, caminhos, exibir: unc }, unc);
    }
    for (const c of (f.disco || [])) add({ origem: "disco", host: "127.0.0.1", caminhos: [c], exibir: c + " (este computador)" }, "127.0.0.1|" + c);
    return lista;
}

/**
 * Abre cada um dos outros .FDB (pelo Firebird do servidor dono dele, em somente
 * leitura, pelo `validar` de quem chama) para o usuário escolher.
 * dep: { outros, validar(h, c), portaAberta(h, porta, ms), porta, prazoMs }
 * Resolve [{ exibir, origem, host, caminho, ok, motivo }].
 */
async function validarOutros(dep) {
    const d = dep || {};
    const porta = Number(d.porta) || 3050;
    const limite = Date.now() + (d.prazoMs || 120000);
    const portas = new Map();
    const portaOk = async h => {
        const k = String(h).toLowerCase();
        if (!portas.has(k)) { let ok = false; try { ok = await d.portaAberta(h, porta, 1500); } catch (_) {} portas.set(k, ok); }
        return portas.get(k);
    };
    const out = [];
    for (const o of (Array.isArray(d.outros) ? d.outros : [])) {
        const base = { exibir: o.exibir, origem: o.origem, host: o.host, caminho: (o.caminhos || [])[0] || "" };
        if (Date.now() > limite) { out.push(Object.assign(base, { ok: false, motivo: "não testado (tempo esgotado)" })); continue; }
        if (!(await portaOk(o.host))) {
            out.push(Object.assign(base, { ok: false, motivo: o.host === "127.0.0.1" ? "este computador não tem o Firebird ligado" : "o Firebird de " + o.host + " não respondeu" }));
            continue;
        }
        const r = await primeiraQueAbre((o.caminhos || []).map(c => ({ host: o.host, caminho: c })), d.validar, Math.max(1000, limite - Date.now()));
        if (r.combo) { out.push(Object.assign(base, { caminho: r.combo.caminho, ok: true, motivo: "" })); continue; }
        // Mostra o motivo mais útil (abriu sem a tabela > senha > não achou).
        const f = r.falhas.find(x => /tabela/i.test(x.motivo)) || r.falhas.find(x => x.auth) || r.falhas[0];
        out.push(Object.assign(base, { ok: false, motivo: f ? (f.auth ? "usuário/senha do Firebird recusados" : /tabela/i.test(f.motivo) ? "abre, mas não tem a tabela de produtos" : "não abriu pelo Firebird") : "não abriu pelo Firebird" }));
    }
    return out;
}

// ── Orquestração ─────────────────────────────────────────────────────────────
/**
 * Procura o banco. dep:
 *   cfg            configuração atual (fbHost, fbPorta, fdbPath, varrerRede, metaBusca)
 *   validar(h, c)  → Promise<{ ok, auth, inacessivel, motivo }> (abre em somente leitura)
 *   portaAberta(h, porta, ms) → Promise<bool>
 *   log(msg)
 *   interfaces     (opcional) os.networkInterfaces()
 *   identidades    (opcional) Set com IPs/nomes desta máquina, em minúsculas
 *   raizesDisco    (opcional) raízes para a busca em disco (padrão: unidades seguras)
 *   buscarDisco    (opcional) substitui buscarFdbLocais (testes)
 *   lerIni         (opcional) substitui lerConfiguracoesSistema (testes)
 *   unidadesRede   (opcional) substitui unidadesDeRede (testes)
 *   atalhos        (opcional) substitui pistasDeAtalhos (testes)
 *   buscarRede     (opcional) substitui buscarFdbNaRede (testes)
 *   compartilhamentos (opcional) substitui compartilhamentosDe (testes)
 *   cancelado()    (opcional) → true interrompe entre as etapas
 * Resolve { achado: {host, caminho} | null, falhas, mensagem, outros, meta }.
 */
async function localizar(dep) {
    const d = dep || {};
    const cfg = d.cfg || {};
    const log = typeof d.log === "function" ? d.log : () => {};
    const porta = Number(cfg.fbPorta) || 3050;
    const meta = cfg.metaBusca === "local" ? "local" : "rede";
    const cancelado = typeof d.cancelado === "function" ? d.cancelado : () => false;
    const portaAberta = d.portaAberta;
    const hostAtual = String(cfg.fbHost || "").trim();
    const ifaces = d.interfaces || os.networkInterfaces();
    const proprios = d.identidades || identidadesDestaMaquina();
    ipsLocais(ifaces).forEach(ip => proprios.add(ip));
    const daMaquina = h => ehLocal(h) || proprios.has(String(h || "").trim().toLowerCase());
    const smb = h => comPrazo(Promise.resolve().then(() => portaAberta(h, 445, 1500)), 3000, false);

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

    log("Meta da busca: " + (meta === "local" ? "este computador primeiro, depois a rede" : "a rede primeiro, este computador por último") + " — varrendo o disco, as pastas compartilhadas e a rede.");
    let localAtivo = false;
    try { localAtivo = await portaAberta("127.0.0.1", porta, 800); } catch (_) {}

    // Pistas da rede: unidades mapeadas e atalhos do sistema de gestão.
    let unidRede = [];
    try { unidRede = await (d.unidadesRede || unidadesDeRede)(); } catch (_) {}
    let atalhos = { hosts: [], pastas: [] };
    try { atalhos = await (d.atalhos || pistasDeAtalhos)(); } catch (_) {}
    if (!atalhos || !Array.isArray(atalhos.hosts) || !Array.isArray(atalhos.pastas)) atalhos = { hosts: [], pastas: [] };
    if (!Array.isArray(unidRede)) unidRede = [];
    const hostsRede = [];
    const addHostRede = h => { if (h && !daMaquina(h) && !hostsRede.some(x => x.toLowerCase() === String(h).toLowerCase())) hostsRede.push(String(h)); };
    unidRede.forEach(u => addHostRede(hostDeUnc(u.unc)));
    atalhos.hosts.forEach(addHostRede);
    if (unidRede.length) log("Unidades de rede: " + unidRede.map(u => u.letra + " = " + u.unc).join(" | "));
    if (atalhos.pastas.length) log("Atalhos do sistema apontam para: " + atalhos.pastas.join(" | "));
    const pastasRede = [];
    unidRede.forEach(u => { pastasRede.push(u.letra + "\\"); if (u.unc) pastasRede.push(u.unc); });
    atalhos.pastas.forEach(p => pastasRede.push(p));
    // Pastas compartilhadas listadas pelos servidores das pistas (e pelo "SERVIDOR"): o .ini costuma estar lá.
    const compartLidos = new Map();
    const compartDe = async h => {
        const k = String(h).toLowerCase();
        if (!compartLidos.has(k)) {
            let lista = [];
            if (await smb(h)) { try { lista = await (d.compartilhamentos || compartilhamentosDe)(h, 8000); } catch (_) {} }
            compartLidos.set(k, Array.isArray(lista) ? lista : []);
            if (compartLidos.get(k).length) log("Pastas compartilhadas de " + h + ": " + compartLidos.get(k).join(" | "));
        }
        return compartLidos.get(k);
    };
    for (const h of hostsRede.concat(["SERVIDOR"]).slice(0, 6)) {
        if (cancelado()) break;
        (await compartDe(h)).forEach(p => pastasRede.push(p));
    }
    const hostDaPasta = p => {
        const s = String(p || "");
        if (s.startsWith("\\\\")) return hostDeUnc(s);
        const u = unidRede.find(x => s.toUpperCase().startsWith(x.letra));
        return u ? hostDeUnc(u.unc) : null;
    };

    // Disco desta máquina (uma vez, a fundo): SMALL.FDB, outros .FDB e pastas de programa com .ini.
    const pastasIni = [];
    const outrosDisco = [];
    let noDisco = [];
    try {
        log("Varrendo o disco deste computador...");
        const raizes = d.raizesDisco || await unidadesSeguras(log);
        noDisco = await (d.buscarDisco || buscarFdbLocais)(raizes, { pastasIni, outros: outrosDisco });
        if (!Array.isArray(noDisco)) noDisco = [];
    } catch (_) {}
    if (noDisco.length) log("SMALL.FDB neste computador: " + noDisco.map(x => x.caminho).join(" | "));

    // Configuração do sistema de gestão.
    let ini = { bancos: [], hosts: [] };
    try { ini = await (d.lerIni || lerConfiguracoesSistema)(pastasIni.concat(pastasRede), log, hostDaPasta); } catch (_) {}
    if (!ini || !Array.isArray(ini.bancos) || !Array.isArray(ini.hosts)) ini = { bancos: [], hosts: [] };
    ini.hosts.forEach(addHostRede);

    const extras = ini.bancos.map(b => b.caminho).concat(noDisco.map(x => x.caminho));
    const caminhos = caminhosConhecidos(cfg.fdbPath, extras);
    // Estrutura de pastas deste computador: diz onde fica, no servidor, a pasta de um compartilhamento.
    const estrutura = noDisco.map(x => path.win32.dirname(x.caminho)).concat(pastasIni, ini.bancos.map(b => path.win32.dirname(b.caminho)));

    // Este computador (primeiro com a meta "local", por último com a meta "rede").
    const etapaLocal = async () => {
        if (achado || cancelado()) return;
        if (!localAtivo) { if (noDisco.length) log("Há SMALL.FDB neste computador, mas o Firebird daqui não está ligado — ele não pode ser aberto."); return; }
        const combos = [];
        for (const b of ini.bancos) if (!b.host || daMaquina(b.host)) adicionar(combos, "127.0.0.1", b.caminho);
        for (const x of noDisco) adicionar(combos, "127.0.0.1", x.caminho);
        for (const c of caminhos) adicionar(combos, "127.0.0.1", c);
        if (combos.length) {
            log(meta === "local" ? "Testando o SMALL.FDB deste computador (meta escolhida)..." : "Nenhum servidor da rede tem o banco — última opção: o SMALL.FDB deste computador...");
            await tentar(combos, 90000);
        }
    };
    if (meta === "local") await etapaLocal();

    // (1) Configuração do sistema de gestão apontando para um servidor.
    if (!achado && !cancelado()) {
        const combos = [];
        for (const b of ini.bancos) {
            if (b.host && !daMaquina(b.host)) { adicionar(combos, b.host, b.caminho); continue; }
            if (b.host) continue; // aponta para esta máquina: fica para a etapa local
            // Caminho sem servidor num .ini lido do compartilhamento de um servidor = disco DELE.
            if (b.origemHost && !daMaquina(b.origemHost)) adicionar(combos, b.origemHost, b.caminho);
            for (const h of hostsRede) adicionar(combos, h, b.caminho);
        }
        if (combos.length) {
            log("Testando o banco indicado pela configuração do sistema...");
            await tentar(combos, 90000);
        }
    }

    // (2) Servidores da rede: pistas, configurado, "SERVIDOR" e a varredura.
    const hosts = [];
    const addHost = h => { if (h && !daMaquina(h) && !hosts.some(x => x.toLowerCase() === String(h).trim().toLowerCase())) hosts.push(String(h).trim()); };
    hostsRede.forEach(addHost);
    addHost(hostAtual);
    addHost("SERVIDOR");
    if (!achado && !cancelado() && cfg.varrerRede !== false) {
        for (const base of classificarRedes(ifaces).slice(0, 4)) {
            if (cancelado()) break;
            (await escanearSubnet(portaAberta, porta, base, 10, log)).forEach(addHost);
        }
    }

    // (3) SMALL.FDB nas pastas compartilhadas de todos esses servidores.
    const outrosRede = [];
    if (!achado && !cancelado()) {
        const pastasFdb = [];
        atalhos.pastas.forEach(p => pastasFdb.push(p));
        unidRede.forEach(u => { if (u.unc) pastasFdb.push(u.unc); });
        // Compartilhamentos listados pelo próprio servidor (só os que respondem na porta 445).
        for (const h of hosts.slice(0, 12)) {
            if (cancelado()) break;
            (await compartDe(h)).forEach(p => pastasFdb.push(p));
        }
        let naRede = [];
        try {
            log("Procurando o SMALL.FDB nas pastas compartilhadas da rede...");
            naRede = await (d.buscarRede || buscarFdbNaRede)(pastasFdb, { log, hostAcessivel: smb, outros: outrosRede, prazoMs: 45000, maxPastas: 400 });
        } catch (_) {}
        const combos = [];
        for (const unc of (Array.isArray(naRede) ? naRede : [])) {
            const h = hostDeUnc(unc);
            if (!h || daMaquina(h)) continue;
            addHost(h);
            for (const c of caminhosDoCompartilhamento(unc, false, estrutura)) adicionar(combos, h, c);
        }
        if (combos.length) {
            log("Testando, pelo Firebird do servidor, o SMALL.FDB achado na pasta compartilhada...");
            await tentar(combos, 90000);
        }
    }

    // (4) Em cada servidor: os caminhos das pistas e os genéricos.
    if (!achado && !cancelado()) {
        const combos = [];
        for (const h of hosts) for (const c of caminhos) adicionar(combos, h, c);
        if (combos.length) {
            log("Testando o banco nos servidores da rede: " + hosts.join(", ") + "...");
            await tentar(combos, 240000);
        }
    }

    // (5) Este computador, por último (meta "rede").
    if (meta === "rede") await etapaLocal();

    if (achado) return { achado, falhas, meta, outros: [], mensagem: "Banco encontrado em " + achado.host + ":" + achado.caminho + (daMaquina(achado.host) ? " (neste computador)." : ".") };
    const outros = cancelado() ? [] : montarOutros({ ini: ini.bancos, rede: outrosRede, disco: outrosDisco, estrutura }, daMaquina);
    if (outros.length) log("Outros arquivos .FDB encontrados (não se chamam SMALL.FDB): " + outros.map(o => o.exibir).join(" | "));
    const comAuth = falhas.find(f => f.auth);
    let mensagem;
    if (comAuth) mensagem = "O banco foi encontrado em " + comAuth.host + " (" + comAuth.caminho + "), mas o usuário/senha do Firebird não conferem. Ajuste em Configurações → Banco de dados.";
    else if (hostAtual && !daMaquina(hostAtual) && falhas.some(f => f.host === hostAtual && f.inacessivel))
        mensagem = "O servidor " + hostAtual + " não respondeu na porta " + porta + " e o SMALL.FDB não foi encontrado em outro servidor da rede nem neste computador. Verifique se o servidor do banco está ligado e acessível (mesma rede, cabo ou VPN).";
    else mensagem = "O SMALL.FDB não foi encontrado em lugar nenhum: o disco deste computador, as pastas compartilhadas e a rede inteira foram varridos." +
        (outros.length ? " Foram achados " + outros.length + " outro(s) arquivo(s) .FDB — veja se algum é o banco." : " Verifique se o servidor está ligado e acessível, ou informe o endereço em Configurações → Banco de dados.");
    return { achado: null, falhas, meta, outros, mensagem };
}

module.exports = {
    VERSAO, classificarRedes, ipsLocais, caminhosConhecidos, extrairBancosDeIni, compararLocais, primeiraQueAbre,
    unidadesSeguras, buscarFdbLocais, lerConfiguracoesSistema, escanearSubnet, localizar, ehLocal, FDB_IGNORADOS,
    caminhoNoServidor, ehArquivoSmall, hostDeUnc, partesDeUnc, caminhosDoCompartilhamento, paisDoNome, buscarFdbNaRede,
    extrairCompartilhamentos, compartilhamentosDe, montarOutros, validarOutros, extrairUncDeAtalho, identidadesDestaMaquina, bancoAutoSuspeito, comPrazo, unidadesDeRede, pistasDeAtalhos
};
