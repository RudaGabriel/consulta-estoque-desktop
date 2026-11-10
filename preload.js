"use strict";
/**
 * preload.js
 * @version 1.0.0
 * @author Ruda Gabriel
 * @description Ponte segura entre a tela e o processo principal: expõe só as
 *              funções da consulta (window.consulta), nunca o Node inteiro.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.0.0 — Primeira versão.
 */
const { contextBridge, ipcRenderer } = require("electron");

const ouvir = (canal, f) => {
    if (typeof f !== "function") return () => {};
    const h = (_e, dado) => { try { f(dado); } catch (_) {} };
    ipcRenderer.on(canal, h);
    return () => ipcRenderer.removeListener(canal, h);
};

contextBridge.exposeInMainWorld("consulta", {
    pesquisar: p => ipcRenderer.invoke("estoque:pesquisar", p),
    item: p => ipcRenderer.invoke("estoque:item", p),
    status: () => ipcRenderer.invoke("estoque:status"),
    atualizar: () => ipcRenderer.invoke("estoque:atualizar"),
    procurarBanco: () => ipcRenderer.invoke("estoque:procurar"),
    cancelarCopia: () => ipcRenderer.invoke("estoque:cancelar-copia"),
    exportarCsv: p => ipcRenderer.invoke("estoque:csv", p),
    lerConfig: () => ipcRenderer.invoke("config:ler"),
    salvarConfig: c => ipcRenderer.invoke("config:salvar", c),
    log: () => ipcRenderer.invoke("app:log"),
    info: () => ipcRenderer.invoke("app:info"),
    abrirPastaDados: () => ipcRenderer.invoke("app:abrir-pasta"),
    telaCheia: v => ipcRenderer.invoke("janela:tela-cheia", v),
    zoom: v => ipcRenderer.invoke("janela:zoom", v),
    reiniciar: () => ipcRenderer.invoke("app:reiniciar"),
    aoStatus: f => ouvir("estoque:status", f),
    aoDadosNovos: f => ouvir("estoque:dados-novos", f),
    aoLog: f => ouvir("app:log-linha", f)
});
