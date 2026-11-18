@echo off
setlocal enabledelayedexpansion
title Extractor de Clips Virales
cd /d "%~dp0"

echo.
echo   ============================================
echo     EXTRACTOR DE CLIPS VIRALES
echo   ============================================
echo.

REM --- Node.js -----------------------------------------------------------
REM El paquete trae su propio node.exe en bin\node, asi que en un equipo
REM nuevo no hace falta instalar nada. Si falta, se usa el del sistema.
set "NODE=%~dp0bin\node\node.exe"
if not exist "%NODE%" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo   [!] No se encontro Node.js.
        echo.
        echo   Esta carpeta deberia traerlo en bin\node\node.exe. Si lo borraste,
        echo   instala la version LTS desde la pagina que voy a abrir y vuelve a
        echo   ejecutar INICIAR.bat.
        echo.
        pause
        start "" "https://nodejs.org/es/download"
        exit /b 1
    )
    set "NODE=node"
)

REM Lo incluido va primero en el PATH: asi yt-dlp y el servidor usan las
REM mismas herramientas que vienen en la carpeta, no otras del equipo.
set "PATH=%~dp0bin\node;%~dp0bin;%PATH%"

echo   Node.js:
"%NODE%" -v

REM --- Dependencias ------------------------------------------------------
REM Vienen incluidas en node_modules. Solo se instalan si faltan.
if not exist "node_modules\tsx\dist\cli.mjs" (
    echo.
    echo   Faltan las dependencias: instalando, solo pasa una vez.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [!] Fallo la instalacion de dependencias. Revisa tu conexion.
        echo.
        pause
        exit /b 1
    )
)

REM --- FFmpeg, Whisper y yt-dlp ---------------------------------------------
REM No vienen en el repositorio (pesan casi 2 GB). La primera vez se bajan
REM solos; las siguientes este paso no hace nada y termina al instante.
"%NODE%" scripts\instalar.mjs
if errorlevel 1 (
    echo.
    echo   [!] No se pudo terminar la descarga de los programas necesarios.
    echo       Revisa tu conexion y vuelve a abrir INICIAR.bat.
    echo.
    pause
    exit /b 1
)

if exist "bin\ffmpeg.exe" (
    echo   FFmpeg listo.
) else (
    echo   [!] Falta bin\ffmpeg.exe: sin el no se puede transcribir ni exportar.
)

if exist "bin\whisper\whisper-cli.exe" (
    echo   Whisper listo.
) else if exist "bin\whisper\main.exe" (
    echo   Whisper listo.
) else (
    echo   [!] Falta bin\whisper: sin el no se puede transcribir.
)

REM --- Tarjeta grafica ---------------------------------------------------
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [i] No hay tarjeta NVIDIA: se transcribe con el procesador.
    echo       Funciona, pero tarda mas: una hora de video, unos 40-60 minutos.
    echo.
) else (
    echo   Tarjeta NVIDIA detectada: transcripcion rapida.
)

REM --- yt-dlp al dia -----------------------------------------------------
REM YouTube cambia a menudo y un yt-dlp con dos meses ya falla con algunos
REM videos. Si no hay internet simplemente se sigue con el que hay.
echo   Actualizando yt-dlp...
"bin\yt-dlp.exe" -U >nul 2>&1

REM --- Ollama ------------------------------------------------------------
REM Es lo que elige los mejores momentos, ajusta donde termina cada idea y
REM escribe titulos y captions. Sin el la app funciona, pero peor.
set "OLLAMA="
where ollama >nul 2>&1
if not errorlevel 1 set "OLLAMA=ollama"
if not defined OLLAMA if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if not defined OLLAMA (
    echo.
    echo   [!] Ollama no esta instalado.
    echo       Sin el, los clips se eligen solo por senales del audio y los
    echo       titulos salen de plantilla. Con el, salen mucho mejores.
    echo.
    echo       Instalalo desde la pagina que se puede abrir ahora y vuelve a
    echo       ejecutar INICIAR.bat: el modelo se descargara solo.
    echo.
    choice /c SN /m "   Abrir la pagina de descarga de Ollama"
    if !errorlevel! equ 1 start "" "https://ollama.com/download/windows"
    echo.
    goto arrancar
)

"%OLLAMA%" list >nul 2>&1
if errorlevel 1 (
    echo   Encendiendo Ollama...
    start "" /min "%OLLAMA%" serve
    timeout /t 5 /nobreak >nul
)

"%OLLAMA%" list 2>nul | findstr /i /c:"qwen2.5:7b" >nul
if errorlevel 1 (
    echo.
    echo   Descargando el modelo de lenguaje qwen2.5:7b.
    echo   Son unos 4.7 GB y solo pasa la primera vez.
    echo.
    "%OLLAMA%" pull qwen2.5:7b
) else (
    echo   Ollama y qwen2.5:7b listos.
)

:arrancar
REM --- Arranque ----------------------------------------------------------
echo.
echo   Iniciando servidor...
echo   Se abrira solo en tu navegador. Para cerrar: cierra esta ventana.
echo   Mientras analizas, cierra juegos: comparten la tarjeta grafica.
echo.

start "" /b cmd /c "timeout /t 6 /nobreak >nul && start "" http://localhost:3000"

"%NODE%" node_modules\tsx\dist\cli.mjs server.ts

echo.
echo   El servidor se ha detenido.
pause
