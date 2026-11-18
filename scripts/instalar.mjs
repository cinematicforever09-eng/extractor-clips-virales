#!/usr/bin/env node
/**
 * Descarga lo que la app necesita y no cabe en el repositorio.
 *
 * INICIAR.bat lo ejecuta cada vez; si todo ya está en bin/, no hace nada y
 * termina al instante. La primera vez baja, según el equipo:
 *
 *   bin/yt-dlp.exe                 descargas de YouTube, Twitch, Kick...
 *   bin/ffmpeg.exe, ffprobe.exe    exportar (build GPL de BtbN: trae libass,
 *                                  que es lo que quema los subtítulos)
 *   bin/whisper/                   whisper.cpp; con tarjeta NVIDIA la versión
 *                                  CUDA (unos 650 MB), si no la de procesador
 *   bin/whisper/ggml-large-v3-turbo.bin   el modelo de voz (1,6 GB)
 *   bin/whisper/ggml-silero-v5.1.2.bin    detector de voz (VAD, 1 MB)
 *
 * Sin dependencias de npm: solo Node 18+ (fetch) y PowerShell para descomprimir.
 * Las versiones están fijadas para que una actualización de un tercero no
 * rompa la app de golpe; yt-dlp es la excepción, porque YouTube cambia a
 * menudo y INICIAR.bat lo actualiza aparte.
 */

import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin');
const whisperDir = path.join(bin, 'whisper');

const WHISPER_TAG = 'b5454';
const URLS = {
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  whisperCuda: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-win-cuda-12.4.0-x64.zip`,
  whisperCpu: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`,
  model: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  vad: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
};

const exists = (p) => access(p).then(() => true, () => false);
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/** Descarga con barra de progreso a un archivo .part, que se renombra al final. */
async function download(url, dest, label) {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'extractor-clips-virales-instalador' } });
  if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${label} (${res.status}).`);

  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPrint = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 500) {
      lastPrint = now;
      const pct = total ? ` ${Math.floor((done / total) * 100)}%` : '';
      process.stdout.write(`\r   ${label}: ${mb(done)}${total ? ` de ${mb(total)}` : ''}${pct}   `);
    }
  });
  await pipeline(source, createWriteStream(part));
  process.stdout.write(`\r   ${label}: listo (${mb(done)})                         \n`);
  await rename(part, dest);
}

/** Descomprime un .zip con PowerShell, que trae Windows de serie. */
function unzip(zip, dest) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error(`No se pudo descomprimir ${path.basename(zip)}.`);
}

/** Busca un archivo por nombre dentro de una carpeta descomprimida. */
async function find(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await find(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function hasNvidia() {
  return spawnSync('nvidia-smi', ['-L'], { stdio: 'ignore' }).status === 0;
}

async function ytdlp() {
  const dest = path.join(bin, 'yt-dlp.exe');
  if (await exists(dest)) return;
  console.log('\n  Descargando yt-dlp (para bajar videos y directos)...');
  await download(URLS.ytdlp, dest, 'yt-dlp');
}

async function ffmpeg() {
  if ((await exists(path.join(bin, 'ffmpeg.exe'))) && (await exists(path.join(bin, 'ffprobe.exe')))) return;
  console.log('\n  Descargando FFmpeg (para exportar los clips con subtítulos)...');
  const work = await mkdtemp(path.join(tmpdir(), 'ecv-ffmpeg-'));
  try {
    const zip = path.join(work, 'ffmpeg.zip');
    await download(URLS.ffmpeg, zip, 'FFmpeg');
    unzip(zip, work);
    for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
      const found = await find(work, exe);
      if (!found) throw new Error(`El paquete de FFmpeg no trae ${exe}.`);
      await copyFile(found, path.join(bin, exe));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function whisper() {
  await mkdir(whisperDir, { recursive: true });
  const haveBinary =
    (await exists(path.join(whisperDir, 'whisper-cli.exe'))) || (await exists(path.join(whisperDir, 'main.exe')));

  if (!haveBinary) {
    const gpu = hasNvidia();
    console.log(
      gpu
        ? '\n  Tarjeta NVIDIA detectada: descargando Whisper con aceleración CUDA (unos 650 MB)...'
        : '\n  Sin tarjeta NVIDIA: descargando Whisper para procesador...'
    );
    const work = await mkdtemp(path.join(tmpdir(), 'ecv-whisper-'));
    try {
      const zip = path.join(work, 'whisper.zip');
      await download(gpu ? URLS.whisperCuda : URLS.whisperCpu, zip, 'Whisper');
      unzip(zip, work);
      const cli = await find(work, 'whisper-cli.exe');
      if (!cli) throw new Error('El paquete de Whisper no trae whisper-cli.exe.');
      // Todo lo que viene junto al ejecutable (DLL de ggml y, en la versión
      // CUDA, las de cuBLAS) tiene que quedar en la misma carpeta.
      for (const file of await readdir(path.dirname(cli))) {
        const from = path.join(path.dirname(cli), file);
        if ((await stat(from)).isFile()) await copyFile(from, path.join(whisperDir, file));
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  const model = path.join(whisperDir, 'ggml-large-v3-turbo.bin');
  if (!(await exists(model))) {
    console.log('\n  Descargando el modelo de voz large-v3-turbo (1,6 GB, solo esta vez)...');
    await download(URLS.model, model, 'Modelo de voz');
  }

  const vad = path.join(whisperDir, 'ggml-silero-v5.1.2.bin');
  if (!(await exists(vad))) {
    console.log('\n  Descargando el detector de voz (evita palabras inventadas en silencios)...');
    await download(URLS.vad, vad, 'Detector de voz');
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(
      '  Este instalador es para Windows. En macOS o Linux instala ffmpeg, yt-dlp y\n' +
        '  whisper.cpp con tu gestor de paquetes y define FFMPEG_PATH, YTDLP_PATH,\n' +
        '  WHISPER_PATH y WHISPER_MODEL (ver .env.example).'
    );
    return;
  }
  await mkdir(bin, { recursive: true });
  await ytdlp();
  await ffmpeg();
  await whisper();
}

main().catch((error) => {
  console.error(`\n  [!] ${error.message}`);
  console.error('      Revisa tu conexión y vuelve a abrir INICIAR.bat: lo que ya se bajó no se repite.');
  process.exit(1);
});
