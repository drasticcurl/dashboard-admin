import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto, setInicio, setNombre } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';
import { MOTIVO_TEXTO, mensajeDeResultado, type CuerpoAcciones } from '../../../../lib/ads/mensajes';

/**
 * El cableado de la task 14.3 en el route: la antigüedad del dato con el que el
 * Preflight decidió una Omisión tiene que llegar al cliente y salir en el aviso
 * (R6.1).
 *
 * LAS DOS MITADES DE R6.1, JUNTAS EN UN ARCHIVO. El requisito pide que una
 * Omisión nombre la razón **y** la antigüedad del dato con el que se decidió.
 * `acciones.edad.test.ts` prueba que `edadDelDatoDeOmision` escribe la
 * antigüedad, y `mensajes.test.ts` que `oracionDeEdad` la compone si viene en el
 * cuerpo. Las dos pasaban con el route sin cablear: el campo no viajaba, el
 * cliente recibía sólo la razón y el aviso decía «ya está en el estado que la
 * acción pediría» y nada más — que es exactamente lo indistinguible de un botón
 * roto cuando el dato tiene cinco días. Lo que se verifica acá es el viaje
 * completo, y cada caso lo cierra pasándole el cuerpo HTTP real al traductor.
 *
 * LOS TRES TEXTOS POSIBLES, que son los tres estados en los que la relectura
 * selectiva puede dejar a un objeto:
 *
 * 1. Dato fresco, sin relectura: se nombra la edad del `synced_at` de la fila.
 * 2. Dato viejo releído contra Meta: la edad del `synced_at` YA NO es la del dato
 *    que decidió, así que se dice que se confirmó contra Meta al resolver el
 *    pedido. Nombrar los cinco días haría dudar de una decisión tomada con una
 *    lectura de ahora.
 * 3. Dato viejo cuya relectura falló: decidió la copia local, se nombra su edad y
 *    se agrega que no se pudo revalidar (R6.5, del lado del usuario).
 *
 * Y LAS OTRAS DOS ACCIONES QUE OMITEN. `rename` y `schedule` no releen
 * (`pf.relecturas` está vacío para ellas), así que caen siempre en el camino 1 y
 * la antigüedad que citan es la del `synced_at` de la fila con la que se
 * comparó, que es verdad. Están acá porque el cableado es por `resultados.push`
 * y no por acción: los cuatro sitios que declaran una Omisión son cuatro, y tres
 * de ellos son estos.
 *
 * A nivel `adset`: es el único nivel donde `schedule` es representable y sirve
 * igual para las otras dos acciones sin cambiar de objeto.
 *
 * NECESITA POSTGRES.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

// `guard()` delega en `guardSeccion` de lib/permisos (T03), que ya no lee
// `isAuthenticated`: consulta la base a través de una sesión real. Este test
// no ejercita el 401, así que el mock siempre deja pasar con sesión admin.
vi.mock('../../../../lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => ({
      sesion: {
        usuarioId: 1,
        usuario: 'test',
        nombre: 'Test',
        esAdmin: true,
        debeCambiarClave: false,
        secciones: actual.SECCIONES,
        esFallback: false,
      },
    })),
  };
});

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return {
    ...actual,
    enviar: vi.fn(),
    setNombre: vi.fn(),
    setInicio: vi.fn(),
    fetchObjeto: vi.fn(),
    fetchMinimoPresupuesto: vi.fn().mockResolvedValue(null),
  };
});

const mockEnviar = vi.mocked(enviar);
const mockSetNombre = vi.mocked(setNombre);
const mockSetInicio = vi.mocked(setInicio);
const mockFetchObjeto = vi.mocked(fetchObjeto);
const mockAuth = vi.mocked(isAuthenticated);

const CUENTA = `T143-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** ids de 20 dígitos (R17 c3), colgados del reloj: las PK de `ad_sets` son
 *  globales y una corrida cortada a mitad no puede chocar con la siguiente. */
