"use strict";
// gbak simulado para os testes automáticos da cópia offline.
//   backup:      -b -g  host:ORIGEM  SAIDA.fbk    → copia ORIGEM para SAIDA com cabeçalho "FBK1\n"
//   restauração: -c -mode read_only  ENTRADA.fbk  host:DESTINO → tira o cabeçalho e grava DESTINO
// Variáveis de ambiente (opcionais):
//   MOCK_GBAK_LOG       arquivo onde registra cada chamada (args + se recebeu a senha por ambiente)
//   MOCK_GBAK_FALHAR    "backup" | "restauracao" → sai com erro nessa etapa
//   MOCK_GBAK_ATRASO_MS atraso antes de terminar (simula banco grande)
const fs = require("fs");

const args = process.argv.slice(2);
const registrar = obj => { if (process.env.MOCK_GBAK_LOG) { try { fs.appendFileSync(process.env.MOCK_GBAK_LOG, JSON.stringify(obj) + "\n"); } catch (_) {} } };
const semHost = s => { const m = String(s).match(/^[^:\\/]+(?:\/\d+)?:(.+)$/); return m && m[1].length > 1 ? m[1] : String(s); };
const posicionais = args.filter((a, i) => !/^-/.test(a) && !(i > 0 && /^-mode$/i.test(args[i - 1])));
const ehBackup = args.includes("-b"), ehRestauracao = args.includes("-c");
registrar({ args, senhaPorAmbiente: !!process.env.ISC_PASSWORD, usuarioPorAmbiente: !!process.env.ISC_USER });

const fim = (codigo, msg) => {
    const ms = parseInt(process.env.MOCK_GBAK_ATRASO_MS || "0", 10) || 0;
    setTimeout(() => { if (msg) process.stderr.write(msg + "\n"); process.exit(codigo); }, ms);
};
try {
    if (posicionais.length < 2) fim(1, "gbak: argumentos insuficientes");
    else if (ehBackup) {
        if (process.env.MOCK_GBAK_FALHAR === "backup") fim(1, "gbak: ERROR: lock time-out on wait transaction / database shutdown");
        else {
            const origem = semHost(posicionais[posicionais.length - 2]), saida = posicionais[posicionais.length - 1];
            const dados = fs.readFileSync(origem);
            fs.writeFileSync(saida, Buffer.concat([Buffer.from("FBK1\n"), dados]));
            fim(0);
        }
    } else if (ehRestauracao) {
        if (process.env.MOCK_GBAK_FALHAR === "restauracao") fim(1, "gbak: ERROR: I/O error during restore");
        else {
            const entrada = posicionais[posicionais.length - 2], destino = semHost(posicionais[posicionais.length - 1]);
            const dados = fs.readFileSync(entrada);
            if (dados.slice(0, 5).toString() !== "FBK1\n") fim(1, "gbak: ERROR: expected backup file");
            else { fs.writeFileSync(destino, dados.slice(5)); fim(0); }
        }
    } else fim(1, "gbak: operação desconhecida");
} catch (e) { fim(1, "gbak: " + e.message); }
