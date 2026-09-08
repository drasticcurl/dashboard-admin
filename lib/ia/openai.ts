/**
 * Cliente de OpenAI para los insights del panel.
 *
 * ─── SIN SDK, A PROPOSITO ──────────────────────────────────────────────────
 * `fetch` directo contra la API, igual que `lib/fx-fetch.ts` y `lib/ads/meta.ts`.
 * Este repo no usa el SDK de ningún proveedor: son dos endpoints, el SDK trae su
 * propia cadena de dependencias y su propia política de reintentos, y esa
 * política es justamente lo que NO queremos acá (un reintento silencioso es una
 * llamada paga que nadie pidió).
 *
 * ─── LA KEY SE LEE ADENTRO DE UNA FUNCION ──────────────────────────────────
 * Nunca en el top-level. Si se leyera al importar, el módulo reventaría en el
 * build de la instancia que no tiene la variable — y hay dos instancias
 * deployando de este mismo `origin/main`.
 *
 * ─── LA FEATURE SE PRENDE POR PRESENCIA DE LA KEY ──────────────────────────
 * No hay un `IA_HABILITADA=true` aparte. Sin `OPENAI_API_KEY` la feature no
 * existe: el widget no se ofrece, la tarjeta no se dibuja y el script de cron
 * sale con 0. Eso deja BYTE-IDENTICA a la instancia que no la declare, que es lo
 * que pide la regla de instancias (el default siempre es el comportamiento que
 * ya había, y hasta hoy ninguna de las dos tenía IA).
 *
 * ─── SIN REINTENTOS EN EL PROCESO ──────────────────────────────────────────
 * Mismo criterio que `fx-fetch.ts`: si falla, falla. Para el cron, la corrida de
 * mañana lo resuelve; para el botón, el usuario ve el error y decide si insiste.
 * Un reintento automático sobre un timeout es la forma más fácil de pagar dos
 * veces la misma respuesta, porque el timeout no dice si el modelo contestó.
 */

/** El error de este módulo. `causa` distingue qué se puede reintentar. */
export class IaError extends Error {
  readonly causa: 'sin_key' | 'http' | 'timeout' | 'respuesta_invalida';
  readonly httpStatus?: number;

  constructor(causa: IaError['causa'], message: string, httpStatus?: number) {
    super(message);
    this.name = 'IaError';
    this.causa = causa;
    this.httpStatus = httpStatus;
  }
}

const URL_API = 'https://api.openai.com/v1/chat/completions';

/**
 * Cuánto se espera antes de cortar. 60 s y no 8 s como el fetcher de
 * cotizaciones: un modelo razonando sobre 100 números tarda bastante más que un
 * endpoint que devuelve un JSON de dos campos. El botón del panel tiene un
 * spinner; el cron no tiene a nadie esperando.
 */
const PLAZO_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);

/**
 * El modelo. Configurable porque el catálogo de OpenAI se mueve más rápido que
 * los deploys de este panel, y subir a uno más nuevo o más barato no puede
 * requerir tocar código.
 *
 * El default es `gpt-4o-mini` porque es el ID que con más seguridad existe en
 * cualquier cuenta con crédito y soporta `json_schema` con `strict: true`, que es
 * lo que este módulo necesita. Si hay uno más nuevo y más barato en tu cuenta,
 * ponelo en la env var; verificá el ID exacto con:
 *
 *   curl -s https://api.openai.com/v1/models \
 *     -H "Authorization: Bearer $OPENAI_API_KEY" | grep -o '"id": "[^"]*"'
 *
 * No se valida contra una lista blanca a propósito: una lista en código quedaría
 * vieja y rechazaría el modelo bueno. Un ID inexistente falla con un 404 claro de
 * la API, que es mejor mensaje que cualquiera que pudiéramos inventar.
 */
export function modelo(): string {
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
}

/** true si esta instancia tiene la feature prendida. Sin key, no existe. */
export function hayIa(): boolean {
  return (process.env.OPENAI_API_KEY?.trim().length ?? 0) > 0;
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new IaError(
      'sin_key',
      'OPENAI_API_KEY no está configurada: el análisis con IA está apagado en esta instancia. ' +
        'Se declara en shared/.env.production (NO es NEXT_PUBLIC_: es un secreto y no puede ir al bundle).',
    );
  }
  return key;
}

// ─── El contrato de la respuesta ────────────────────────────────────────────

/** Los cuatro tonos son los tokens semánticos de tailwind.config.ts, no un enum nuevo. */
export type TonoInsight = 'good' | 'warn' | 'bad' | 'info';

/**
 * Una métrica citada. `valor` va como STRING y no como number porque es lo que el
 * modelo escribió: sirve para verificar que no inventó el número, y compararlo
 * requiere normalizar el formato (ver `validarEvidencia` en insights.ts). Si
 * fuera number, el schema lo obligaría a redondear y perderíamos justamente la
 * capacidad de detectar que citó otra cosa.
 */
export type EvidenciaInsight = { metrica: string; valor: string };

export type Insight = {
  titulo: string;
  cuerpo: string;
  tono: TonoInsight;
  evidencia: EvidenciaInsight[];
};

export type RespuestaIa = {
  insights: Insight[];
  tokensIn: number;
  tokensOut: number;
  modelo: string;
};

