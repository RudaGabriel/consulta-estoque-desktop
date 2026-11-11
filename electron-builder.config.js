"use strict";
/**
 * electron-builder.config.js
 * @version 1.1.0
 * @author Ruda Gabriel
 * @description Como o instalador e a versão portátil são gerados.
 *   VARIANTE=moderno (padrão) → Electron atual, Windows 10 e 11 de 64 bits.
 *   VARIANTE=legado           → Electron 22, Windows 7, 8, 8.1, 10 e 11, de
 *                               64 bits (x64) e de 32 bits (ia32) — PCs antigos.
 *   (O Electron atual não é mais publicado em 32 bits para Windows.)
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.1.0 — Desinstalador sem rastros: apaga a pasta de dados (deleteAppDataOnUninstall)
 *           e, por build/instalador.nsh, encerra o vigia, tira o início com o Windows
 *           e apaga as cópias do banco e os instaladores do Firebird baixados (nada
 *           disso numa atualização).
 */
const legado = process.env.VARIANTE === "legado";
const sufixo = legado ? "legado-win7-a-11" : "win10-11";

module.exports = {
    appId: "br.rudagabriel.consultaestoque",
    productName: "Consulta Estoque",
    copyright: "© 2026 Ruda Gabriel",
    // Electron 22.3.27 é o último que roda no Windows 7/8/8.1.
    electronVersion: legado ? "22.3.27" : undefined,
    directories: { output: "dist/" + sufixo, buildResources: "build" },
    files: ["main.js", "preload.js", "package.json", "src/**/*", "ui/**/*", "build/icone.png", "!**/*.test.js"],
    extraMetadata: { variante: legado ? "legado (Windows 7 a 11, 32/64 bits)" : "moderno (Windows 10/11, 64 bits)" },
    asar: true,
    compression: "maximum",
    win: {
        icon: "build/icone.ico",
        target: ["nsis", "portable"],
        requestedExecutionLevel: "asInvoker",
        // Sem certificado de assinatura: não tenta assinar.
        signAndEditExecutable: true
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "Consulta Estoque",
        uninstallDisplayName: "Consulta Estoque",
        artifactName: "ConsultaEstoque-${version}-" + sufixo + "-${arch}-instalador.${ext}",
        deleteAppDataOnUninstall: true,
        include: "build/instalador.nsh"
    },
    portable: {
        artifactName: "ConsultaEstoque-${version}-" + sufixo + "-${arch}-portatil.${ext}"
    }
};
