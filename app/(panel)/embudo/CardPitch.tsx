'use client';

/**
 * CardPitch — el A/B del pitch del upsell, en /embudo.
 *
 * Contesta dos preguntas y nada más:
 *   1. Qué brazo vende más upsells (tabla de arriba).
 *   2. En qué segundo del VSL se va la gente, y cómo cambia entre brazos
 *      (curva de abajo).
 *
 * Vive en /embudo y no en una pantalla nueva porque es una lectura más del mismo
 * funnel y del mismo rango: hereda gratis el selector de funnel, el RangePicker y
 * la auth. Una pantalla aparte costaría un item de Nav, una ruta y un layout para
 * no agregar nada.
 *
 * NO agrega un select a la fila de Filtros del embudo, ni recorta el resto de la
 * pantalla. La card muestra los dos brazos SIEMPRE, uno al lado del otro, que es
 * la única forma de comparar; un filtro que dejara ver un brazo por vez obligaría
 * a memorizar el número del otro.
 *
 * SIN TEST DE SIGNIFICANCIA, a propósito: se muestran los conteos absolutos al
 * lado de cada porcentaje, más un aviso cuando la muestra no alcanza. Un p-valor
 * sobre 37 vistas es ruido con formato de número, y ponerlo en pantalla invita a
 * decidir con él.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import { panelColors } from '@/tailwind.config';
import type { Funnel } from '@/lib/funnels';
import type { PitchBrazoRow, PitchData } from '@/lib/queries/pitch';
import {
  Banner,
  Card,
  ChartFrame,
  EmptyState,
  Spinner,
  Table,
  fmtInt,
  fmtMoney,
  fmtPct,
} from '@/components/ui';

/** Colores de las dos series. A es el control, así que va en neutro. */
const COLOR_BRAZO: Record<string, string> = {
  pitch_A: panelColors.info,
  pitch_B: panelColors.good,
};

function colorDe(brazo: string): string {
  return COLOR_BRAZO[brazo] ?? panelColors.muted;
}

/** `pitch_A` → `A`. El prefijo es para la base, no para la pantalla. */
export function nombreBrazo(brazo: string): string {
  const corte = brazo.lastIndexOf('_');
  const arm = corte <= 0 ? brazo : brazo.slice(corte + 1);
  return arm === '' ? brazo : arm;
}

/**
 * Segundos → `m:ss`. La pregunta que la card contesta es "en qué MINUTO se va la
 * gente", así que el eje habla en minutos y no en 265 segundos pelados.
 */
export function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * ¿Se muestra la card? Predicado PURO, testeable sin jsdom.
 *
 * Mira los brazos DECLARADOS por el funnel (`funnels.experiments`) y no las filas
 * que trajo la query: un funnel que declara el test pero todavía no juntó datos
 * tiene que ver la card con su estado vacío, porque "no hay datos en este rango"
 * es la respuesta a "¿por qué no veo mi test?". Una pantalla sin card deja
 * pensando que se perdió la información.
 */
export function debeMostrarCardPitch(experimentsDeclarados: string[]): boolean {
  return experimentsDeclarados.some((e) => e.startsWith('pitch_'));
}

