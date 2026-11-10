"use strict";
/**
 * preload.js
 * @version 1.4.0
 * @author Ruda Gabriel
 * @description Ponte segura entre a tela e o processo principal: expõe só as
 *              funções da consulta (window.consulta), nunca o Node inteiro.
 *
 * @changelog
 *   (Histórico completo das versões: CHANGELOG.md no repositório.)
 *   1.4.0 — instalarFirebird({ trocar }) troca o Firebird local pela versão do servidor.
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
    zoom: v => ipcRenderer.invoke("janela:zoom", v),
    reiniciar: () => ipcRenderer.invoke("app:reiniciar"),
    sair: senha => ipcRenderer.invoke("app:sair", senha),
    adminEstado: () => ipcRenderer.invoke("admin:estado"),
    desbloquear: senha => ipcRenderer.invoke("admin:desbloquear", senha),
    bloquear: () => ipcRenderer.invoke("admin:bloquear"),
    definirSenha: d => ipcRenderer.invoke("admin:definir-senha", d),
    manutencao: ligar => ipcRenderer.invoke("admin:manutencao", ligar),
    removerSenha: () => ipcRenderer.invoke("admin:remover-senha"),
    configuracaoInicial: d => ipcRenderer.invoke("app:configuracao-inicial", d),
    firebirdEstado: () => ipcRenderer.invoke("firebird:estado"),
    instalarFirebird: o => ipcRenderer.invoke("firebird:instalar", o || {}),
    firebirdNaoPerguntar: () => ipcRenderer.invoke("firebird:nao-perguntar"),
    outrosFdb: () => ipcRenderer.invoke("banco:outros"),
    usarBanco: p => ipcRenderer.invoke("banco:usar", p),
    aoEtapaFirebird: f => ouvir("firebird:etapa", f),
    aoPedirSaida: f => ouvir("admin:pedir-saida", f),
    aoStatus: f => ouvir("estoque:status", f),
    aoDadosNovos: f => ouvir("estoque:dados-novos", f),
    aoLog: f => ouvir("app:log-linha", f)
});
