"use strict";
/**
 * main.js
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Processo principal do Consulta Estoque (Electron): janela em
 *              modo quiosque, senha do administrador, módulo de persistência
 *              (vigia), opções do Windows, pasta de dados, ponte com a tela
 *              (IPC) e o motor do estoque.
 *
 * Opções de linha de comando:
 *   --demo        abre com produtos de exemplo (sem banco), para conhecer a tela;
 *   --sem-gpu     desliga a aceleração gráfica (PCs antigos com tela preta/piscando).
 * Variáveis de ambiente:
 *   CONSULTA_DESKTOP_DADOS   troca a pasta de dados (config, log, cache);
 *   CONSULTA_SEM_QUIOSQUE=1  janela comum (desenvolvimento e testes automáticos).
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — Modo quiosque permanente (tela cheia que não sai, sem botão de tela
 *           cheia, Alt+F4 e fechar ignorados), senha do administrador (protege as
 *           configurações sensíveis, a saída, a exportação e a pasta de dados;
 *           tentativas erradas com espera crescente), saída com Ctrl+Shift+Q ou
 *           pelo botão "Sair do aplicativo", modo manutenção temporário, módulo de
 *           persistência (vigia que reabre o aplicativo fechado sem a senha) e
 *           opções do Windows: iniciar com o Windows, sempre acima, manter em
 *           foco, impedir descanso de tela, ocultar da barra de tarefas, reinício
 *           diário e monitor. Desligar/reiniciar o Windows nunca é bloqueado.
 *           Abertura segura: se a abertura anterior caiu antes de mostrar a tela
 *           (placa de vídeo/driver), esta abre sem aceleração gráfica.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerSaveBlocker } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const Config = require("./src/config.js");
const { criarRegistro } = require("./src/registro.js");
const { criarMotor } = require("./src/motor.js");
const FB = require("./src/firebird.js");
const pacote = require("./package.json");

const VERSAO = pacote.version;
const VARIANTE = pacote.variante || "desenvolvimento";
const DEMO = process.argv.includes("--demo") || process.env.CONSULTA_DEMO === "1";
const QUIOSQUE = process.env.CONSULTA_SEM_QUIOSQUE !== "1";
// Vigia e "iniciar com o Windows" só no aplicativo instalado/portátil de verdade.
const PODE_PERSISTIR = app.isPackaged && !DEMO && process.platform === "win32";
const EXE_APP = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const DESBLOQUEIO_MS = 5 * 60000;

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
const ARQ = {
    appPid: path.join(PASTA_DADOS, "app.pid"),
    vigiaPid: path.join(PASTA_DADOS, "vigia.pid"),
    saida: path.join(PASTA_DADOS, "saida-autorizada"),
    vigia: path.join(PASTA_DADOS, "vigia.js")
};
const reg = criarRegistro(PASTA_DADOS, { console: !app.isPackaged });

// Configuração lida ANTES do "ready" (aceleração gráfica só pode ser desligada aqui).
const lido = Config.carregar(ARQ_CONFIG);
if (lido.aviso) reg.aviso(lido.aviso);

// Abertura segura: "partida-pendente" é criado ao abrir e apagado quando a tela
// aparece. Se ele ainda existe, a abertura anterior caiu antes de mostrar a tela
// (típico de placa de vídeo/driver antigo: "GPU process isn't usable") — esta
// abertura vem sem aceleração gráfica. Só a instância principal mexe no arquivo.
const ARQ_PARTIDA = path.join(PASTA_DADOS, "partida-pendente");
const INSTANCIA_PRINCIPAL = app.requestSingleInstanceLock();
let partidaAnteriorFalhou = false;
if (INSTANCIA_PRINCIPAL) {
    partidaAnteriorFalhou = fs.existsSync(ARQ_PARTIDA);
    try { fs.writeFileSync(ARQ_PARTIDA, String(Date.now())); } catch (_) {}
}
const SEM_GPU = process.argv.includes("--sem-gpu") || !lido.cfg.aceleracaoGrafica || partidaAnteriorFalhou;
if (SEM_GPU) app.disableHardwareAcceleration();
if (partidaAnteriorFalhou) reg.aviso("A abertura anterior não chegou a mostrar a tela (falha da placa de vídeo?) — abrindo sem aceleração gráfica.");
const partidaConcluida = () => { try { fs.unlinkSync(ARQ_PARTIDA); } catch (_) {} };

process.on("uncaughtException", e => reg.erro("Erro inesperado: " + (e && e.stack || e)));
process.on("unhandledRejection", e => reg.erro("Promessa rejeitada sem tratamento: " + (e && e.stack || e)));

// ── Instância única ──────────────────────────────────────────────────────────
if (!INSTANCIA_PRINCIPAL) {
    app.quit();
} else {
    let janela = null;
    let motor = null;
    let encerrando = false;
    let saidaAutorizada = false;      // fechar só com a senha (ou desligando o Windows)
    let manutencao = false;           // quiosque suspenso temporariamente pelo administrador
    let desbloqueadoAte = 0;
    let errosSenha = 0;
    let esperaSenhaAte = 0;
    let bloqueadorDescanso = null;
    let ultimoReinicioDiario = "";
    let dialogoAberto = false;        // janela do Windows (salvar arquivo) aberta: não roubar o foco

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

    app.on("child-process-gone", (_e, d) => {
        if (d && d.type === "GPU") reg.aviso("O processo de vídeo (GPU) caiu (" + d.reason + ", código " + d.exitCode + "). Se a tela ficar preta ou o aplicativo fechar, desmarque Aceleração gráfica.");
    });

    app.on("second-instance", () => {
        if (!janela) return;
        if (janela.isMinimized()) janela.restore();
        janela.show();
        janela.focus();
    });

    // ── Administrador ────────────────────────────────────────────────────────
    const temSenha = () => !!(motor && motor.config().senhaAdmin);
    // Sem senha definida (primeira execução) tudo fica liberado até ela ser criada.
    const desbloqueado = () => !temSenha() || Date.now() < desbloqueadoAte;
    const renovar = () => { if (temSenha() && Date.now() < desbloqueadoAte) desbloqueadoAte = Date.now() + DESBLOQUEIO_MS; };
    const exigirAdmin = () => {
        if (!desbloqueado()) { const e = new Error("Esta ação exige a senha do administrador."); e.precisaSenha = true; throw e; }
        renovar();
    };
    const estadoAdmin = () => ({ temSenha: temSenha(), desbloqueado: desbloqueado(), manutencao, quiosque: QUIOSQUE, podePersistir: PODE_PERSISTIR });

    async function conferirSenha(senha) {
        if (!temSenha()) return true;
        const espera = esperaSenhaAte - Date.now();
        if (espera > 0) return { espera: Math.ceil(espera / 1000) };
        const ok = Config.conferirSenha(String(senha == null ? "" : senha), motor.config().senhaAdmin);
        if (ok) { errosSenha = 0; return true; }
        errosSenha++;
        // Espera crescente: 1, 2, 4, 8... até 60 s (impede tentar senhas em sequência).
        esperaSenhaAte = Date.now() + Math.min(60000, 1000 * Math.pow(2, errosSenha - 1));
        reg.aviso("Senha do administrador incorreta (" + errosSenha + "ª tentativa seguida).");
        return false;
    }

    // ── Vigia (persistência) ─────────────────────────────────────────────────
    const pidVivo = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } };
    const lerPid = arq => { try { return parseInt(fs.readFileSync(arq, "utf8"), 10) || 0; } catch (_) { return 0; } };

    function garantirVigia(cfg) {
        if (!PODE_PERSISTIR || !cfg.persistente) return;
        try {
            if (pidVivo(lerPid(ARQ.vigiaPid))) return;
            try { fs.unlinkSync(ARQ.saida); } catch (_) {}
            // Cópia fora do pacote (app.asar): o vigia roda como Node puro.
            const fonte = fs.readFileSync(path.join(__dirname, "src", "vigia.js"));
            let atual = null;
            try { atual = fs.readFileSync(ARQ.vigia); } catch (_) {}
            if (!atual || !atual.equals(fonte)) fs.writeFileSync(ARQ.vigia, fonte);
            const filho = cp.spawn(process.execPath, [ARQ.vigia, "--dados", PASTA_DADOS, "--exe", EXE_APP, "--args", "[]"], {
                detached: true, stdio: "ignore", windowsHide: true,
                env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
            });
            filho.on("error", e => reg.erro("Falha ao iniciar o vigia: " + e.message));
            filho.unref();
            reg.info("Persistência ligada: vigia iniciado (reabre o aplicativo se for fechado sem a senha).");
        } catch (e) { reg.erro("Falha ao iniciar o vigia: " + e.message); }
    }

    /** Saída com a senha: avisa o vigia e encerra de verdade. */
    function sairAutorizado(motivo) {
        reg.info("Saída autorizada pelo administrador" + (motivo ? " (" + motivo + ")" : "") + ".");
        try { if (pidVivo(lerPid(ARQ.vigiaPid))) fs.writeFileSync(ARQ.saida, String(Date.now())); } catch (_) {}
        saidaAutorizada = true;
        setTimeout(() => app.quit(), 50);
    }

    /** Reinício (diário, aceleração gráfica): o vigia vê o novo PID e segue vigiando. */
    function reiniciarApp(motivo) {
        reg.info("Reiniciando o aplicativo (" + motivo + ").");
        saidaAutorizada = true;
        try { app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: EXE_APP, args: [] } : undefined); } catch (_) {}
        setTimeout(() => app.exit(0), 50);
    }

    // ── Opções do Windows e da janela ────────────────────────────────────────
    const aplicarInicioComWindows = cfg => {
        if (!PODE_PERSISTIR) return;
        try { app.setLoginItemSettings({ openAtLogin: !!cfg.iniciarComWindows, path: EXE_APP, args: [] }); }
        catch (e) { reg.aviso("Não foi possível ajustar a inicialização com o Windows: " + e.message); }
    };
    const aplicarDescanso = cfg => {
        const quer = !!cfg.impedirDescanso && !manutencao;
        try {
            if (quer && bloqueadorDescanso == null) bloqueadorDescanso = powerSaveBlocker.start("prevent-display-sleep");
            if (!quer && bloqueadorDescanso != null) { powerSaveBlocker.stop(bloqueadorDescanso); bloqueadorDescanso = null; }
        } catch (_) {}
    };
    const telaEscolhida = cfg => {
        const telas = screen.getAllDisplays();
        return telas[cfg.monitor] || screen.getPrimaryDisplay();
    };
    const aplicarJanela = cfg => {
        if (!janela || janela.isDestroyed()) return;
        const quiosque = QUIOSQUE && !manutencao;
        try { janela.setAlwaysOnTop(quiosque && !!cfg.sempreNoTopo, "screen-saver"); } catch (_) {}
        try { janela.setSkipTaskbar(quiosque && !!cfg.ocultarBarraTarefas); } catch (_) {}
        try {
            if (quiosque) {
                const b = telaEscolhida(cfg).bounds;
                const atual = janela.getBounds();
                if (atual.x < b.x || atual.x >= b.x + b.width || atual.y < b.y || atual.y >= b.y + b.height) janela.setBounds(b);
                if (!janela.isKiosk()) janela.setKiosk(true);
                if (!janela.isFullScreen()) janela.setFullScreen(true);
            } else if (janela.isKiosk()) {
                janela.setKiosk(false);
                janela.setFullScreen(false);
                const a = telaEscolhida(cfg).workArea;
                janela.setBounds({ x: a.x + 40, y: a.y + 40, width: Math.max(800, a.width - 80), height: Math.max(560, a.height - 80) });
            }
        } catch (_) {}
        try { janela.webContents.setZoomFactor(cfg.zoom || 1); } catch (_) {}
        aplicarDescanso(cfg);
    };

    function criarJanela() {
        const cfg = motor.config();
        const tela = telaEscolhida(cfg);
        const escuro = cfg.tema === "escuro";
        janela = new BrowserWindow({
            x: tela.bounds.x, y: tela.bounds.y,
            width: QUIOSQUE ? tela.bounds.width : 1180, height: QUIOSQUE ? tela.bounds.height : 760,
            minWidth: 640, minHeight: 460,
            show: false,
            fullscreen: QUIOSQUE,
            kiosk: QUIOSQUE,
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
        janela.once("ready-to-show", () => {
            janela.show(); janela.focus(); aplicarJanela(motor.config());
            // A tela apareceu e ficou de pé: a abertura deu certo.
            setTimeout(partidaConcluida, 8000);
        });
        // Nunca navega para fora da tela do aplicativo nem abre janelas novas.
        janela.webContents.on("will-navigate", e => e.preventDefault());
        janela.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        janela.webContents.on("render-process-gone", (_e, det) => {
            reg.erro("A tela parou (" + (det && det.reason) + ") — recarregando.");
            if (!encerrando) setTimeout(() => { try { janela.reload(); } catch (_) {} }, 1000);
        });
        janela.webContents.on("before-input-event", (e, input) => {
            if (input.type !== "keyDown") return;
            const k = String(input.key || "");
            // Tela cheia não sai pelo teclado; Ctrl+W/Ctrl+R não fecham nem recarregam.
            if (k === "F11" || ((input.control || input.meta) && /^[wr]$/i.test(k))) { e.preventDefault(); return; }
            if (input.alt && k === "F4") { e.preventDefault(); return; }
            // Ctrl+Shift+Q: pedido de saída (a tela pede a senha).
            if ((input.control || input.meta) && input.shift && /^q$/i.test(k)) { e.preventDefault(); enviar("admin:pedir-saida", null); return; }
            if (k === "F12" && (!app.isPackaged || process.argv.includes("--devtools"))) janela.webContents.toggleDevTools();
        });
        // Quiosque: fechar, minimizar e sair da tela cheia são desfeitos.
        janela.on("close", e => {
            if (saidaAutorizada || encerrando || !QUIOSQUE) return;
            e.preventDefault();
            reg.aviso("Tentativa de fechar a janela ignorada (use Sair do aplicativo, com a senha).");
            enviar("admin:pedir-saida", null);
        });
        janela.on("minimize", () => { if (QUIOSQUE && !manutencao) setTimeout(() => { try { janela.restore(); janela.focus(); } catch (_) {} }, 200); });
        janela.on("leave-full-screen", () => { if (QUIOSQUE && !manutencao) setTimeout(() => aplicarJanela(motor.config()), 200); });
        janela.on("blur", () => {
            const cfg = motor.config();
            if (!QUIOSQUE || manutencao || !cfg.manterFoco || dialogoAberto) return;
            setTimeout(() => {
                try { if (janela && !janela.isDestroyed() && !janela.isFocused() && !manutencao && !dialogoAberto) { janela.show(); janela.moveTop(); janela.focus(); } } catch (_) {}
            }, 1500);
        });
        // Desligar/reiniciar/sair do Windows nunca é bloqueado.
        janela.on("query-session-end", () => { saidaAutorizada = true; });
        janela.on("session-end", () => { saidaAutorizada = true; });
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
        catch (err) {
            if (err && err.precisaSenha) return { ok: false, precisaSenha: true, mensagem: err.message };
            reg.erro("Falha em " + canal + ": " + (err && err.message || err));
            return { ok: false, mensagem: String(err && err.message || err) };
        }
    });
    const objeto = v => v && typeof v === "object" ? v : {};
    /** Configuração para a tela: nunca o hash da senha; a senha do Firebird só desbloqueado. */
    const configParaTela = () => {
        const c = motor.config();
        delete c.senhaAdmin;
        if (!desbloqueado()) c.fbPass = null;
        return c;
    };

    function registrarIpc() {
        tratar("estoque:pesquisar", p => motor.pesquisar(objeto(p)));
        tratar("estoque:item", p => motor.item(objeto(p)));
        tratar("estoque:status", () => motor.status());
        tratar("estoque:atualizar", () => motor.atualizarAgora());
        tratar("estoque:procurar", () => { exigirAdmin(); return motor.procurarAgora(); });
        tratar("estoque:cancelar-copia", () => { exigirAdmin(); return motor.cancelarCopia(); });
        tratar("estoque:csv", async p => {
            exigirAdmin();
            const r = motor.exportarCsv(objeto(p));
            if (!r) return { ok: false, mensagem: "Estoque ainda não carregado." };
            const d = new Date(), z = n => String(n).padStart(2, "0");
            // A janela "Salvar" do Windows precisa aparecer por cima do quiosque.
            dialogoAberto = true;
            try { janela.setAlwaysOnTop(false); } catch (_) {}
            let escolha;
            try {
                escolha = await dialog.showSaveDialog(janela, {
                    title: "Exportar a lista",
                    defaultPath: path.join(app.getPath("documents"), "estoque-" + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + ".csv"),
                    filters: [{ name: "Planilha CSV", extensions: ["csv"] }]
                });
            } finally {
                dialogoAberto = false;
                aplicarJanela(motor.config());
            }
            if (escolha.canceled || !escolha.filePath) return { ok: false, cancelado: true };
            await fs.promises.writeFile(escolha.filePath, r.texto, "utf8");
            reg.info("Lista exportada: " + escolha.filePath + " (" + r.linhas + " itens).");
            return { ok: true, linhas: r.linhas, arquivo: escolha.filePath };
        });
        tratar("config:ler", () => configParaTela());
        tratar("config:salvar", c => {
            const parcial = Object.assign({}, objeto(c));
            delete parcial.senhaAdmin;
            if (parcial.fbPass == null) delete parcial.fbPass; // tela bloqueada não recebe a senha do Firebird
            const antes = motor.config();
            if (Config.sensiveisAlteradas(antes, parcial).length) exigirAdmin();
            const cfg = motor.salvarConfig(parcial);
            aplicarJanela(cfg);
            if (antes.iniciarComWindows !== cfg.iniciarComWindows) aplicarInicioComWindows(cfg);
            if (!antes.persistente && cfg.persistente) garantirVigia(cfg);
            if (antes.persistente && !cfg.persistente) reg.info("Persistência desligada pelo administrador (o vigia encerra sozinho).");
            return { ok: true, cfg: configParaTela(), reiniciar: antes.aceleracaoGrafica !== cfg.aceleracaoGrafica };
        });
        tratar("admin:estado", () => estadoAdmin());
        tratar("admin:desbloquear", async senha => {
            const r = await conferirSenha(senha);
            if (r && r.espera) return { ok: false, mensagem: "Aguarde " + r.espera + " s para tentar de novo." };
            if (!r) return { ok: false, mensagem: "Senha incorreta." };
            desbloqueadoAte = Date.now() + DESBLOQUEIO_MS;
            return { ok: true, estado: estadoAdmin() };
        });
        tratar("admin:bloquear", () => { desbloqueadoAte = 0; return estadoAdmin(); });
        tratar("admin:definir-senha", async p => {
            const d = objeto(p);
            const nova = String(d.nova == null ? "" : d.nova);
            if (nova.length < 4 || nova.length > 64) return { ok: false, mensagem: "A senha precisa ter de 4 a 64 caracteres." };
            if (temSenha() && !desbloqueado()) {
                const r = await conferirSenha(d.atual);
                if (!r || r.espera) return { ok: false, mensagem: r && r.espera ? "Aguarde " + r.espera + " s." : "Senha atual incorreta." };
            }
            motor.definirSenhaAdmin(Config.gerarHashSenha(nova));
            desbloqueadoAte = Date.now() + DESBLOQUEIO_MS;
            return { ok: true, estado: estadoAdmin() };
        });
        tratar("admin:manutencao", ligar => {
            exigirAdmin();
            manutencao = !!ligar;
            reg.info(manutencao ? "Modo manutenção ligado pelo administrador (quiosque suspenso)." : "Modo manutenção desligado (quiosque de volta).");
            aplicarJanela(motor.config());
            return estadoAdmin();
        });
        tratar("app:sair", async senha => {
            if (!desbloqueado()) {
                const r = await conferirSenha(senha);
                if (r && r.espera) return { ok: false, mensagem: "Aguarde " + r.espera + " s para tentar de novo." };
                if (!r) return { ok: false, mensagem: "Senha incorreta." };
            }
            sairAutorizado("Sair do aplicativo");
            return { ok: true };
        });
        tratar("app:log", () => reg.ultimas());
        tratar("app:info", () => ({
            versao: VERSAO, variante: VARIANTE, demo: DEMO,
            electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
            sistema: os.type() + " " + os.release() + " (" + process.arch + ")",
            pastaDados: PASTA_DADOS, arquivoLog: reg.arquivo,
            monitores: screen.getAllDisplays().map((t, i) => ({ i, nome: "Monitor " + (i + 1) + " (" + t.size.width + "×" + t.size.height + ")" + (t.id === screen.getPrimaryDisplay().id ? " — principal" : "") })),
            vigiaAtivo: pidVivo(lerPid(ARQ.vigiaPid))
        }));
        tratar("app:abrir-pasta", () => { exigirAdmin(); return shell.openPath(PASTA_DADOS); });
        tratar("janela:zoom", v => {
            const z = Config.validarValor("zoom", v);
            if (janela) janela.webContents.setZoomFactor(z);
            motor.salvarConfig({ zoom: z });
            return z;
        });
        tratar("app:reiniciar", () => { exigirAdmin(); reiniciarApp("pedido do administrador"); return true; });
    }

    // ── Início ───────────────────────────────────────────────────────────────
    app.whenReady().then(async () => {
        reg.info("Consulta Estoque " + VERSAO + " (" + VARIANTE + ") iniciado — Electron " + process.versions.electron +
            ", " + os.type() + " " + os.release() + " " + process.arch + (DEMO ? " — MODO DEMONSTRAÇÃO" : "") +
            (SEM_GPU ? " — sem aceleração gráfica" : "") +
            (QUIOSQUE ? " — quiosque" : "") + ". Dados em " + PASTA_DADOS);
        try { fs.writeFileSync(ARQ.appPid, String(process.pid)); } catch (_) {}
        let dep = {};
        if (DEMO) {
            const demo = require("./src/demo.js");
            Config.salvar(ARQ_CONFIG, Config.mesclar(Config.carregar(ARQ_CONFIG).cfg, { fbHost: "127.0.0.1", fdbPath: "DEMO", fbHostFixo: true }));
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
        const cfg = motor.config();
        aplicarInicioComWindows(cfg);
        garantirVigia(cfg);
        // Reinício diário (memória limpa em PCs fracos): confere a cada 20 s.
        setInterval(() => {
            const c = motor.config();
            if (!c.reiniciarDiario) return;
            const d = new Date(), p = n => String(n).padStart(2, "0");
            const agora = p(d.getHours()) + ":" + p(d.getMinutes());
            const hoje = d.toDateString();
            if (agora === c.reiniciarDiario && ultimoReinicioDiario !== hoje && process.uptime() > 120) {
                ultimoReinicioDiario = hoje;
                reiniciarApp("reinício diário às " + c.reiniciarDiario);
            }
        }, 20000).unref();
        await motor.iniciar();
    }).catch(e => {
        reg.erro("Falha ao iniciar: " + (e && e.stack || e));
        dialog.showErrorBox("Consulta Estoque", "Falha ao iniciar: " + (e && e.message || e));
        app.exit(1);
    });

    app.on("window-all-closed", () => {
        // Quiosque: a janela não pode sumir sem a senha — se sumir, volta.
        if (QUIOSQUE && !saidaAutorizada && !encerrando) {
            reg.aviso("A janela foi fechada sem a senha — reabrindo.");
            setTimeout(() => { try { if (!janela) criarJanela(); } catch (e) { reg.erro("Falha ao reabrir a janela: " + e.message); } }, 500);
            return;
        }
        app.quit();
    });
    app.on("before-quit", e => {
        // Quiosque: só sai com a senha (ou com o Windows desligando).
        if (QUIOSQUE && !saidaAutorizada) { e.preventDefault(); return; }
        encerrando = true;
        try { if (motor) motor.encerrar(); } catch (_) {}
        try { if (lerPid(ARQ.appPid) === process.pid) fs.unlinkSync(ARQ.appPid); } catch (_) {}
        partidaConcluida();
        reg.info("Consulta Estoque encerrado.");
    });
}