export function CardPitch({ funnel }: { funnel: Funnel }) {
  const searchParams = useSearchParams();
  const [data, setData] = useState<PitchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // El rango se lee del MISMO query string que el resto de la pantalla, así la
  // card no puede quedar mostrando otro período que los KPIs de arriba.
  const range = searchParams.get('range');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ f: funnel.slug });
    if (from && to) {
      params.set('from', from);
      params.set('to', to);
    } else {
      params.set('range', range ?? 'today');
    }

    fetch(`/api/data/pitch?${params.toString()}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as PitchData;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [funnel.slug, range, from, to]);

  const brazos = data?.brazos ?? [];
  const moneda = funnel.sellCurrency;

  // El que más vende, por la tasa que decide. Solo para marcar la fila: con
  // muestra chica el aviso de arriba aclara que todavía no significa nada.
  const mejor = brazos.reduce<PitchBrazoRow | null>(
    (acc, b) => (acc === null || b.pctVentas > acc.pctVentas ? b : acc),
    null,
  );

  return (
    <Card
      title="Test A/B del pitch del upsell"
      hint="Mide en qué segundo del VSL aparece el precio: un brazo lo revela antes que el otro, con el mismo video y el mismo precio. La tasa que decide es ventas sobre vistas del upsell, no clicks: revelar el precio antes puede subir los clicks y bajar las ventas. Las ventas y la plata son del upsell (con el downsell adentro, que es el mismo producto más barato); el VIP va en su propia columna porque se vende en otra página y no lo vendió el pitch."
    >
      {loading && !data ? (
        <div className="flex items-center gap-2 py-8 text-sm text-neutral-500">
          <Spinner /> Cargando el test…
        </div>
      ) : error ? (
        <Banner tone="bad" title="No se pudo cargar el test A/B">
          {error}
        </Banner>
      ) : brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones con brazo asignado en este rango"
          hint="El test reparte el brazo al entrar al upsell. Si el rango es anterior a que se prendiera, o el kill switch del funnel no está en 'true', no hay nada que comparar todavía."
        />
      ) : (
        <div className="space-y-5">
          {data?.muestraChica && (
            <Banner tone="warn" title="Muestra chica: todavía no alcanza para decidir">
              Hacen falta al menos <span className="font-semibold tabular-nums">100</span> vistas de
              upsell por brazo, y{' '}
              {brazos.length < 2
                ? 'por ahora llegó un solo brazo.'
                : `el más chico tiene ${fmtInt(Math.min(...brazos.map((b) => b.vistasUpsell)))}.`}{' '}
              Los números de abajo son reales, pero la diferencia entre brazos todavía puede darse
              vuelta sola. No es empate: es que falta tráfico.
            </Banner>
          )}

          {/* ── Quién vende más ─────────────────────────────────────────── */}
          <Table
            rows={brazos}
            empty="Sin datos"
            columns={[
              {
                key: 'brazo',
                header: 'Brazo',
                render: (r) => (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: colorDe(r.brazo) }}
                    />
                    <span className="font-medium text-neutral-100">{nombreBrazo(r.brazo)}</span>
                    <span className="text-xs text-neutral-500">
                      {r.reveladoEnSec === null
                        ? 'precio: sin dato'
                        : `precio a ${mmss(r.reveladoEnSec)}`}
                    </span>
                  </span>
                ),
              },
              {
                key: 'vistasUpsell',
                header: 'Vio upsell',
                align: 'right',
                render: (r) => fmtInt(r.vistasUpsell),
              },
              {
                key: 'conSonido',
                header: 'Con sonido',
                align: 'right',
                render: (r) => (
                  <span title="Activaron el sonido del VSL: son los que escucharon el pitch">
                    {fmtInt(r.conSonido)}{' '}
                    <span className="text-xs text-neutral-500">({fmtPct(r.pctConSonido, 0)})</span>
                  </span>
                ),
              },
              {
                key: 'clicks',
                header: 'Clickeó',
                align: 'right',
                render: (r) => fmtInt(r.clicks),
              },
              {
                key: 'ventas',
                header: 'Vendió',
                align: 'right',
                render: (r) => fmtInt(r.ventas),
              },
              {
                /*
                  El VIP en su PROPIA columna y no como un `(+N)` pegado a las
                  ventas. El `+` decía dos mentiras a la vez: sugería que se sumaba
                  (`34 (+3 VIP)` se lee 37, y son 34, porque en la práctica quien
                  compró el VIP había comprado el upsell antes), y metía en la
                  columna del pitch una venta de OTRA página.

                  Se muestra igual porque es plata que existe: lo que no hace es
                  entrar en `% de ventas` ni en la columna de plata de al lado.
                */
                key: 'ventasVip',
                header: 'VIP',
                align: 'right',
                render: (r) => (
                  <span
                    className={r.ventasVip === 0 ? 'text-neutral-600' : 'text-neutral-400'}
                    title="Ventas del VIP (upsell2), que se vende en otra página. No cuentan en el % de ventas ni en la plata por vista: no las hizo el pitch."
                  >
                    {fmtInt(r.ventasVip)}
                  </span>
                ),
              },
              {
                // La columna que decide, resaltada. Al lado va la fracción de la
                // que sale, para que el porcentaje no se lea sin su tamaño.
                key: 'pctVentas',
                header: '% de ventas',
                align: 'right',
                render: (r) => (
                  <span className="flex flex-col items-end leading-tight">
                    <span
                      className={`font-semibold tabular-nums ${
                        mejor?.brazo === r.brazo ? 'text-good-300' : 'text-neutral-50'
                      }`}
                    >
                      {r.vistasUpsell > 0 ? fmtPct(r.pctVentas) : '—'}
                    </span>
                    <span className="text-[11px] tabular-nums text-neutral-500">
                      {fmtInt(r.ventas)}/{fmtInt(r.vistasUpsell)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'revenuePorVista',
                header: `${moneda}/vista`,
                align: 'right',
                render: (r) => (
                  <span
                    className="tabular-nums"
                    title="Plata del upsell (incluye el downsell) por vista del upsell. NO incluye el VIP, que se vende en otra página."
                  >
                    {r.vistasUpsell > 0 ? fmtMoney(r.revenuePorVista, moneda) : '—'}
                  </span>
                ),
              },
            ]}
          />

          {/* ── Dónde se va la gente ────────────────────────────────────── */}
          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-semibold text-neutral-100">
                En qué minuto se va la gente
              </h3>
              <p className="mt-1 max-w-[70ch] text-pretty text-xs leading-relaxed text-neutral-500">
                Cada brazo arranca en 100 % sobre su propia base, así lo que se compara es la FORMA de
                la caída y no el volumen. Se cuenta solo tiempo con el sonido activado: mirar el VSL
                muteado no es escuchar el pitch. La línea punteada marca el segundo en que cada brazo
                revela el precio.
              </p>
            </div>

            {data && data.retencion.length > 0 ? (
              <>
                <ChartFrame alto="md">
                  <LineChart
                    data={data.retencion}
                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis
                      dataKey="segundo"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={mmss}
                      tick={{ fontSize: 11, fill: panelColors.axis }}
                      tickLine={false}
                      axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                      minTickGap={28}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fontSize: 11, fill: panelColors.axis }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                    />
                    <Legend
                      formatter={(v: string) => nombreBrazo(v)}
                      wrapperStyle={{ fontSize: 11, color: panelColors.axis }}
                    />
                    {/*
                      El segundo del revelado sale del propio dato (`props.at_sec`
                      del evento `vsl_pitch`), no de una constante del panel: los
                      segundos viven en env vars del funnel que se inlinean en
                      build y el panel no puede leerlas. Hardcodearlas quedaría
                      mintiendo el día que alguien mueva el brazo B.
                    */}
                    {brazos.map((b) =>
                      b.reveladoEnSec === null ? null : (
                        <ReferenceLine
                          key={`ref-${b.brazo}`}
                          x={b.reveladoEnSec}
                          stroke={colorDe(b.brazo)}
                          strokeDasharray="4 4"
                          strokeOpacity={0.65}
                          label={{
                            value: `precio ${nombreBrazo(b.brazo)}`,
                            position: 'insideTopRight',
                            fill: panelColors.axis,
                            fontSize: 10,
                          }}
                        />
                      ),
                    )}
                    {brazos.map((b) => (
                      <Line
                        key={b.brazo}
                        type="monotone"
                        dataKey={`pct.${b.brazo}`}
                        name={b.brazo}
                        stroke={colorDe(b.brazo)}
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ChartFrame>

                {/*
                  La tabla del acantilado: el gráfico muestra la forma, esto dice
                  el número. Sin esto hay que leer píxeles para saber cuánto se
                  cayó entre dos hitos, que es justo el dato con el que se decide
                  dónde recortar el guion.
                */}
                <CaidaPorTramo puntos={data.retencion} brazos={brazos.map((b) => b.brazo)} />
              </>
            ) : (
              <EmptyState
                title="Todavía no hay curva de retención"
                hint="La curva se arma con los eventos de audio del VSL. Si nadie activó el sonido en este rango, no hay puntos que graficar."
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * El tramo donde más gente se va, por brazo, en texto.
 *
 * Es la lectura que el gráfico no da: mirando la curva se ve que baja, pero para
 * decidir dónde recortar el guion hace falta saber cuál es el tramo de mayor
 * caída y de cuánto es.
 */
function CaidaPorTramo({
  puntos,
  brazos,
}: {
  puntos: PitchData['retencion'];
  brazos: string[];
}) {
  if (puntos.length < 2) return null;

  const peores = brazos
    .map((brazo) => {
      let desde = 0;
      let hasta = 0;
      let caida = 0;
      for (let i = 1; i < puntos.length; i++) {
        const antes = puntos[i - 1]!.pct[brazo] ?? 0;
        const ahora = puntos[i]!.pct[brazo] ?? 0;
        const delta = antes - ahora;
        if (delta > caida) {
          caida = delta;
          desde = puntos[i - 1]!.segundo;
          hasta = puntos[i]!.segundo;
        }
      }
      return { brazo, desde, hasta, caida };
    })
    .filter((p) => p.caida > 0);

  if (peores.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-canvas/40 px-4 py-3">
      <span className="text-xs font-semibold text-neutral-300">Tramo de mayor caída</span>
      {peores.map((p) => (
        <span key={p.brazo} className="text-xs text-neutral-400">
          Brazo <span className="font-semibold text-neutral-200">{nombreBrazo(p.brazo)}</span>: entre{' '}
          <span className="tabular-nums text-neutral-200">{mmss(p.desde)}</span> y{' '}
          <span className="tabular-nums text-neutral-200">{mmss(p.hasta)}</span> se va el{' '}
          <span className="font-semibold tabular-nums text-bad-400">{fmtPct(p.caida, 0)}</span> de los
          que habían llegado al arranque.
        </span>
      ))}
    </div>
  );
}
