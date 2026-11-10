# Changelog

Histórico das versões de cada arquivo do Consulta Estoque, da mais nova para a mais antiga.
Dentro dos arquivos, o cabeçalho traz apenas a entrada da versão atual; o histórico completo fica aqui.

Versões em uso hoje:

| Arquivo | Versão |
|---|---|
| Aplicativo (`package.json`) | [1.2.0](#aplicativo) |
| [`main.js`](#mainjs) | 1.1.0 |
| [`preload.js`](#preloadjs) | 1.1.0 |
| [`ui/index.html`, `ui/estilo.css`, `ui/app.js`](#ui) | 1.1.0 |
| [`src/motor.js`](#srcmotorjs) | 1.1.0 |
| [`src/firebird.js`](#srcfirebirdjs) | 1.0.0 |
| [`src/estoque-dados.js`](#srcestoque-dadosjs) | 1.0.0 |
| [`src/estoque-busca.js`](#srcestoque-buscajs) | 1.0.0 |
| [`src/localizar-banco.js`](#srclocalizar-bancojs) | 1.2.0 |
| [`src/copia-gbak.js`](#srccopia-gbakjs) | 1.0.0 |
| [`src/config.js`](#srcconfigjs) | 1.1.0 |
| [`src/vigia.js`](#srcvigiajs) | 1.0.0 |
| [`src/registro.js`](#srcregistrojs) | 1.0.0 |
| [`src/demo.js`](#srcdemojs) | 1.0.0 |
| [`electron-builder.config.js`](#electron-builderconfigjs) | 1.0.0 |
| [`gerar-instalador.bat`](#gerar-instaladorbat) | 1.0.0 |
| [`.github/workflows/build.yml`](#githubworkflowsbuildyml) | 1.2.0 |

---

<a id="aplicativo"></a>

## Aplicativo

Versão do Consulta Estoque (a que aparece no instalador e em *Configurações → Diagnóstico*).

### 1.2.0 — 2026-11-10

**SMALL.FDB procurado nas pastas compartilhadas da rede.**

- O `SMALL.FDB` agora é procurado nas pastas compartilhadas (atalhos do Small, unidades de rede, `\\SERVIDOR\SmallSoft`...) e o servidor achado é usado.
- O arquivo nunca é aberto pela pasta: o banco é lido pelo Firebird do servidor, no caminho do disco dele.
- Com só o servidor informado, as pastas compartilhadas dele são procuradas antes dos caminhos típicos.
- Pasta de rede com prazo e servidor desligado pulado na hora: nada trava.
- 51 testes.

### 1.1.0 — 2026-11-10

**Quiosque com senha do administrador, persistência e opções do Windows.**

- **Tela cheia permanente:** abre em tela cheia e não sai dela; sem o botão "Tela cheia", sem F11, sem minimizar.
- **Não fecha sem a senha:** Alt+F4, "X" e Ctrl+W ignorados; sair com **Ctrl+Shift+Q** ou *Administrador → Sair do aplicativo* e a senha.
- **Persistência (vigia):** reabre o aplicativo fechado sem a senha ou que caiu; termina com a saída autorizada ou com a persistência desligada. Desligar/reiniciar o Windows nunca é bloqueado.
- **Senha do administrador:** criada na primeira abertura, guardada só como *hash* PBKDF2, espera crescente após erro, desbloqueio de 5 minutos que termina ao fechar as configurações.
  - Protege as abas Consulta, Banco de dados, Windows e Administrador, a exportação, a pasta de dados e a saída.
  - "Mostrar custo" e "Exportar" saíram da barra de filtros e ficaram protegidos.
- **Aba Windows:** abrir junto com o Windows (padrão ligado), persistência, sempre acima, manter em primeiro plano, impedir descanso, ocultar da barra de tarefas, esconder o cursor parado, reinício diário, monitor, aceleração gráfica.
- **Modo manutenção** para o administrador sair da tela cheia temporariamente.
- **Limpeza automática:** busca e cartão somem 1 minuto após a última tecla/leitura.
- **Abertura segura:** se o aplicativo cair ao abrir por causa da placa de vídeo, a próxima abertura (feita sozinha pelo vigia) vem sem aceleração gráfica.
- **Cópia a cada 3 horas** por padrão (antes 10 min).
- **Caminho do SMALL.FDB procurado no servidor informado:** servidor sem caminho, troca de servidor ou caminho que parou de funcionar.
- **Release no GitHub** com instalador e versão portátil a cada tag `v*`.
- 47 testes (vigia com processos de verdade) e tela validada no Electron 44 e 22.

### 1.0.0 — 2026-11-09

**Primeira versão.**

- Consulta de preço e estoque do Small Commerce em janela própria (Electron), feita para o leitor de código de barras USB/Bluetooth: campo sempre em foco, cada leitura substitui a anterior, cartão de preço grande, som de achou/não achou, TAB do leitor como Enter, fechamento automático do cartão.
- Descoberta automática do banco **pela rede primeiro** (atalhos e `.ini` do Small Commerce, unidades de rede, compartilhamento do servidor, nome `SERVIDOR`, varredura da rede) e o Firebird local só por último; só `SMALL.FDB`.
- Modo **cópia** (padrão; gbak ou leitura instantânea, automático) e modo **leitura direta** (lista a cada 60 s e item relido ao vivo).
- Estoque salvo em disco: abre na hora e funciona com o servidor fora do ar.
- Somente leitura com duas travas (comando e transação).
- Versões: moderna (Windows 10/11, 64 bits, Electron 44.9.3) e legado (Windows 7 a 11, 64 e 32 bits, Electron 22.3.27); instalador e portátil.
- 38 testes automáticos; tela validada com Playwright no Electron 44 e no 22.

---

## `main.js`

Processo principal (janela, instância única, pasta de dados, IPC).

### 1.1.0 — 2026-11-10

**Quiosque, administrador e Windows.** Janela em quiosque (tela cheia que não sai; fechar, minimizar, F11, Alt+F4, Ctrl+W e Ctrl+R desfeitos ou ignorados), senha do administrador no processo principal (todas as ações sensíveis conferidas aqui, não só na tela), Ctrl+Shift+Q, modo manutenção, vigia de persistência, iniciar com o Windows, sempre acima, manter em foco, impedir descanso, ocultar da barra de tarefas, reinício diário, monitor; desligar o Windows nunca é bloqueado; `CONSULTA_SEM_QUIOSQUE=1` para desenvolvimento e testes. **Abertura segura:** se a abertura anterior caiu antes de mostrar a tela (placa de vídeo/driver: "GPU process isn't usable"), a próxima abre sem aceleração gráfica sozinha; quedas do processo de vídeo vão para o log.

### 1.0.0 — 2026-11-09

**Primeira versão.** Janela própria sem menu, posição e tamanho lembrados, tela cheia (F11), sempre no topo, zoom, iniciar com o Windows, aceleração gráfica desligável (`--sem-gpu`), modo `--demo`, versão portátil com dados ao lado do `.exe`, IPC aceito só da própria tela, recarga da tela se ela parar.

---

## `preload.js`

Ponte segura entre a tela e o processo principal.

### 1.1.0 — 2026-11-10

**Funções do administrador** (estado, desbloquear, bloquear, definir senha, manutenção, sair) e aviso de pedido de saída; sem a função de tela cheia.

### 1.0.0 — 2026-11-09

**Primeira versão.** Expõe só `window.consulta` (pesquisar, item, status, configurações, log, exportar, tela cheia, zoom).

---

<a id="ui"></a>

## `ui/index.html`, `ui/estilo.css`, `ui/app.js`

A tela.

### 1.1.0 — 2026-11-10

**Senha do administrador e quiosque.** Criação da senha na primeira abertura, abas protegidas com trava, janela de senha/confirmação, aba Windows, aba Administrador (trocar senha, exportar, pasta de dados, manutenção, reiniciar, sair), limpeza automática após 1 minuto sem mexer, cursor oculto quando parado, sem o botão de tela cheia, abas em duas linhas.

### 1.0.0 — 2026-11-09

**Primeira versão.** Busca grande com foco permanente para o leitor, cartão de preço, lista paginada com destaque dos termos, filtros guardados, exportação CSV, painel de configurações (modo de leitura, banco de dados, tela, diagnóstico com log ao vivo), temas claro/escuro/automático, modo leve, compatível com o Chromium 108.

---

## `src/motor.js`

Modos, atualização, cache em disco e auto-correção do banco.

### 1.1.0 — 2026-11-10

**Caminho procurado no servidor conhecido.** Servidor sem caminho, caminho errado ou servidor trocado: o `SMALL.FDB` é procurado nesse servidor antes da busca geral (também com `fbHostFixo`); senha do administrador gravada só por `definirSenhaAdmin`.

### 1.0.0 — 2026-11-09

**Primeira versão.** Métodos gbak/instantâneo/direto, intervalo da cópia nunca menor que 3× a duração do gbak, nova tentativa com espera crescente (até 10 min), busca do banco quando o configurado falha (no máximo a cada 5 min) sobrescrevendo a configuração, nova busca da rede quando o banco foi adotado neste computador, produto lido aberto mesmo fora dos filtros, item ao vivo na leitura direta.

---

## `src/firebird.js`

Conexão Firebird somente leitura.

### 1.0.0 — 2026-11-09

**Primeira versão.** Trava de comando (`SELECT`/`WITH`) e de transação (READ COMMITTED + REC_VERSION, somente leitura, sem espera; lista no node-firebird 0.x), conexão e consulta com prazo, corte de socket, teste de porta, decodificação UTF-8 → Windows-1252 → latin1, erros em linguagem simples.

---

## `src/estoque-dados.js`

Leitura da tabela de produtos.

### 1.0.0 — 2026-11-09

**Primeira versão.** Papéis das colunas pelo catálogo (EAN do Small em `REFERENCIA`), texto como `OCTETS` com repetição sem ele, BLOB binário fora, situação ativo/inativo decidida pelos dados, releitura de um item, cache em disco validado, CSV protegido contra fórmula.

---

## `src/estoque-busca.js`

Regras da busca.

### 1.0.0 — 2026-11-09

**Primeira versão.** Mesmas regras do `estoque-busca.js` 1.0.0 do Relatórios FDB-FBK.

---

## `src/localizar-banco.js`

Descoberta automática do banco.

### 1.2.0 — 2026-11-10

**SMALL.FDB nas pastas compartilhadas.** `buscarFdbNaRede` lista as pastas compartilhadas (UNC) atrás do `SMALL.FDB` — só a lista, nunca o arquivo —, com prazo por pasta (4 s), tempo total (20 s), limite de profundidade e de pastas, e só em servidor com a porta 445 aberta. `caminhosDoCompartilhamento` converte o UNC achado nos caminhos prováveis do disco do servidor (`\\SRV\C$\...` dá o exato), testados pelo Firebird dele. Nova etapa 1b em `localizar` e busca nas pastas do servidor em `caminhoNoServidor`. Compartilhamento desta máquina não vira servidor.

### 1.1.0 — 2026-11-10

**`caminhoNoServidor`:** procura o `SMALL.FDB` só num servidor já conhecido (caminhos típicos de C: a H: e o anterior), sem trocar o servidor.

### 1.0.0 — 2026-11-09

**Primeira versão.** Rede primeiro e `127.0.0.1` por último; só `SMALL.FDB`; pistas: `.ini`/`.cfg` locais, das unidades de rede e do compartilhamento do servidor, atalhos `.lnk` do Small Commerce, nome `SERVIDOR`, varredura (LAN, Tailscale, 169.254); IPs e nome desta máquina nunca contam como servidor; leituras de rede com prazo; unidades de rede/CD fora da busca de `.FDB`.

---

## `src/copia-gbak.js`

Cópia por gbak.

### 1.0.0 — 2026-11-09

**Primeira versão.** `gbak -b -g` + `gbak -c -mode read_only`, senha por variável de ambiente, prioridade abaixo do normal, troca atômica com manifesto, limpeza só de arquivos próprios, prazo e cancelamento, gbak localizado sozinho (serviço do Firebird em execução primeiro).

---

## `src/config.js`

Configuração validada.

### 1.1.0 — 2026-11-10

**Quiosque e administrador.** Chaves do Windows, `senhaAdmin` só como *hash* PBKDF2 (`gerarHashSenha`/`conferirSenha` em tempo constante), lista de chaves sensíveis (`sensiveisAlteradas`), cópia a cada 3 horas por padrão, `limparAposSeg` no lugar de `fecharDetalheSeg`, `telaCheia` removida.

### 1.0.0 — 2026-11-09

**Primeira versão.** Padrões, faixas e listas de valores aceitos, gravação atômica, `config.json` estragado guardado à parte.

---

## `src/vigia.js`

Persistência do quiosque.

### 1.0.0 — 2026-11-10

**Primeira versão.** Reabre o aplicativo fechado sem a senha (espera 12 s por um reinício normal; no máximo 5 reaberturas em 3 minutos, depois pausa de 1 minuto), um vigia só, termina com a saída autorizada, com a persistência desligada ou se outro vigia assumir; registra no log como `[VIGIA]`.

---

## `src/registro.js`

Log.

### 1.0.0 — 2026-11-09

**Primeira versão.** `consulta-estoque.log` com rotação em 2 MB e as últimas 400 linhas em memória para a tela de Diagnóstico.

---

## `src/demo.js`

Firebird simulado.

### 1.0.0 — 2026-11-09

**Primeira versão.** Usado pelos testes e pelo modo `--demo`.

---

## `electron-builder.config.js`

Geração do instalador e da versão portátil.

### 1.0.0 — 2026-11-09

**Primeira versão.** Variante moderna (Electron 44, Windows 10/11 x64) e legado (Electron 22.3.27, Windows 7 a 11 x64 e ia32).

---

## `gerar-instalador.bat`

Gera os instaladores com dois cliques.

### 1.0.0 — 2026-11-09

**Primeira versão.**

---

## `.github/workflows/build.yml`

CI.

### 1.2.0 — 2026-11-10

**Release automática a cada versão nova na `main`:** cria a tag `v<versão do package.json>` e publica os instaladores e as versões portáteis. Release que já tem todos os arquivos é pulada; se faltar algum (envio interrompido), é completada. Tag `v*` enviada à mão ou disparo manual numa tag continuam publicando.

### 1.1.0 — 2026-11-10

**Release automática:** com tag `v*`, publica os instaladores e as versões portáteis (moderna e legado) numa Release do GitHub. O teste de abertura grava o log do Chromium e, se a 1ª abertura cair (máquina virtual sem placa de vídeo), exige que a 2ª abra no modo seguro.

### 1.0.0 — 2026-11-09

**Primeira versão.** Testes no Linux; instaladores no Windows (moderno e legado), com teste de abertura do aplicativo empacotado em modo demonstração.
