"use strict";
/**
 * main.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Processo principal do Consulta Estoque (Electron): janela,
 *              instância única, pasta de dados, ponte com a tela (IPC) e o
 *              motor do estoque.
 *
 * Opções de linha de comando:
 *   --demo        abre com produtos de exemplo (sem banco), para conhecer a tela;
 *   --sem-gpu     desliga a aceleração gráfica (PCs antigos com tela preta/piscando).
 * Variável CONSULTA_DESKTOP_DADOS: troca a pasta de dados (config, log, cache).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Config = require("./src/config.js");
const { criarRegistro } = require("./src/registro.js");
const { criarMotor } = require("./src/motor.js");
const FB = require("./src/firebird.js");
const pacote = require("./package.json");

const VERSAO = pacote.version;
const VARIANTE = pacote.variante || "desenvolvimento";
const DEMO = process.argv.includes("--demo") || process.env.CONSULTA_DEMO === "1";

// ── Pasta de dados ───────────────────────────────────────────────────────────
// Versão portátil: os dados ficam ao lado do .exe (se der para gravar lá).
function escolherPastaDados() {
    if (process.env.CONSULTA_DESKTOP_DADOS) return path.resolve(process.env.CONSULTA_DESKTOP_DADOS);
    if (DEMO) return path.join(os.tmpdir(), "ConsultaEstoque-demo");
    const portatil = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portatil) {
        const p = path.join(portatil, "ConsultaEstoque-dados");
        try { fs.mkdirSync(p, { recursive: true }); fs.accessSync(p, fs.constants.W_OK); return p; } catch (_) {}
    }
    return app.getPath("userData");
}
const PASTA_DADOS = escolherPastaDados();
try { fs.mkdirSync(PASTA_DADOS, { recursive: true }); } catch (_) {}
// Preferências da tela (filtros etc.) na mesma pasta — a versão portátil leva tudo junto.
try { app.setPath("userData", PASTA_DADOS); } catch (_) {}
const ARQ_CONFIG = path.join(PASTA_DADOS, "config.json");
const ARQ_JANELA = path.join(PASTA_DADOS, "janela.json");
const reg = criarRegistro(PASTA_DADOS, { console: !app.isPackaged });

// Configuração lida ANTES do "ready" (aceleração gráfica só pode ser desligada aqui).
const lido = Config.carregar(ARQ_CONFIG);
if (lido.aviso) reg.aviso(lido.aviso);
if (process.argv.includes("--sem-gpu") || !lido.cfg.aceleracaoGrafica) {
    app.disableHardwareAcceleration();
}

process.on("uncaughtException", e => reg.erro("Erro inesperado: " + (e && e.stack || e)));
process.on("unhandledRejection", e => reg.erro("Promessa rejeitada sem tratamento: " + (e && e.stack || e)));

// ── Instância única ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let janela = null;
    let motor = null;
    let encerrando = false;

    const enviar = (canal, dado) => {
        if (janela && !janela.isDestroyed() && !janela.webContents.isDestroyed()) {
            try { janela.webContents.send(canal, dado); } catch (_) {}
        }
    };
    // Status agrupado (no máximo ~8 por segundo para a tela).
    let statusPendente = null, statusTimer = null;
    const enviarStatus = s => {
        statusPendente = s;
        if (statusTimer) return;
        statusTimer = setTimeout(() => { statusTimer = null; enviar("estoque:status", statusPendente); }, 120);
    };

    app.on("second-instance", () => {
        if (!janela) return;
        if (janela.isMinimized()) janela.restore();
        janela.show();
        janela.focus();
    });

    // ── Janela ───────────────────────────────────────────────────────────────
    const lerJanela = () => {
        try {
            const j = JSON.parse(fs.readFileSync(ARQ_JANELA, "utf8"));
            if (!(j.width >= 500 && j.height >= 400)) return null;
            // Só reaproveita a posição se ela ainda cair numa tela existente.
            const visivel = screen.getAllDisplays().some(d => {
                const a = d.workArea;
                return j.x + 100 > a.x && j.x < a.x + a.width - 100 && j.y >= a.y - 20 && j.y < a.y + a.height - 100;
            });
            return visivel ? j : { width: j.width, height: j.height, maximizado: j.maximizado };
        } catch (_) { return null; }
    };
    const salvarJanela = () => {
        if (!janela || janela.isDestroyed() || janela.isFullScreen()) return;
        try {
            const b = janela.getNormalBounds();
            Config.gravarAtomico(ARQ_JANELA, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximizado: janela.isMaximized() }));
        } catch (_) {}
    };

    const aplicarJanela = cfg => {
        if (!janela || janela.isDestroyed()) return;
        try { janela.setAlwaysOnTop(!!cfg.sempreNoTopo); } catch (_) {}
        try { if (janela.isFullScreen() !== !!cfg.telaCheia) janela.setFullScreen(!!cfg.telaCheia); } catch (_) {}
        try { janela.webContents.setZoomFactor(cfg.zoom || 1); } catch (_) {}
    };
    const aplicarInicioComWindows = cfg => {
        if (DEMO || process.platform !== "win32" || !app.isPackaged) return;
        try {
            const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
            app.setLoginItemSettings({ openAtLogin: !!cfg.iniciarComWindows, path: exe, args: [] });
        } catch (e) { reg.aviso("Não foi possível ajustar a inicialização com o Windows: " + e.message); }
    };

    function criarJanela() {
        const salvo = lerJanela() || {};
        const escuro = lido.cfg.tema === "escuro";
        janela = new BrowserWindow({
            width: salvo.width || 1180, height: salvo.height || 760,
            x: salvo.x, y: salvo.y,
            minWidth: 640, minHeight: 460,
            show: false,
            backgroundColor: escuro ? "#0f1419" : "#f4f6f8",
            title: "Consulta Estoque",
            autoHideMenuBar: true,
            icon: path.join(__dirname, "build", "icone.png"),
            webPreferences: {
                preload: path.join(__dirname, "preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                spellcheck: false,
                devTools: !app.isPackaged || process.argv.includes("--devtools")
            }
        });
        janela.setMenu(null);
        if (salvo.maximizado) janela.maximize();
        janela.once("ready-to-show", () => { janela.show(); aplicarJanela(motor ? motor.config() : lido.cfg); });
        // Nunca navega para fora da tela do aplicativo nem abre janelas novas.
        janela.webContents.on("will-navigate", e => e.preventDefault());
        janela.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: "deny" };
        });
        janela.webContents.on("render-process-gone", (_e, det) => {
            reg.erro("A tela parou (" + (det && det.reason) + ") — recarregando.");
            if (!encerrando) setTimeout(() => { try { janela.reload(); } catch (_) {} }, 1000);
        });
        janela.webContents.on("before-input-event", (e, input) => {
            if (input.type !== "keyDown") return;
            if (input.key === "F11") { e.preventDefault(); janela.setFullScreen(!janela.isFullScreen()); }
            if (input.key === "F12" && (!app.isPackaged || process.argv.includes("--devtools"))) janela.webContents.toggleDevTools();
        });
        janela.on("enter-full-screen", () => enviar("estoque:status", Object.assign(motor.status(), { telaCheia: true })));
        janela.on("leave-full-screen", () => enviar("estoque:status", Object.assign(motor.status(), { telaCheia: false })));
        let tSalvar = null;
        const agendarSalvar = () => { clearTimeout(tSalvar); tSalvar = setTimeout(salvarJanela, 800); };
        janela.on("resize", agendarSalvar);
        janela.on("move", agendarSalvar);
        janela.on("close", salvarJanela);
        janela.on("closed", () => { janela = null; });
        janela.loadFile(path.join(__dirname, "ui", "index.html")).catch(e => reg.erro("Falha ao abrir a tela: " + e.message));
    }

    // ── IPC (só aceita pedidos da própria tela) ──────────────────────────────
    const deTela = e => {
        try { return !!(e && e.senderFrame && /^file:\/\//i.test(e.senderFrame.url)); } catch (_) { return false; }
    };
    const tratar = (canal, f) => ipcMain.handle(canal, async (e, arg) => {
        if (!deTela(e)) throw new Error("origem não permitida");
        try { return await f(arg, e); }
        catch (err) { reg.erro("Falha em " + canal + ": " + (err && err.message || err)); return { ok: false, mensagem: String(err && err.message || err) }; }
    });

    function registrarIpc() {
        tratar("estoque:pesquisar", p => motor.pesquisar(p && typeof p === "object" ? p : {}));
        tratar("estoque:item", p => motor.item(p && typeof p === "object" ? p : {}));
        tratar("estoque:status", () => Object.assign(motor.status(), { telaCheia: !!(janela && janela.isFullScreen()) }));
        tratar("estoque:atualizar", () => motor.atualizarAgora());
        tratar("estoque:procurar", () => motor.procurarAgora());
        tratar("estoque:cancelar-copia", () => motor.cancelarCopia());
        tratar("estoque:csv", async p => {
            const r = motor.exportarCsv(p && typeof p === "object" ? p : {});
            if (!r) return { ok: false, mensagem: "Estoque ainda não carregado." };
            const d = new Date(), z = n => String(n).padStart(2, "0");
            const escolha = await dialog.showSaveDialog(janela, {
                title: "Exportar a lista",
                defaultPath: path.join(app.getPath("documents"), "estoque-" + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + ".csv"),
                filters: [{ name: "Planilha CSV", extensions: ["csv"] }]
            });
            if (escolha.canceled || !escolha.filePath) return { ok: false, cancelado: true };
            await fs.promises.writeFile(escolha.filePath, r.texto, "utf8");
            reg.info("Lista exportada: " + escolha.filePath + " (" + r.linhas + " itens).");
            return { ok: true, linhas: r.linhas, arquivo: escolha.filePath };
        });
        tratar("config:ler", () => motor.config());
        tratar("config:salvar", c => {
            const antes = motor.config();
            const cfg = motor.salvarConfig(c && typeof c === "object" ? c : {});
            aplicarJanela(cfg);
            if (antes.iniciarComWindows !== cfg.iniciarComWindows) aplicarInicioComWindows(cfg);
            return { ok: true, cfg, reiniciar: antes.aceleracaoGrafica !== cfg.aceleracaoGrafica };
        });
        tratar("app:log", () => reg.ultimas());
        tratar("app:info", () => ({
            versao: VERSAO, variante: VARIANTE, demo: DEMO,
            electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
            sistema: os.type() + " " + os.release() + " (" + process.arch + ")",
            pastaDados: PASTA_DADOS, arquivoLog: reg.arquivo
        }));
        tratar("app:abrir-pasta", () => shell.openPath(PASTA_DADOS));
        tratar("janela:tela-cheia", v => { if (janela) janela.setFullScreen(typeof v === "boolean" ? v : !janela.isFullScreen()); return janela ? janela.isFullScreen() : false; });
        tratar("janela:zoom", v => {
            const z = Config.validarValor("zoom", v);
            if (janela) janela.webContents.setZoomFactor(z);
            motor.salvarConfig({ zoom: z });
            return z;
        });
        tratar("app:reiniciar", () => { app.relaunch(); app.exit(0); });
    }

    // ── Início ───────────────────────────────────────────────────────────────
    app.whenReady().then(async () => {
        reg.info("Consulta Estoque " + VERSAO + " (" + VARIANTE + ") iniciado — Electron " + process.versions.electron +
            ", " + os.type() + " " + os.release() + " " + process.arch + (DEMO ? " — MODO DEMONSTRAÇÃO" : "") + ". Dados em " + PASTA_DADOS);
        let dep = {};
        if (DEMO) {
            const demo = require("./src/demo.js");
            Config.salvar(ARQ_CONFIG, Config.mesclar(lido.cfg, { fbHost: "127.0.0.1", fdbPath: "DEMO", fbHostFixo: true, modo: lido.cfg.modo }));
            dep = {
                Firebird: FB.blindar(demo.criarFbFalso({ "127.0.0.1|DEMO": demo.bancoDemo() }), 2),
                localizarGbak: async () => "", portaAberta: async () => false
            };
        }
        motor = criarMotor(Object.assign({
            pastaDados: PASTA_DADOS, arquivoConfig: ARQ_CONFIG, log: reg,
            aoStatus: enviarStatus,
            aoDadosNovos: info => enviar("estoque:dados-novos", info)
        }, dep));
        reg.aoEscrever(linha => enviar("app:log-linha", linha));
        registrarIpc();
        criarJanela();
        aplicarInicioComWindows(motor.config());
        await motor.iniciar();
    }).catch(e => {
        reg.erro("Falha ao iniciar: " + (e && e.stack || e));
        dialog.showErrorBox("Consulta Estoque", "Falha ao iniciar: " + (e && e.message || e));
        app.exit(1);
    });

    app.on("window-all-closed", () => app.quit());
    app.on("before-quit", () => {
        encerrando = true;
        try { if (motor) motor.encerrar(); } catch (_) {}
        reg.info("Consulta Estoque encerrado.");
    });
}
