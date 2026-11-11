; instalador.nsh - Consulta Estoque
; @version 1.0.0
; @author Ruda Gabriel
; Desinstalador sem deixar rastros (a pasta de dados ja sai pelo deleteAppDataOnUninstall):
;   - avisa o vigia (persistencia) para encerrar antes de tudo;
;   - tira o inicio junto com o Windows (chave Run do usuario);
;   - apaga as copias do banco (ProgramData) e os instaladores do Firebird baixados.
; Numa ATUALIZACAO (isUpdated) nada disso e apagado.
; Historico completo das versoes: CHANGELOG.md no repositorio.

!macro customUnInit
  ; O vigia encerra sozinho ao ver o arquivo "saida-autorizada" na pasta de dados.
  SetShellVarContext current
  IfFileExists "$APPDATA\Consulta Estoque\*.*" 0 +5
    FileOpen $0 "$APPDATA\Consulta Estoque\saida-autorizada" w
    FileWrite $0 "desinstalador"
    FileClose $0
    Sleep 2000
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "br.rudagabriel.consultaestoque"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Consulta Estoque"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Consulta Estoque"
    ReadEnvStr $1 PROGRAMDATA
    StrCmp $1 "" +2 0
      RMDir /r "$1\ConsultaEstoqueDesktop"
    RMDir /r "$TEMP\ConsultaEstoque-firebird"
  ${endIf}
!macroend
