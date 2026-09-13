@echo off
setlocal
cd /d "%~dp0"

set ORG=did:t3n:434282fc9397e31f83ed6d04a209d2cc3015c9ea
set AGENT=did:t3n:5957c0a2b1c1b52f94adf51a24338ce8ec76682f
set T3ENV=testnet

if "%T3N_API_KEY%"=="" (
  echo ERROR: T3N_API_KEY is not set in this window.
  echo Run:  set T3N_API_KEY=0x...
  goto :end
)

echo ============================================================
echo [1/4] agent card-get
echo ============================================================
call npx @terminal3/t3n-sdk agent card-get --owner %ORG% --agent %AGENT% --env %T3ENV%
echo.

echo ============================================================
echo [2/4] agent registry --full
echo ============================================================
call npx @terminal3/t3n-sdk agent registry %AGENT% --full --env %T3ENV%
echo.

echo ============================================================
echo [3/4] agent card-publish   -- answer y when prompted
echo ============================================================
call npx @terminal3/t3n-sdk agent card-publish --owner %ORG% --agent %AGENT% --env %T3ENV%
echo.

echo ============================================================
echo [4/4] ledger collect
echo ============================================================
call node ledger.js

echo.
echo DONE. Copy everything above.

:end
endlocal
