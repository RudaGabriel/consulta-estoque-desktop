# Changelog

Histórico das versões de cada arquivo do Consulta Estoque, da mais nova para a mais antiga.
Dentro dos arquivos, o cabeçalho traz apenas a entrada da versão atual; o histórico completo fica aqui.

Versões em uso hoje:

| Arquivo | Versão |
|---|---|
| Aplicativo (`package.json`) | [1.6.1](#aplicativo) |
| [`main.js`](#mainjs) | 1.5.2 |
| [`preload.js`](#preloadjs) | 1.5.0 |
| [`ui/index.html`, `ui/estilo.css`, `ui/app.js`](#ui) | 1.6.0 (`app.js`); 1.4.0 (`index.html`, `estilo.css`) |
| [`src/motor.js`](#srcmotorjs) | 1.6.0 |
| [`src/firebird.js`](#srcfirebirdjs) | 1.1.0 |
| [`src/estoque-dados.js`](#srcestoque-dadosjs) | 1.1.0 |
| [`src/estoque-busca.js`](#srcestoque-buscajs) | 1.2.0 |
| [`src/localizar-banco.js`](#srclocalizar-bancojs) | 1.4.0 |
| [`src/caminhos.js`](#srccaminhosjs) | 1.0.0 |
| [`src/autoexcluir.js`](#srcautoexcluirjs) | 1.0.0 |
| [`src/instalar-firebird.js`](#srcinstalar-firebirdjs) | 1.2.0 |
| [`src/copia-gbak.js`](#srccopia-gbakjs) | 1.2.0 |
| [`src/config.js`](#srcconfigjs) | 1.4.0 |
| [`src/vigia.js`](#srcvigiajs) | 1.1.0 |
| [`src/registro.js`](#srcregistrojs) | 1.0.0 |
| [`src/demo.js`](#srcdemojs) | 1.2.0 |
| [`electron-builder.config.js`](#electron-builderconfigjs) | 1.1.0 |
| [`build/instalador.nsh`](#buildinstaladornsh) | 1.0.0 |
| [`gerar-instalador.bat`](#gerar-instaladorbat) | 1.0.0 |
| [`.github/workflows/build.yml`](#githubworkflowsbuildyml) | 1.4.0 |

---

<a id="aplicativo"></a>

## Aplicativo

Versão do Consulta Estoque (a que aparece no instalador e em *Configurações → Diagnóstico*).

### 1.6.1 — 2026-11-12

**Correções da remoção da versão portátil e do download.**

- **"Apagar esta versão portátil" funciona de verdade:** a remoção era feita por um comando PowerShell oculto, que o antivírus do Windows costuma barrar quando vem de um programa sem assinatura — o aplicativo fechava e nada era apagado. Agora um ajudante próprio (o mesmo mecanismo do vigia) espera o aplicativo, o vigia e o lançador do portátil fecharem, apaga o `.exe` e os dados (tentando por até 2 minutos se algo estiver preso) e limpa a pasta temporária onde o portátil abriu. O aplicativo só fecha depois de ver o ajudante de pé; se ele não iniciar, avisa e não fecha.
- Com o `.exe` guardado na raiz de uma unidade (ex.: `D:\`, pendrive), a pasta `ConsultaEstoque-dados` também é apagada (antes ficava para trás).
- **Release com `SHA256SUMS.txt`:** as "impressões digitais" dos arquivos, para conferir se o download chegou inteiro (o erro "Installer integrity check has failed" é arquivo estragado no download).
- 76 testes.

### 1.6.0 — 2026-11-11

**Instantâneo como padrão, cartão para ler de longe, projeto neutro e remoção completa.**

- **Modos:** *Instantâneo* (padrão — um `SELECT` somente leitura, sem travar o caixa e sem instalar nada), *Cópia do banco* (gbak) e *Leitura direta*, em três cartões na aba Consulta; quem usava o automático passa para o instantâneo (uma vez só).
- **Sem cópia repetida:** depois da primeira cópia completa não começa outra na sequência.
- **Sem totais** de estoque somado e de valor de venda em estoque.
- **"Abaixo do mínimo"** só aparece quando o banco tem o estoque mínimo preenchido.
- **Cartão ampliado** centralizado como etiqueta de gôndola: nome maior e **preço com ~1/4 da altura da tela** ("R$" pequeno no alto; 200 px numa tela de 768 px), caixas e campos vazios escondidos; fecha ao voltar a digitar.
- **X** dos botões de fechar centralizado; **botão de voltar ao topo** da lista; dica do **`-palavra`**.
- **Bipe** mais alto (onda quadrada) com **volume** ajustável e botão de teste.
- **Aceleração gráfica** desligada por padrão (também em quem já usava, uma vez só).
- **Remoção completa:** botão *Apagar esta versão portátil*; o desinstalador apaga dados, cópias, instaladores baixados e o início com o Windows.
- **Erro "AggregateError"** virou mensagem clara (servidor não respondeu em nenhum endereço).
- **Projeto neutro:** sem nomes de sistemas, marcas ou outros projetos nas telas, mensagens e documentação; créditos do autor explícitos no README.
- Tempo máximo de uma cópia × intervalo explicados na tela e no README.
- 68 testes; tela validada no Electron 44 e 22.

### 1.5.0 — 2026-11-10

**Firebird deste computador na versão do servidor.** O aplicativo lê a versão do Firebird do servidor e a deste computador. Sem Firebird aqui, oferece instalar a mesma versão do servidor; com um Firebird mais antigo que o do servidor, usa a cópia instantânea e oferece **trocar** (desinstala o antigo e instala o novo, numa só permissão do Windows) — sempre com confirmação clara e a senha. Instaladores oficiais 2.5.9, 3.0.13, 4.0.6 e 5.0.3 com SHA-256 conferido. Corrige a instalação da 1.3.0, que não incluía o gbak. 66 testes.

### 1.4.1 — 2026-11-10

**Atualizar/F5 confirma antes de uma nova cópia.** No modo cópia, a janela "Fazer uma nova cópia do banco agora?" explica o que acontece (cópia completa gbak ou leitura instantânea), quanto a última cópia levou, o efeito no servidor do caixa e quando seria a próxima cópia automática. Com cópia em andamento, só avisa. 64 testes.

### 1.4.0 — 2026-11-10

**Abertura rápida, andamento da cópia e senha opcional.**

- **Abre mais rápido:** cópia salva ainda no prazo não é refeita a cada abertura; o estoque salvo é lido sem travar; gbak procurado pelo registro do Windows (a consulta WMI levava segundos); a primeira atualização espera a tela abrir.
- **Vigia reabre em 1 a 2 s** (antes ~14 s), sem abrir duas vezes.
- **Uma instância só:** a segunda abertura sai na hora e traz a janela aberta para a frente.
- **Barra de tarefas:** a janela já nasce oculta da barra (não aparece e some depois).
- **Andamento da cópia:** barra com etapa, porcentagem e quanto falta (pela última cópia).
- **Configuração inicial:** nome da loja e senha do administrador, os dois opcionais; sem senha, tudo fica livre; criar e remover a senha depois.
- 63 testes; tela validada no Electron 44 e 22.

### 1.3.0 — 2026-11-10

**Busca com coringa e preço, foco garantido, varredura completa do banco e Firebird automático.**

- **Foco na busca:** abre com o foco no campo; perdido na tela principal, volta 30 s depois da última ação (e é conferido a cada 30 s).
- **Coringa `*`:** `RAÇÃO*10KG` acha as partes na ordem, no mesmo campo (opção em *Consulta*, ligada).
- **Preço na busca:** `RAÇÃO >50` = R$ 50 ou mais; `RAÇÃO <50` = R$ 50 ou menos; `>=`, `<=`, centavos e os dois juntos (opção em *Consulta*, ligada).
- **Ocultar da barra de tarefas** ligado por padrão (também em quem já usava, uma vez só).
- **Meta da busca automática:** pergunta na primeira abertura se o banco fica na rede ou neste computador; a busca começa por lá e varre tudo (disco local mais a fundo, pastas compartilhadas de todos os servidores via "net view", rede inteira).
- **Sem `SMALL.FDB` em lugar nenhum:** avisa que varreu tudo e oferece os outros `.FDB` achados; cada um é aberto (só leitura) e o administrador escolhe o certo.
- **Firebird neste computador:** quando falta, pergunta se quer instalar; baixa o Firebird 3.0.13 oficial, confere o SHA-256 e instala sozinho como serviço (com a permissão do Windows).
- 61 testes; tela validada no Electron 44 e 22.

### 1.2.0 — 2026-11-10

**SMALL.FDB procurado nas pastas compartilhadas da rede.**

- O `SMALL.FDB` agora é procurado nas pastas compartilhadas (atalhos do sistema, unidades de rede, pastas do servidor...) e o servidor achado é usado.
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

- Consulta de preço e estoque em janela própria (Electron), feita para o leitor de código de barras USB/Bluetooth: campo sempre em foco, cada leitura substitui a anterior, cartão de preço grande, som de achou/não achou, TAB do leitor como Enter, fechamento automático do cartão.
- Descoberta automática do banco **pela rede primeiro** (atalhos e `.ini` do sistema de gestão, unidades de rede, compartilhamento do servidor, nome `SERVIDOR`, varredura da rede) e o Firebird local só por último; só `SMALL.FDB`.
- Modo **cópia** (padrão; gbak ou leitura instantânea, automático) e modo **leitura direta** (lista a cada 60 s e item relido ao vivo).
- Estoque salvo em disco: abre na hora e funciona com o servidor fora do ar.
- Somente leitura com duas travas (comando e transação).
- Versões: moderna (Windows 10/11, 64 bits, Electron 44.9.3) e legado (Windows 7 a 11, 64 e 32 bits, Electron 22.3.27); instalador e portátil.
- 38 testes automáticos; tela validada com Playwright no Electron 44 e no 22.

---

## `main.js`

Processo principal (janela, instância única, pasta de dados, IPC).

### 1.5.2 — 2026-11-12

**Autoexclusão do portátil refeita:** um ajudante próprio (`src/autoexcluir.js`, roda como Node, como o vigia) no lugar do comando PowerShell oculto e codificado (barrado por antivírus). Espera também o lançador do portátil (`process.ppid`), que segura o `.exe` enquanto limpa a pasta temporária; só fecha o aplicativo depois do evento `spawn` do ajudante (falhou → mensagem e o aplicativo continua aberto); o vigia só é avisado depois disso.

### 1.5.1 — 2026-11-11

**Autoexclusão do portátil na raiz de uma unidade:** a pasta de dados passa a ser reconhecida por `dentroDaPasta` (somar a barra a `D:\` dava `D:\\` e nada casava).

### 1.5.0 — 2026-11-11

**Autoexclusão da versão portátil** (`app:autoexcluir`, com a senha): desliga o início com o Windows, encerra o vigia e, depois de fechar, apaga o `.exe`, a pasta de dados do portátil, as cópias e os instaladores baixados (PowerShell com prazo e novas tentativas). `app:info` informa se é a versão portátil. Mensagem neutra na troca do Firebird.

### 1.4.0 — 2026-11-10

**Firebird na versão do servidor:** `firebird:estado` traz as versões; `firebird:instalar` instala a versão do servidor e, com `{ trocar: true }`, troca o Firebird local mais antigo (recusado se o banco em uso estiver neste computador, se já for compatível ou sem o desinstalador).

### 1.3.0 — 2026-11-10

**Abertura e instância única.** Segunda abertura sai na hora (`app.exit`), PID gravado antes do `ready`, aviso `reiniciando` para o vigia no reinício pelo próprio aplicativo, `skipTaskbar` já na criação da janela; `admin:remover-senha` e `app:configuracao-inicial` (livre só antes da primeira configuração); `configInicial` nunca muda pela tela.

### 1.2.0 — 2026-11-10

**Firebird e outros .FDB.** Canais `firebird:estado`, `firebird:instalar` (com a senha; a janela sai de "sempre acima" enquanto o Windows pede a permissão; uma instalação por vez), `firebird:nao-perguntar` (sem senha: só desliga a pergunta), `banco:outros` e `banco:usar` (com a senha). Foco do teclado na tela ao abrir.

### 1.1.0 — 2026-11-10

**Quiosque, administrador e Windows.** Janela em quiosque (tela cheia que não sai; fechar, minimizar, F11, Alt+F4, Ctrl+W e Ctrl+R desfeitos ou ignorados), senha do administrador no processo principal (todas as ações sensíveis conferidas aqui, não só na tela), Ctrl+Shift+Q, modo manutenção, vigia de persistência, iniciar com o Windows, sempre acima, manter em foco, impedir descanso, ocultar da barra de tarefas, reinício diário, monitor; desligar o Windows nunca é bloqueado; `CONSULTA_SEM_QUIOSQUE=1` para desenvolvimento e testes. **Abertura segura:** se a abertura anterior caiu antes de mostrar a tela (placa de vídeo/driver: "GPU process isn't usable"), a próxima abre sem aceleração gráfica sozinha; quedas do processo de vídeo vão para o log.

### 1.0.0 — 2026-11-09

**Primeira versão.** Janela própria sem menu, posição e tamanho lembrados, tela cheia (F11), sempre no topo, zoom, iniciar com o Windows, aceleração gráfica desligável (`--sem-gpu`), modo `--demo`, versão portátil com dados ao lado do `.exe`, IPC aceito só da própria tela, recarga da tela se ela parar.

---

## `preload.js`

Ponte segura entre a tela e o processo principal.

### 1.5.0 — 2026-11-11

**`autoexcluir`.**

### 1.4.0 — 2026-11-10

**`instalarFirebird({ trocar })`.**

### 1.3.0 — 2026-11-10

**Configuração inicial e senha opcional:** `configuracaoInicial` e `removerSenha`.

### 1.2.0 — 2026-11-10

**Firebird e outros .FDB:** `firebirdEstado`, `instalarFirebird`, `firebirdNaoPerguntar`, `aoEtapaFirebird`, `outrosFdb` e `usarBanco`.

### 1.1.0 — 2026-11-10

**Funções do administrador** (estado, desbloquear, bloquear, definir senha, manutenção, sair) e aviso de pedido de saída; sem a função de tela cheia.

### 1.0.0 — 2026-11-09

**Primeira versão.** Expõe só `window.consulta` (pesquisar, item, status, configurações, log, exportar, tela cheia, zoom).

---

<a id="ui"></a>

## `ui/index.html`, `ui/estilo.css`, `ui/app.js`

A tela.

### 1.6.0 (`app.js`) e 1.4.0 (`index.html`, `estilo.css`) — 2026-11-11

**Modos, cartão, bipe e neutralidade.** Três cartões de modo (Instantâneo padrão, Cópia do banco, Leitura direta); contador sem totais; "Abaixo do mínimo" só com mínimo preenchido; cartão centralizado como etiqueta (preço com ~1/4 da altura da tela e "R$" pequeno no alto), caixas e campos vazios escondidos, fecha ao digitar; X desenhado em SVG (centralizado); botão de voltar ao topo; bipe em onda quadrada com volume e teste; dica do `-palavra`; explicação do tempo máximo de uma cópia; botão de apagar a versão portátil; pergunta do Firebird só no modo cópia; textos neutros.

### 1.5.0 — 2026-11-10 (só `app.js`)

**Troca do Firebird com confirmação:** pergunta com as duas versões e o que vai acontecer ("Sim, trocar pelo 4.0" / "Agora não" / "Não perguntar mais"), oferecida quando o status mostra o Firebird daqui mais antigo; instalação nova já na versão do servidor; versões e botão de troca na aba Banco de dados.

### 1.4.0 — 2026-11-10 (só `app.js`)

**Confirmação do Atualizar/F5** no modo cópia, com mensagem clara (tipo de cópia, duração da última, efeito no servidor, próxima automática); cópia em andamento só avisa.

### 1.3.0 — 2026-11-10

**Andamento e senha opcional.** Barra de andamento da cópia (porcentagem e tempo que falta; indeterminada sem histórico ou na leitura instantânea); configuração inicial com nome da loja e senha opcional; "Criar a senha"/"Remover a senha" na aba Administrador; cópia salva em dia aparece como "Atualizado em"; campo de texto na janela de pergunta.

### 1.2.0 — 2026-11-10

**Foco, busca esperta e configuração inicial.** Foco de volta na busca 30 s após a última ação (tela principal); dica da busca e destaque das partes do coringa (filtro de preço não é destacado); opções de coringa e preço (*Consulta*), meta da busca, "Ver outros arquivos .FDB" e "Instalar o Firebird" (*Banco de dados*); na primeira abertura: senha → onde está o banco → Firebird, e só então a tela volta a ser pública; janela de pergunta com terceiro botão, lista de escolha e andamento sem botões.

### 1.1.0 — 2026-11-10

**Senha do administrador e quiosque.** Criação da senha na primeira abertura, abas protegidas com trava, janela de senha/confirmação, aba Windows, aba Administrador (trocar senha, exportar, pasta de dados, manutenção, reiniciar, sair), limpeza automática após 1 minuto sem mexer, cursor oculto quando parado, sem o botão de tela cheia, abas em duas linhas.

### 1.0.0 — 2026-11-09

**Primeira versão.** Busca grande com foco permanente para o leitor, cartão de preço, lista paginada com destaque dos termos, filtros guardados, exportação CSV, painel de configurações (modo de leitura, banco de dados, tela, diagnóstico com log ao vivo), temas claro/escuro/automático, modo leve, compatível com o Chromium 108.

---

## `src/motor.js`

Modos, atualização, cache em disco e auto-correção do banco.

### 1.6.0 — 2026-11-11

**Sem cópia repetida.** Pedido do relógio durante uma rodada é descartado; só Atualizar/F5 ou banco trocado (`invalidar()`) refazem depois. `status.temMinimo`; mensagens com `FB.mensagemDe`; textos neutros.

### 1.5.0 — 2026-11-10

**Versões do Firebird:** versão do servidor (`rdb$get_context('SYSTEM','ENGINE_VERSION')`, só leitura) e do gbak local, lidas também logo ao abrir; Firebird local mais antigo → método automático usa a cópia instantânea (método gbak explícito dá erro claro); `status.firebird`.

### 1.4.0 — 2026-11-10

**Estimativa da cópia no status** antes da primeira cópia desta abertura (lida do `copia.json` uma vez; relida se a pasta das cópias mudar).

### 1.3.0 — 2026-11-10

**Abertura rápida.** Cópia salva no prazo e do mesmo banco não é refeita ao abrir (agenda para o fim do prazo); cache descompactado de forma assíncrona; primeira atualização após 1,5 s; procura do gbak compartilhada; `ocupadoDesde` e método da cópia salva no status.

### 1.2.0 — 2026-11-10

**Busca, meta e outros .FDB.** Coringa e preço vindos do config na busca e na exportação; `status.buscaSemSmall`; `outrosFdb()` testa os outros `.FDB` e `usarBanco()` adota o escolhido (confere antes que abre e tem a tabela de produtos; vira escolha do usuário); `firebirdLocal()` e `redetectarFirebird()`; meta trocada procura de novo; busca de fundo de banco fora da meta no máximo a cada 30 min.

### 1.1.0 — 2026-11-10

**Caminho procurado no servidor conhecido.** Servidor sem caminho, caminho errado ou servidor trocado: o `SMALL.FDB` é procurado nesse servidor antes da busca geral (também com `fbHostFixo`); senha do administrador gravada só por `definirSenhaAdmin`.

### 1.0.0 — 2026-11-09

**Primeira versão.** Métodos gbak/instantâneo/direto, intervalo da cópia nunca menor que 3× a duração do gbak, nova tentativa com espera crescente (até 10 min), busca do banco quando o configurado falha (no máximo a cada 5 min) sobrescrevendo a configuração, nova busca da rede quando o banco foi adotado neste computador, produto lido aberto mesmo fora dos filtros, item ao vivo na leitura direta.

---

## `src/firebird.js`

Conexão Firebird somente leitura.

### 1.1.0 — 2026-11-11

**`mensagemDe()`:** o `AggregateError` do Node 18+ (IPv4 e IPv6 falharam, mensagem vazia) vira os motivos de cada tentativa; `tipoErro`/`explicarErro` usam esse texto. Textos neutros.

### 1.0.0 — 2026-11-09

**Primeira versão.** Trava de comando (`SELECT`/`WITH`) e de transação (READ COMMITTED + REC_VERSION, somente leitura, sem espera; lista no node-firebird 0.x), conexão e consulta com prazo, corte de socket, teste de porta, decodificação UTF-8 → Windows-1252 → latin1, erros em linguagem simples.

---

## `src/estoque-dados.js`

Leitura da tabela de produtos.

### 1.1.0 — 2026-11-11

**Textos neutros** (sem nomes de outros sistemas).

### 1.0.0 — 2026-11-09

**Primeira versão.** Papéis das colunas pelo catálogo (EAN do Small em `REFERENCIA`), texto como `OCTETS` com repetição sem ele, BLOB binário fora, situação ativo/inativo decidida pelos dados, releitura de um item, cache em disco validado, CSV protegido contra fórmula.

---

## `src/estoque-busca.js`

Regras da busca.

### 1.2.0 — 2026-11-11

**Sem totais** de estoque e de valor na pesquisa; textos neutros.

### 1.1.0 — 2026-11-10

**Coringa e preço.** `*` vale qualquer coisa dentro do mesmo campo (também sem "Contém" e na exclusão); `>valor`/`<valor` (e `>=`/`<=`) filtram pelo preço com o próprio valor incluído, aceitando `49,90`, `49.90`, `1.500,00` e `R$`; opções `coringa` e `preco`; `separarPreco` e `lerValor` exportados.

### 1.0.0 — 2026-11-09

**Primeira versão.** Termos, frase exata, exclusão com `-`, código com zeros à esquerda e filtros.

---

## `src/localizar-banco.js`

Descoberta automática do banco.

### 1.4.0 — 2026-11-11

**Textos e mensagens neutros**; os caminhos de pasta típicos continuam só na lista interna da busca.

### 1.3.0 — 2026-11-10

**Meta e varredura completa.** `cfg.metaBusca` ("local" testa esta máquina primeiro); subnet varrida antes das pastas compartilhadas, que incluem as listadas por `net view` de cada servidor (`compartilhamentosDe`/`extrairCompartilhamentos`); disco local mais fundo (10 níveis, 60 s); outros `.FDB` coletados no disco, nas pastas e no `.ini` (`montarOutros`) e abertos por `validarOutros`; `bancoAutoSuspeito` respeita a meta; `caminhosDoCompartilhamento` aceita qualquer `.FDB`.

### 1.2.0 — 2026-11-10

**SMALL.FDB nas pastas compartilhadas.** `buscarFdbNaRede` lista as pastas compartilhadas (UNC) atrás do `SMALL.FDB` — só a lista, nunca o arquivo —, com prazo por pasta (4 s), tempo total (20 s), limite de profundidade e de pastas, e só em servidor com a porta 445 aberta. `caminhosDoCompartilhamento` converte o UNC achado nos caminhos prováveis do disco do servidor (`\\SRV\C$\...` dá o exato), testados pelo Firebird dele. Nova etapa 1b em `localizar` e busca nas pastas do servidor em `caminhoNoServidor`. Compartilhamento desta máquina não vira servidor.

### 1.1.0 — 2026-11-10

**`caminhoNoServidor`:** procura o `SMALL.FDB` só num servidor já conhecido (caminhos típicos de C: a H: e o anterior), sem trocar o servidor.

### 1.0.0 — 2026-11-09

**Primeira versão.** Rede primeiro e `127.0.0.1` por último; só `SMALL.FDB`; pistas: `.ini`/`.cfg` locais, das unidades de rede e do compartilhamento do servidor, atalhos `.lnk` do sistema de gestão, nome `SERVIDOR`, varredura (LAN, Tailscale, 169.254); IPs e nome desta máquina nunca contam como servidor; leituras de rede com prazo; unidades de rede/CD fora da busca de `.FDB`.

---

## `src/caminhos.js`

Comparação de pastas do Windows.

### 1.0.0 — 2026-11-11

**Primeira versão.** `dentroDaPasta(pai, filho)`: sem diferenciar maiúsculas, funciona com a raiz de uma unidade e nunca casa uma pasta de outra unidade ou de nome parecido.

---

## `src/autoexcluir.js`

Ajudante que apaga a versão portátil depois que ela fecha.

### 1.0.0 — 2026-11-12

**Primeira versão.** Copiado para a pasta temporária e iniciado pelo `main.js` (Electron como Node): espera os processos (aplicativo, lançador do portátil, vigia; até 1 min), apaga o `.exe`, a pasta de dados, as cópias e os instaladores baixados (tentando por até 2 min), as sobras de aberturas antigas do portátil (`nsXXXX.tmp` com o pacote deste aplicativo) e a própria cópia; a pasta temporária atual é apagada pelo `cmd` uns segundos depois que ele fecha. Só módulos do Node.

---

## `src/instalar-firebird.js`

Instalação automática do Firebird neste computador.

### 1.2.0 — 2026-11-11

**Textos neutros.**

### 1.1.0 — 2026-11-10

**Versão do servidor e troca.** Pacotes 2.5.9, 3.0.13, 4.0.6 e 5.0.3 com SHA-256; `chaveParaVersao`, `localMaisAntiga`, `versaoDoGbak` (`gbak -z`), `acharDesinstalador`; troca numa só permissão do Windows (desinstalador antigo, espera ele terminar de verdade, instalador novo); ferramentas de administração no pacote (o gbak faltava na 1.0.0).

### 1.0.0 — 2026-11-10

**Primeira versão.** Baixa o Firebird 3.0.13 oficial (x64 ou Win32, conforme o Windows) seguindo redirecionamentos, com prazo sem dados e prazo total; confere tamanho e SHA-256 fixados; instala em silêncio como serviço (SuperServer, SYSDBA/masterkey, autenticação antiga liberada) pedindo a permissão do Windows; confere a porta 3050; reaproveita o instalador já baixado e íntegro.

---

## `src/copia-gbak.js`

Cópia por gbak.

### 1.2.0 — 2026-11-11

**Textos neutros.**

### 1.1.0 — 2026-11-10

**Andamento e gbak rápido.** Manifesto com a duração do backup e da restauração; `status()` com início, etapa e estimativas (manifesto lido uma vez por cópia); gbak dos serviços do Firebird pelo registro do Windows (`reg query`) em vez do PowerShell/WMI.

### 1.0.0 — 2026-11-09

**Primeira versão.** `gbak -b -g` + `gbak -c -mode read_only`, senha por variável de ambiente, prioridade abaixo do normal, troca atômica com manifesto, limpeza só de arquivos próprios, prazo e cancelamento, gbak localizado sozinho (serviço do Firebird em execução primeiro).

---

## `src/config.js`

Configuração validada.

### 1.4.0 — 2026-11-11

**Padrões novos:** `metodoCopia` "instantaneo", `aceleracaoGrafica` desligada e `volumeSom` (público). Migração única (`versaoConfig` 3): "auto" → "instantaneo" e aceleração desligada.

### 1.3.0 — 2026-11-10

**`configInicial`** (interna): configuração inicial feita.

### 1.2.0 — 2026-11-10

**Chaves novas:** `buscaCoringa`, `buscaPreco`, `metaBusca`, `perguntarFirebird` e `versaoConfig` (interna). `ocultarBarraTarefas` ligada por padrão e migrada uma vez em config.json antigo.

### 1.1.0 — 2026-11-10

**Quiosque e administrador.** Chaves do Windows, `senhaAdmin` só como *hash* PBKDF2 (`gerarHashSenha`/`conferirSenha` em tempo constante), lista de chaves sensíveis (`sensiveisAlteradas`), cópia a cada 3 horas por padrão, `limparAposSeg` no lugar de `fecharDetalheSeg`, `telaCheia` removida.

### 1.0.0 — 2026-11-09

**Primeira versão.** Padrões, faixas e listas de valores aceitos, gravação atômica, `config.json` estragado guardado à parte.

---

## `src/vigia.js`

Persistência do quiosque.

### 1.1.0 — 2026-11-10

**Reabre em 1 a 2 s.** Confere a cada 1 s; espera o prazo longo (15 s) só com o aviso `reiniciando` do aplicativo ou logo depois de reabrir (o aplicativo novo ainda grava o PID).

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

### 1.2.0 — 2026-11-11

**Textos neutros.**

### 1.1.0 — 2026-11-10

**Versão do Firebird simulada** (`versao` no banco de exemplo responde a `ENGINE_VERSION`).

### 1.0.0 — 2026-11-09

**Primeira versão.** Usado pelos testes e pelo modo `--demo`.

---

## `electron-builder.config.js`

Geração do instalador e da versão portátil.

### 1.1.0 — 2026-11-11

**Desinstalador sem rastros:** `deleteAppDataOnUninstall` e `build/instalador.nsh`.

### 1.0.0 — 2026-11-09

**Primeira versão.** Variante moderna (Electron 44, Windows 10/11 x64) e legado (Electron 22.3.27, Windows 7 a 11 x64 e ia32).

---

## `build/instalador.nsh`

Passos extras do desinstalador.

### 1.0.0 — 2026-11-11

**Primeira versão.** Avisa o vigia para encerrar; numa desinstalação de verdade (não numa atualização), tira o início com o Windows e apaga as cópias do banco (`ProgramData\ConsultaEstoqueDesktop`) e os instaladores do Firebird baixados.

---

## `gerar-instalador.bat`

Gera os instaladores com dois cliques.

### 1.0.0 — 2026-11-09

**Primeira versão.**

---

## `.github/workflows/build.yml`

CI.

### 1.4.0 — 2026-11-12

**`SHA256SUMS.txt` na Release** com a impressão digital de cada `.exe`, e no texto da Release como conferir no PowerShell (`Get-FileHash`) — para quem receber "Installer integrity check has failed" (download estragado).

### 1.3.0 — 2026-11-10

**Instaladores à prova de rede instável e texto da Release atualizado.** Até 3 tentativas para gerar os instaladores (uma queda de conexão no download do Electron derrubou a publicação da 1.5.0), downloads do Electron/electron-builder guardados em cache entre execuções e texto da Release com a configuração inicial atual (nome da loja e senha opcionais; sair com Ctrl+Shift+Q e a senha, se houver).

### 1.2.0 — 2026-11-10

**Release automática a cada versão nova na `main`:** cria a tag `v<versão do package.json>` e publica os instaladores e as versões portáteis. Release que já tem todos os arquivos é pulada; se faltar algum (envio interrompido), é completada. Tag `v*` enviada à mão ou disparo manual numa tag continuam publicando.

### 1.1.0 — 2026-11-10

**Release automática:** com tag `v*`, publica os instaladores e as versões portáteis (moderna e legado) numa Release do GitHub. O teste de abertura grava o log do Chromium e, se a 1ª abertura cair (máquina virtual sem placa de vídeo), exige que a 2ª abra no modo seguro.

### 1.0.0 — 2026-11-09

**Primeira versão.** Testes no Linux; instaladores no Windows (moderno e legado), com teste de abertura do aplicativo empacotado em modo demonstração.
