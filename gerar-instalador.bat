@echo off
:: =====================================================================
::  gerar-instalador.bat                                         v1.0.0
::  Autor: Ruda Gabriel
::  Gera o instalador e a versao portatil do Consulta Estoque com dois
::  cliques (precisa do Node.js 20 ou mais novo e de internet na 1a vez).
::  Os arquivos ficam na pasta "dist".
:: =====================================================================
setlocal
chcp 65001 >nul
pushd "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [ERRO] Node.js nao encontrado. Instale o Node.js LTS em https://nodejs.org
  echo         e execute este arquivo de novo.
  echo.
  pause
  popd
  exit /b 1
)
echo.
echo  Escolha a versao:
echo    1 = Windows 10/11 (64 bits)            [recomendado]
echo    2 = Windows 7, 8, 10 e 11 (64 e 32 bits) - PCs antigos
echo    3 = As duas
echo.
set "OPC="
set /p OPC=" Opcao [1]: "
if "%OPC%"=="" set "OPC=1"
echo.
echo  Instalando as dependencias (so demora na primeira vez)...
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo  [ERRO] Falha ao instalar as dependencias. Veja as mensagens acima.
  pause
  popd
  exit /b 1
)
if "%OPC%"=="1" goto moderno
if "%OPC%"=="3" goto moderno
goto legado
:moderno
set "VARIANTE=moderno"
call npx electron-builder --config electron-builder.config.js --win nsis portable --x64 --publish never
if errorlevel 1 goto falhou
if "%OPC%"=="1" goto fim
:legado
set "VARIANTE=legado"
call npx electron-builder --config electron-builder.config.js --win nsis portable --x64 --ia32 --publish never
if errorlevel 1 goto falhou
:fim
echo.
echo  Pronto! Os arquivos estao na pasta "dist".
start "" "%~dp0dist"
pause
popd
exit /b 0
:falhou
echo.
echo  [ERRO] A geracao falhou. Veja as mensagens acima.
pause
popd
exit /b 1