const RAIZ = `143${Date.now()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
const oid = (n: number): string => `${RAIZ}${String(n).padStart(2, '0')}`;

const CAMP = oid(0);
/** PAUSED y con el dato de ahora: `pause` se omite y no hay relectura. */
const S_FRESCO = oid(1);
/** PAUSED y viejo: se relee y Meta confirma el dato. */
const S_VIEJO_CONFIRMADO = oid(2);
/** PAUSED y viejo: se relee y la lectura falla. */
const S_VIEJO_SIN_META = oid(3);
/** Viejo, para la Omisión del renombre por nombre idéntico. */
const S_RENOMBRE = oid(4);
/** Viejo y con el inicio ya alcanzado: la Omisión de `ya_esta_entregando`. */
const S_ENTREGANDO = oid(5);

const NOMBRE_RENOMBRE = 'Conjunto que ya se llama así';

/**
 * Cinco días, que es el orden de magnitud del peor objeto de producción (5 d y
 * 17 h). Elegido redondo para que `textoAntiguedad` diga «de hace 5 d» sin que el
 * test dependa del redondeo: 5 días más los segundos que tarda el pedido siguen
 * redondeando a 5.
 */
const VIEJO = new Date(Date.now() - 5 * 86_400_000);
const EDAD_VIEJO = 'de hace 5 d';

type ResultadoHttp = {
  estado: string;
  motivo?: string;
  edadDelDato?: string | null;
  advertencia?: string | null;
  mensaje: string | null;
};

const pedir = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );

/** Un pedido de UN objeto, con el cuerpo ya deserializado: es lo que después se
 *  le pasa al traductor, sin volver a escribirlo a mano. */
async function unObjeto(
  body: Record<string, unknown>,
): Promise<{ cuerpo: CuerpoAcciones; r: ResultadoHttp }> {
  const resp = await pedir({ level: 'adset', accountId: CUENTA, ...body });
  expect(resp.status).toBe(200);
  const cuerpo = (await resp.json()) as CuerpoAcciones & { resultados: ResultadoHttp[] };
  const r = cuerpo.resultados[0];
  if (!r) throw new Error(`la respuesta no trajo resultado para ${JSON.stringify(body)}`);
  return { cuerpo, r };
}

/** El aviso que la pantalla mostraría con ese cuerpo. Nunca nulo acá: los cinco
 *  casos del archivo son Omisiones, y una Omisión siempre tiene algo que decir. */
function avisoDe(cuerpo: CuerpoAcciones): { tono: string; texto: string } {
  const a = mensajeDeResultado(200, cuerpo);
  if (a === null) throw new Error('el traductor se calló ante una Omisión');
  return a;
}

async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test T14.3', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
    [CUENTA],
  );
  // El umbral de la 025. Se fija explícitamente porque de él depende cuáles de
  // estas filas se releen, y un archivo anterior de la suite pudo haberlo movido.
  await q(
    `INSERT INTO settings (key, value) VALUES ('ads_frescura_umbral_segundos', '900'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = '900'::jsonb`,
  );
  // ABO y campaña ACTIVE: con el padre encendido no hay advertencia de R6.4, así
  // que lo único que estos casos pueden agregar al aviso es la antigüedad.
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at)
     VALUES ($1, $2, 'Campaña T14.3', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now())`,
    [CAMP, CUENTA],
  );
  // Todos PAUSED: con esa copia local, `pause` se omite por
  // `ya_esta_en_ese_estado`, que es la Omisión que R6.1 nombra. `desaparecido_at`
  // en NULL en todos: la advertencia de R3.4 taparía lo que se mide acá.
  await q(
    `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                          currency, daily_budget, start_time, synced_at, desaparecido_at) VALUES
       ($1, $6, $7, 'Conjunto fresco',   'PAUSED', 'PAUSED', 'EUR', 500, NULL, now(), NULL),
       ($2, $6, $7, 'Conjunto viejo ok', 'PAUSED', 'PAUSED', 'EUR', 500, NULL, $8,    NULL),
       ($3, $6, $7, 'Conjunto sin Meta', 'PAUSED', 'PAUSED', 'EUR', 500, NULL, $8,    NULL),
       ($4, $6, $7, $9,                  'PAUSED', 'PAUSED', 'EUR', 500, NULL, $8,    NULL),
       ($5, $6, $7, 'Conjunto que arrancó', 'ACTIVE', 'ACTIVE', 'EUR', 500,
        now() - interval '1 day', $8, NULL)`,
    [
      S_FRESCO,
      S_VIEJO_CONFIRMADO,
      S_VIEJO_SIN_META,
      S_RENOMBRE,
      S_ENTREGANDO,
      CAMP,
      CUENTA,
      VIEJO.toISOString(),
      NOMBRE_RENOMBRE,
    ],
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  mockAuth.mockImplementation(() => true);
  mockEnviar.mockReset();
  mockSetNombre.mockReset();
  mockSetInicio.mockReset();
  mockFetchObjeto.mockReset();
  // Un backoff por cuota activo saltea la relectura y rechaza el pedido antes del
  // preflight, y lo deja puesto cualquier otro archivo de la suite.
  await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_backoff_until'`);
});

