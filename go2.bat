@echo off
setlocal
cd /d "%~dp0"

set ORG=did:t3n:434282fc9397e31f83ed6d04a209d2cc3015c9ea
set AGENT2=did:t3n:7faab43505230f804071b6f271580b7d648056d4
set T3ENV=testnet
set CLI=node_modules\@terminal3\t3n-sdk\dist\cli\index.js

if "%T3N_API_KEY%"=="" (
  echo ERROR: T3N_API_KEY is not set in this window.
  echo Run:  set T3N_API_KEY=0x...
  goto :end
)

echo ============================================================
echo [1/3] baseline collect
echo ============================================================
call node ledger.js
echo.

echo ============================================================
echo [2/3] publish second agent card -- answer y when prompted
echo ============================================================
call node "%CLI%" agent card-publish --owner %ORG% --agent %AGENT2% --env %T3ENV%
echo.

echo ============================================================
echo [3/3] collect again - expect spend + reconciliation warning
echo ============================================================
call node ledger.js

echo.
echo DONE. Copy everything above.

:end
endlocal
