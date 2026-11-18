import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explainYtDlpError } from '../lib/ytdlp.js';

/**
 * Raw yt-dlp stderr is accurate but reads as a crash. These are the real
 * messages seen while testing, mapped to something the user can act on.
 */
describe('explainYtDlpError', () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      'canal sin emitir',
      'ERROR: [kick:live] xqc: The channel is not currently live',
      /no está emitiendo/i,
    ],
    [
      'pide iniciar sesión',
      'ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies',
      /iniciar sesión/i,
    ],
    [
      'enlace muerto',
      'ERROR: [generic] noexiste: Unable to download webpage: HTTP Error 404: Not Found',
      /no existe/i,
    ],
    [
      'rechazo del sitio',
      'ERROR: unable to download video data: HTTP Error 403: Forbidden',
      /rechazó la descarga/i,
    ],
    [
      'video privado',
      'ERROR: Private video. Sign in if you have been granted access',
      /privado|iniciar sesión/i,
    ],
    ['video borrado', 'ERROR: Video unavailable. This video has been removed', /ya no está disponible/i],
    ['restricción de edad', 'ERROR: Sign in to confirm your age', /edad|iniciar sesión/i],
    ['bloqueo por país', 'ERROR: The uploader has not made this video available in your country', /país/i],
    ['sitio desconocido', 'ERROR: Unsupported URL: https://ejemplo.com/algo', /No reconozco ese enlace/i],
    ['sin formato', 'ERROR: Requested format is not available', /formato/i],
  ];

  for (const [name, raw, expected] of cases) {
    test(name, () => {
      const friendly = explainYtDlpError(raw);
      assert.ok(friendly, `no se tradujo: ${raw}`);
      assert.match(friendly, expected);
      assert.ok(!friendly.includes('ERROR:'), 'quedó texto crudo de yt-dlp');
    });
  }

  test('un 404 no culpa a la conexión del usuario', () => {
    // Antes caía en el patrón genérico de red y decía "revisa tu internet",
    // mandando a mirar donde no era.
    const friendly = explainYtDlpError('Unable to download webpage: HTTP Error 404: Not Found');
    assert.doesNotMatch(friendly!, /internet/i);
  });

  test('deja pasar lo que no reconoce en vez de inventar una causa', () => {
    assert.equal(explainYtDlpError('ERROR: algo totalmente nuevo y raro'), null);
  });
});