/**
 * El schema de salida. `strict: true` exige que TODA propiedad esté en `required`
 * y que cada objeto tenga `additionalProperties: false` — no es opcional, la API
 * rechaza el schema si falta alguno de los dos.
 *
 * Tampoco admite `minItems`/`maxItems`, así que la cantidad de insights se pide
 * en el prompt y se recorta en código: el schema garantiza la FORMA, no el
 * tamaño.
 */
export const SCHEMA_SALIDA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'cuerpo', 'tono', 'evidencia'],
        properties: {
          titulo: { type: 'string', description: 'Una línea, sin punto final.' },
          cuerpo: {
            type: 'string',
            description: 'Dos o tres oraciones. Castellano rioplatense, sin jerga de consultor.',
          },
          tono: {
            type: 'string',
            enum: ['good', 'warn', 'bad', 'info'],
            description: 'bad solo para plata que se está perdiendo o datos que no se pueden usar.',
          },
          evidencia: {
            type: 'array',
            description:
              'Las métricas del brief en las que se apoya, con el valor EXACTO que tienen ahí.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['metrica', 'valor'],
              properties: {
                metrica: { type: 'string', description: 'La ruta del campo en el brief.' },
                valor: { type: 'string', description: 'El valor tal como figura en el brief.' },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Le pide el análisis al modelo. `brief` va serializado tal cual: es el mismo
 * objeto cuya huella indexa la caché, así que lo que se le manda y lo que se
 * guarda son el mismo dato.
 */
export async function pedirInsights(instrucciones: string, brief: unknown): Promise<RespuestaIa> {
  const key = apiKey();
  const mod = modelo();

  const body = {
    model: mod,
    // NO se manda `temperature`. Varias familias de modelos nuevas rechazan el
    // parámetro con un 400, y acá no compra nada: la variabilidad sólo se vería
    // al regenerar, y regenerar con el mismo contenido no pasa nunca (la caché
    // por huella lo evita).
    messages: [
      { role: 'system', content: instrucciones },
      // El brief va como un mensaje aparte y no interpolado en las
      // instrucciones: así el prompt de sistema es estable y cacheable del lado
      // de OpenAI, y el contenido variable queda claramente separado de las
      // reglas.
      { role: 'user', content: JSON.stringify(brief) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'insights_panel', strict: true, schema: SCHEMA_SALIDA },
    },
  };

  let res: Response;
  try {
    res = await fetch(URL_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // OBLIGATORIO adentro del runtime de Next: sin esto, `fetch` cachea y el
      // panel podría servir la primera respuesta para siempre. Es el mismo
      // comentario que tiene `pedir()` en lib/ads/meta.ts, y ahí ya pasó.
      cache: 'no-store',
      signal: AbortSignal.timeout(PLAZO_MS),
    });
  } catch (err) {
    const nombre = err instanceof Error ? err.name : '';
    if (nombre === 'TimeoutError' || nombre === 'AbortError') {
      throw new IaError('timeout', `OpenAI no contestó en ${PLAZO_MS} ms`);
    }
    throw new IaError('http', `no se pudo llamar a OpenAI: ${err instanceof Error ? err.message : err}`);
  }

  if (!res.ok) {
    // El cuerpo del error de OpenAI trae el motivo real (modelo inexistente,
    // crédito agotado, key revocada) y es lo único que sirve para arreglarlo.
    // Se recorta porque un 500 puede devolver una página de HTML entera.
    const detalle = (await res.text().catch(() => '')).slice(0, 500);
    throw new IaError('http', `OpenAI HTTP ${res.status}: ${detalle}`, res.status);
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;

  const contenido = json?.choices?.[0]?.message?.content;
  if (typeof contenido !== 'string' || contenido.length === 0) {
    throw new IaError('respuesta_invalida', 'OpenAI contestó sin contenido');
  }

  // Un `finish_reason: 'length'` deja JSON truncado, que con structured outputs
  // igual parsea a veces y con insights a medias. Se trata como fallo.
  if (json?.choices?.[0]?.finish_reason === 'length') {
    throw new IaError('respuesta_invalida', 'OpenAI cortó la respuesta por límite de tokens');
  }

  let parseado: { insights?: unknown };
  try {
    parseado = JSON.parse(contenido) as { insights?: unknown };
  } catch {
    throw new IaError('respuesta_invalida', 'OpenAI devolvió algo que no es JSON');
  }

  if (!Array.isArray(parseado.insights)) {
    throw new IaError('respuesta_invalida', 'la respuesta no trae un array `insights`');
  }

  return {
    insights: parseado.insights.filter(esInsight),
    tokensIn: json?.usage?.prompt_tokens ?? 0,
    tokensOut: json?.usage?.completion_tokens ?? 0,
    modelo: mod,
  };
}

const TONOS: readonly string[] = ['good', 'warn', 'bad', 'info'];

/**
 * Se valida la forma igual que si no hubiera schema. `strict: true` la garantiza,
 * pero esto entra a la base y a la pantalla: confiar en la garantía de un tercero
 * para lo que se persiste es cómo un cambio de comportamiento del proveedor se
 * convierte en una pantalla en blanco.
 */
function esInsight(x: unknown): x is Insight {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.titulo === 'string' &&
    o.titulo.length > 0 &&
    typeof o.cuerpo === 'string' &&
    o.cuerpo.length > 0 &&
    typeof o.tono === 'string' &&
    TONOS.includes(o.tono) &&
    Array.isArray(o.evidencia) &&
    o.evidencia.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as Record<string, unknown>).metrica === 'string' &&
        typeof (e as Record<string, unknown>).valor === 'string',
    )
  );
}
