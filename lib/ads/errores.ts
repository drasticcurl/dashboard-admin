/**
 * Catálogo de errores de la Marketing API (task 9.1 de gestion-campanas-anuncios).
 * PURA: sin `pg` y sin red, para que lo usen el Endpoint_Acciones (que arma la
 * respuesta) y el Gestor_Anuncios (que la muestra). Traduce código y subcódigo
 * de Meta a un mensaje en castellano que dice QUÉ pasó y QUÉ hacer (R16 c9), y
 * declara si el error corta el lote.
 *
 * Tres reglas que este catálogo respeta (design §Error Handling):
 * 1. El mensaje NUNCA lleva la URL ni el token (R17 c9). Son plantillas fijas.
 * 2. El código de Meta es dato secundario dentro del detalle del objeto
 *    (R16 c9), nunca el mensaje principal.
 * 3. Lo NO VERIFICADO se declara con `verificado: false` y NO matchea: hasta que
 *    `scripts/verificar-copies-ads.ts` confirme el código real contra
 *    META_API_VERSION, ese error cae en la fila «sin mapear», que no corta el
 *    lote. Cortar por un código mal adivinado deja objetos sin procesar sin
 *    motivo. Las tres filas verificadas (100/3858079, 100/3858081, 613) son las
 *    que requirements.md confirmó contra fuentes.
 */

import type { NivelAds } from './tipos';

export type Corte = 'token_vencido' | 'cuota' | 'cupo_objetos' | null;

export type ContextoError = {
  objectId: string;
  objectName: string | null;
  nivel: NivelAds;
  accountId: string;
  /** Datos que algunas entradas interpolan (la de cuota nombra los conteos). */
  contexto?: {
    confirmadas?: number;
    noIntentadas?: number;
    backoffSegundos?: number;
  };
};

export type EntradaError = {
  /** Código de Meta. null = coincidencia por subcódigo, por estado HTTP o por red. */
  codigo: number | null;
  subcodigo?: number;
  /** Coincidencia adicional por texto del mensaje, cuando el código es genérico. */
  mensajeIncluye?: readonly string[];
  /** Coincidencia por "no hay código y es un error de red/timeout" (indeterminado). */
  transient?: boolean;
  /** Coincidencia por "no hay código y el estado HTTP es ≥ 500 sin cuerpo". */
  httpStatusMin?: number;
  /** Qué pasó y qué hacer. Sin URL, sin token, sin JSON de Meta. */
  castellano: (ctx: ContextoError) => string;
  /** confirmado nunca; fallido = Meta procesó y rechazó; indeterminado = no se sabe. */
  clasifica: 'fallido' | 'indeterminado';
  corta: Corte;
  /** Confirmado contra las fuentes de requirements.md, o pendiente de verificación. */
  verificado: boolean;
};

export type ErrorTraducido = {
  mensaje: string;
  codigoMeta: number | null;
  clasifica: 'fallido' | 'indeterminado';
  corta: Corte;
};

const nombre = (ctx: ContextoError): string => ctx.objectName ?? ctx.objectId;

const ETIQUETA_NIVEL: Record<NivelAds, string> = {
  campaign: 'campaña',
  adset: 'conjunto',
  ad: 'anuncio',
};

// Los substrings del error 100 de tope de objetos están A VERIFICAR: el código
// 100 es genérico y el texto exacto lo confirma scripts/verificar-copies-ads.ts
// (D-02). Mientras `verificado` esté en false esta fila NO matchea y el error
// cae en «sin mapear», que no corta el lote (regla 3).
const MENSAJE_TOPE_OBJETOS = [
  'exceeded the limit',
  'maximum number of',
  'object limit',
  'ad limit',
  'máximo de',
] as const;

