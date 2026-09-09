@echo off
setlocal EnableExtensions DisableDelayedExpansion

if not "%ELECTRON_RUN_AS_NODE%"=="1" (
  >&2 echo ELECTRON_RUN_AS_NODE=1 is required.
  exit /b 127
)

if "%CODEX_MCP_NODE_PATH%"=="" (
  >&2 echo CODEX_MCP_NODE_PATH is required.
  exit /b 127
)

if "%~1"=="" (
  >&2 echo Expected exactly one bridge script argument.
  exit /b 64
)

"%CODEX_MCP_NODE_PATH%" "%~f1"
