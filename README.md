# Extractor de Clips Virales

Convierte videos largos y **directos en vivo** en clips verticales 9:16 listos
para TikTok, Reels y Shorts: encuentra los momentos con gancho, los recorta en
vertical siguiendo a quien habla, quema subtítulos animados y exporta MP4.

**Todo corre en tu computador.** No hay cuentas, claves de API ni nube: la
transcripción la hace Whisper y la elección de momentos un modelo local con
Ollama. Internet solo se usa para bajar videos de enlaces y la primera
instalación.

---

## Instalar (Windows 10/11, 64 bits)

1. Instala **[Node.js LTS](https://nodejs.org/es/download)**.
2. Instala **[Ollama](https://ollama.com/download/windows)** (recomendado: sin
   él la app funciona, pero elige peor los momentos y los títulos salen de
   plantilla).
3. Descarga este repositorio (botón verde **Code → Download ZIP**, y
   descomprímelo) o clónalo:
   ```bash
   git clone https://github.com/cinematicforever09-eng/extractor-clips-virales.git
   ```
4. Doble clic en **`INICIAR.bat`**.

La **primera vez** se descarga solo lo que no cabe en el repositorio:

| Qué | Para qué | Tamaño |
|---|---|---|
| yt-dlp | bajar videos y directos de YouTube, Twitch, Kick y +1700 sitios | 18 MB |
| FFmpeg (build GPL de BtbN) | exportar y quemar subtítulos | ~200 MB |
| whisper.cpp | transcribir; versión CUDA si hay tarjeta NVIDIA (~650 MB), si no la de procesador (~9 MB) | |
| Modelo `large-v3-turbo` | el modelo de voz | 1,6 GB |
| Detector de voz Silero | que Whisper no invente palabras en los silencios | 1 MB |
| `qwen2.5:7b` en Ollama | elegir momentos y escribir títulos | 4,7 GB |

Después la app se abre sola en **http://localhost:3000**. Las siguientes veces
arranca en segundos.

**Velocidad:** con tarjeta NVIDIA una hora de video se analiza en ~3 minutos;
solo con procesador, ~40-60 minutos.

---

## Qué hace

### Videos ya grabados
Pega un enlace o sube un archivo. La app transcribe, propone **10 clips** (y
otros 10 distintos si vuelves a subir el mismo video), los ordena por gancho,
idea completa y valor, y deja ajustar cada uno antes de exportar, o exportar
todos de una vez.

### En directo 🔴
Pestaña **En directo**: pega el enlace de un directo de YouTube, Twitch o Kick.
La app lo **graba mientras transmite** y cada ~3 minutos revisa lo nuevo:
- Solo saca un clip si el momento es **llamativo** (gancho fuerte e idea
  completa). Puedes elegir qué tan exigente es: alta, media o baja.
- Espera a que la idea termine antes de cortar, nunca a media frase.
- **Exporta cada clip al instante** a la carpeta `clips-en-vivo/`.
- Al terminar borra la grabación y deja solo los clips.

### Encuadre vertical
- **Automático** (en directo): mira si es gente hablando o un videojuego.
- **Persona hablando:** marcas a la persona con un clic y el clip la sigue a
  pantalla completa.
- **Dos personas:** una arriba y otra abajo (entrevistas, pódcast).
- **Streamer + juego:** el juego arriba y la webcam del jugador abajo. Al hacer
  clic en la webcam, la app encuentra su borde exacto; en modo Automático la
  encuentra sola.
- Si el video **cambia de cámara**, las tomas de otra cámara se muestran
  completas en vez de recortar un pedazo vacío.

### Subtítulos
Seis estilos. El predeterminado, **Recuadro por palabra**, usa letras blancas
(Montserrat) y un recuadro de color que salta a la palabra que se dice; el
color se elige solo para que contraste con el video.

### Además
- **Marca de agua:** sube tu logo en PNG y elige tamaño, posición y opacidad.
- **Volumen parejo:** todos los clips salen a −14 LUFS, el nivel de las redes.
- **Quitar silencios y muletillas** de un clip.
- Detección de idioma por muestras, para que un video en español no salga
  transcrito en otro idioma.

---

## Problemas comunes

- **No abre el navegador:** entra tú a http://localhost:3000.
- **Un enlace de YouTube no descarga:** cierra y vuelve a abrir `INICIAR.bat`
  (actualiza yt-dlp al arrancar).
- **"Modelo local saturado":** cierra los juegos; comparten la tarjeta gráfica
  con el modelo.
- **Subtítulos en otro idioma:** elige el idioma antes de analizar.
- **Falló la primera descarga:** vuelve a abrir `INICIAR.bat`; lo que ya se
  bajó no se repite.

## Ajustes opcionales

Copia `.env.example` a `.env` para cambiar rutas (FFmpeg, Whisper, yt-dlp),
el modelo de Ollama o el puerto.

## Para desarrolladores

```bash
npm install
node scripts/instalar.mjs   # baja FFmpeg, Whisper y yt-dlp a bin/
npm run dev                 # servidor + interfaz en http://localhost:3000
npm test                    # pruebas de la lógica (sin dependencias extra)
npm run lint                # comprobación de tipos
```

Estructura: `server.ts` (API y servidor), `lib/` (transcripción, búsqueda de
clips, reencuadre, subtítulos ASS, exportación con FFmpeg, modo directo),
`components/` (interfaz React), `tests/`.

## Créditos y licencias

Código bajo licencia **MIT** (ver `LICENSE`). Usa, sin incluirlos en el
repositorio: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense),
[FFmpeg](https://ffmpeg.org) en el build de
[BtbN](https://github.com/BtbN/FFmpeg-Builds) (GPL),
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) y
[Ollama](https://ollama.com). Incluye la fuente
[Montserrat](https://github.com/JulietaUla/Montserrat) (SIL Open Font License,
ver `fonts/OFL.txt`).

Descarga solo contenido que tengas derecho a usar.