export const CATALOGO_ERRORES: readonly EntradaError[] = [
  {
    codigo: 100,
    subcodigo: 3858079,
    castellano: (ctx) =>
      `Falta el pagador del DSA en la cuenta. Meta lo exige para copiar conjuntos que segmentan la Unión Europea. Cargalo una vez en el administrador de anuncios y volvé a intentar. Objeto afectado: «${nombre(ctx)}» (${ctx.objectId}).`,
    clasifica: 'fallido',
    corta: null,
    verificado: true,
  },
  {
    codigo: 100,
    subcodigo: 3858081,
    castellano: (ctx) =>
      `Falta el beneficiario del DSA en la cuenta. Mismo caso que el pagador: se carga una vez en el administrador de anuncios. Objeto afectado: «${nombre(ctx)}» (${ctx.objectId}).`,
    clasifica: 'fallido',
    corta: null,
    verificado: true,
  },
  {
    codigo: 613,
    castellano: (ctx) => {
      const confirmadas = ctx.contexto?.confirmadas ?? 0;
      const noIntentadas = ctx.contexto?.noIntentadas ?? 0;
      const segundos = ctx.contexto?.backoffSegundos;
      return (
        `Meta cortó por cuota de la API. No se intentaron las duplicaciones restantes y no hay reintento automático. ` +
        `Se confirmaron ${confirmadas} copias y quedaron ${noIntentadas} sin intentar.` +
        (typeof segundos === 'number' ? ` Volvé a intentar en ${segundos} segundos.` : '')
      );
    },
    clasifica: 'fallido',
    corta: 'cuota',
    verificado: true,
  },
  {
    // A VERIFICAR (D-02): si la versión configurada no usa 190 para el token
    // vencido, esta fila se corrige con la salida de verificar-copies-ads.ts.
    codigo: 190,
    castellano: () =>
      'El token de acceso venció o dejó de ser válido. Hay que renovarlo. No se intentó nada más del lote.',
    clasifica: 'fallido',
    corta: 'token_vencido',
    verificado: false,
  },
  {
    // A VERIFICAR (D-02): cuota de usuario. Corta igual que el 613.
    codigo: 17,
    castellano: () =>
      'Meta cortó por cuota de usuario. Igual que el 613: el lote se detuvo y no hay reintento automático.',
    clasifica: 'fallido',
    corta: 'cuota',
    verificado: false,
  },
  {
    // A VERIFICAR (D-02): código 100 con texto de tope de objetos.
    codigo: 100,
    mensajeIncluye: MENSAJE_TOPE_OBJETOS,
    castellano: (ctx) =>
      `La cuenta alcanzó su máximo de objetos en el nivel ${ETIQUETA_NIVEL[ctx.nivel]}. Hay que liberar objetos en la cuenta antes de duplicar. El lote se detuvo.`,
    clasifica: 'fallido',
    corta: 'cupo_objetos',
    verificado: false,
  },
  {
    codigo: 2,
    castellano: () =>
      'Meta tuvo un problema temporal. No se sabe si el cambio se aplicó: se resuelve cuando corra la reconciliación.',
    clasifica: 'indeterminado',
    corta: null,
    verificado: true,
  },
  {
    codigo: null,
    httpStatusMin: 500,
    castellano: () =>
      'Meta respondió con un error de servidor sin detalle. No se sabe si el cambio se aplicó.',
    clasifica: 'indeterminado',
    corta: null,
    verificado: true,
  },
  {
    codigo: null,
    transient: true,
    castellano: () =>
      'El pedido no llegó a completarse. No se sabe si el cambio se aplicó: se resuelve cuando corra la reconciliación.',
    clasifica: 'indeterminado',
    corta: null,
    verificado: true,
  },
];

const SIN_MAPEAR = (ctx: ContextoError, mensajeMeta: string | undefined): string => {
  // Regla 1 (R17 c9): el mensaje nunca lleva la URL ni el token. El mensaje de
  // Meta se interpola sin URLs, por si acaso la API trae una adentro.
  const limpio = (mensajeMeta ?? 'sin detalle')
    .replace(/https?:\/\/\S+/g, '[enlace omitido]')
    .slice(0, 200);
  return `Meta rechazó la operación sobre «${nombre(ctx)}» (${ctx.objectId}). Motivo informado: «${limpio}».`;
};

/**
 * Traduce un error de Meta a castellano. Nunca tira. Un código sin mapear (o
 * una fila del catálogo todavía no verificada) devuelve el mensaje genérico,
 * clasifica `fallido` y NO corta el lote (regla 3).
 */
export function traducirError(
  e: {
    codigo?: number;
    subcodigo?: number;
    httpStatus?: number;
    transient?: boolean;
    mensaje?: string;
  },
  ctx: ContextoError,
): ErrorTraducido {
  const mensaje = e.mensaje ?? '';

  for (const fila of CATALOGO_ERRORES) {
    if (!fila.verificado) continue;
    if (fila.codigo !== null) {
      if (e.codigo !== fila.codigo) continue;
      if (fila.subcodigo !== undefined && e.subcodigo !== fila.subcodigo) continue;
      if (
        fila.mensajeIncluye &&
        !fila.mensajeIncluye.some((m) => mensaje.toLowerCase().includes(m.toLowerCase()))
      ) {
        continue;
      }
    } else if (fila.transient) {
      if (e.codigo !== undefined || !e.transient) continue;
    } else if (fila.httpStatusMin !== undefined) {
      if (e.codigo !== undefined || e.transient || (e.httpStatus ?? 0) < fila.httpStatusMin) {
        continue;
      }
    }
    return {
      mensaje: fila.castellano(ctx),
      codigoMeta: e.codigo ?? null,
      clasifica: fila.clasifica,
      corta: fila.corta,
    };
  }

  // «Sin mapear»: mensaje genérico correcto, el código como dato secundario, y
  // NUNCA un corte (cortar por un código mal adivinado es peor que no cortar).
  return {
    mensaje: SIN_MAPEAR(ctx, e.mensaje),
    codigoMeta: e.codigo ?? null,
    clasifica: 'fallido',
    corta: null,
  };
}