describe.skipIf(!dbAvailable)('la antigüedad del dato de una Omisión viaja al cliente (T14.3, R6.1)', () => {
  it('con el dato fresco nombra su edad, y el aviso dice la razón Y la antigüedad', async () => {
    const { cuerpo, r } = await unObjeto({ action: 'pause', objectIds: [S_FRESCO] });

    expect(r.estado).toBe('omitido');
    expect(r.motivo).toBe('ya_esta_en_ese_estado');
    expect(mockEnviar).not.toHaveBeenCalled();
    // Dentro del umbral: no se relee, y la edad es la del `synced_at` de la fila.
    expect(mockFetchObjeto).not.toHaveBeenCalled();
    expect(r.edadDelDato).toBe('de hace menos de un minuto');

    // Las dos mitades de R6.1 en la misma oración, que es lo que el requisito
    // pide y lo que el route no cableaba.
    const aviso = avisoDe(cuerpo);
    expect(aviso.tono).toBe('aviso');
    expect(aviso.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(aviso.texto).toContain('Se decidió según un dato de hace menos de un minuto.');
  });

  it('con el dato viejo pero confirmado contra Meta, no cita los cinco días', async () => {
    // Mismo estado que la base: la relectura `coincide`, así que la Omisión se
    // mantiene y la decisión SÍ se tomó con una lectura de ahora.
    mockFetchObjeto.mockResolvedValue({
      objectId: S_VIEJO_CONFIRMADO,
      name: 'Conjunto viejo ok',
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      dailyBudget: 500,
      lifetimeBudget: null,
    });

    const { cuerpo, r } = await unObjeto({ action: 'pause', objectIds: [S_VIEJO_CONFIRMADO] });

    expect(r.estado).toBe('omitido');
    expect(mockFetchObjeto).toHaveBeenCalledWith(S_VIEJO_CONFIRMADO, 'adset');
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(r.edadDelDato).toBe('confirmado contra Meta al resolver el pedido');

    const aviso = avisoDe(cuerpo);
    expect(aviso.texto).toContain('Se decidió según un dato confirmado contra Meta');
    // Lo que NO puede decir: la edad de la copia local, que ya no es la del dato
    // con el que se decidió. Citarla haría dudar de una lectura de ahora.
    expect(aviso.texto).not.toContain(EDAD_VIEJO);
  });

  it('con el dato viejo y la relectura fallada, cita la edad y dice que no se revalidó', async () => {
    mockFetchObjeto.mockRejectedValue(new Error('Meta no respondió'));

    const { cuerpo, r } = await unObjeto({ action: 'pause', objectIds: [S_VIEJO_SIN_META] });

    expect(r.estado).toBe('omitido');
    expect(mockEnviar).not.toHaveBeenCalled();
    // R6.2: la lectura fallada no bloquea nada; decide la copia local y se dice
    // cuál es y que no se pudo revalidar.
    expect(r.edadDelDato).toBe(`${EDAD_VIEJO}, que no se pudo revalidar contra Meta`);

    const aviso = avisoDe(cuerpo);
    expect(aviso.texto).toContain(`Se decidió según un dato ${EDAD_VIEJO}, que no se pudo revalidar`);
  });

  it('la Omisión del renombre también la lleva: se comparó contra el nombre local', async () => {
    const { cuerpo, r } = await unObjeto({
      action: 'rename',
      objectIds: [S_RENOMBRE],
      modo: { tipo: 'exacto', nombre: NOMBRE_RENOMBRE },
    });

    expect(r.estado).toBe('omitido');
    expect(r.motivo).toBe('valor_igual_al_anterior');
    expect(mockSetNombre).not.toHaveBeenCalled();
    // `rename` no relee, así que la edad sale del `synced_at` de la fila: el dato
    // con el que efectivamente se comparó el nombre.
    expect(mockFetchObjeto).not.toHaveBeenCalled();
    expect(r.edadDelDato).toBe(EDAD_VIEJO);

    const aviso = avisoDe(cuerpo);
    expect(aviso.texto).toContain(MOTIVO_TEXTO.valor_igual_al_anterior);
    expect(aviso.texto).toContain(`Se decidió según un dato ${EDAD_VIEJO}.`);
  });

  it('la Omisión de un conjunto que ya arrancó también, y es la más engañosa sin ella', async () => {
    // La decisión compara `start_time` de la copia local contra el reloj y nada
    // en este endpoint relee esa columna: si la fila está vieja, el conjunto
    // puede no haber arrancado nunca y el panel igual se niega a programarlo.
    const { cuerpo, r } = await unObjeto({
      action: 'schedule',
      objectIds: [S_ENTREGANDO],
      inicio: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    expect(r.estado).toBe('omitido');
    expect(r.motivo).toBe('ya_esta_entregando');
    expect(mockSetInicio).not.toHaveBeenCalled();
    expect(r.edadDelDato).toBe(EDAD_VIEJO);

    const aviso = avisoDe(cuerpo);
    expect(aviso.texto).toContain(MOTIVO_TEXTO.ya_esta_entregando);
    expect(aviso.texto).toContain(`Se decidió según un dato ${EDAD_VIEJO}.`);
  });
});
