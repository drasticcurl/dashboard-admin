'use client';

/**
 * celdas.tsx (task 19.2 de gestion-campanas-anuncios): los controles que
 * ESCRIBEN desde una celda de la tabla, movidos desde AnunciosView.tsx SIN
 * cambiar su comportamiento (D-A19):
 *   - `ToggleEstado`: optimista con reversión si el POST falla, y SIN
 *     Dialogo_Confirmacion (R14 c11): el toggle de una fila es reversible con
 *     un click y ya funciona así.
 *   - `PresupuestoCelda`: la edición de presupuesto de una fila, que sigue
 *     abriendo confirmación.
 *   - `RatioTone`: el formato con tono de los cocientes.
 *
 * `AnunciosView.tsx` los importa de acá y se elimina en la task 20.4; la
 * `Tabla_Anuncios` (TablaAds.tsx) los reusa.
 *
 * La task 8 de frescura-y-acciones-anuncios agrega acá la Marca_Frescura de una
 * fila: la clasificación (`frescuraDeFila`), el texto de la antigüedad y el
 * badge que la dibuja.
 */

import type { MetricasObjeto } from '@/lib/ads/tipos';
import { Badge, fmtInt, fmtMoney } from '@/components/ui';

// Estados que Meta muestra pero que no se pueden escribir: no son toggleables.
const NO_TOGGLEABLE = new Set(['ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']);

/** El estado efectivo en castellano, para el badge que acompaña al nombre. */
export function etiquetaEffective(s: string): string {
  const map: Record<string, string> = {
    CAMPAIGN_PAUSED: 'campaña pausada',
    ADSET_PAUSED: 'conjunto pausado',
    WITH_ISSUES: 'con problemas',
    DISAPPROVED: 'rechazado',
    PENDING_REVIEW: 'en revisión',
    IN_PROCESS: 'procesando',
    PENDING_BILLING_INFO: 'sin facturación',
  };
  return map[s] ?? s;
}

function money(n: number): string {
  return fmtMoney(n, 'EUR');
}

// ─── Marca_Frescura de una fila (task 8, R3.1 y R3.3) ───────────────────────

/**
 * En qué condición está el dato de UNA fila de la tabla.
 *
 * Cuatro casos y no un booleano `vieja`, porque son cuatro hechos distintos y
 * dos de ellos se confundían con facilidad:
 *
 * - `sin_jerarquia`: la fila no viene de la Jerarquía. Son las que salen del
 *   `UNION ALL` con `gasto` de `lib/queries/ads.ts`: hubo gasto atribuido a un
 *   objeto que no tiene fila local, así que `syncedAt` es `null`. NO están
 *   viejas: no hay ningún dato de Meta que pueda estar atrasado. Marcarlas como
 *   desactualizadas sería inventarles un problema, y son justo las que más se
 *   parecen a un objeto viejo si uno mira sólo "¿`syncedAt` supera el umbral?"
 *   con un `null` de por medio.
 * - `al_dia`: confirmada contra Meta dentro del umbral.
 * - `vieja`: `syncedAt` supera el umbral. Puede arreglarse sola: la próxima
 *   corrida de la Sync_Jerarquia la vuelve a confirmar.
 * - `desaparecida`: `desaparecidoAt` no es nulo. Meta dejó de devolver el
 *   objeto, así que NO se arregla sola. Es la condición más grave y gana sobre
 *   `vieja` incluso con un `syncedAt` fresco: un objeto puede haber sido
 *   confirmado hace diez minutos en la corrida donde justamente se detectó que
 *   ya no viene.
 */
export type FrescuraFila =
  | { marca: 'sin_jerarquia' }
  | { marca: 'al_dia'; edadSegundos: number }
  | { marca: 'vieja'; edadSegundos: number }
  | {
      marca: 'desaparecida';
      /** Antigüedad del último dato confirmado. null = la fila no trae `syncedAt`. */
      edadSegundos: number | null;
      /** Hace cuánto Meta dejó de devolverlo. null = `desaparecidoAt` ilegible. */
      desdeSegundos: number | null;
    };

/** Un ISO si dice algo. `''` es ausencia de fecha, no una fecha (mismo criterio que `textoDeEstado`). */
function isoPresente(s: string | null): string | null {
  return s !== null && s.trim() !== '' ? s : null;
}

/**
 * Segundos entre `iso` y `ahora`, o `null` si no hay fecha legible.
 *
 * NUNCA devuelve un número negativo. `ahora` es el reloj del NAVEGADOR y las dos
 * fechas las escribió el reloj del SERVER: con unos segundos de desfasaje —o con
 * la máquina del usuario adelantada, que es lo habitual— un objeto recién
 * sincronizado da una diferencia negativa. Eso no es "un dato de hace −3
 * minutos": es un dato de recién. Se acota en 0, que además hace imposible que
 * el desfasaje produzca una marca de vieja (el caso contrario, marcar de más,
 * sería un aviso falso sobre plata).
 */
function segundosDesde(iso: string | null, ahora: number): number | null {
  const s = isoPresente(iso);
  if (s === null) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ahora - t) / 1000));
}

/**
 * La condición del dato de una fila (R3.1).
 *
 * Pura y exportada por la misma razón que `dibujoDeEstado` y `accionDeToggle`:
 * `vitest.config.ts` corre en node, sin jsdom y sin testing-library, así que la
 * única forma de testear una decisión del cliente es que viva afuera del JSX. Y
 * acá hay bastante que fijar: el `null` de las filas de gasto, la precedencia de
 * la desaparición sobre la vejez, el borde exacto del umbral y el reloj
 * adelantado del navegador.
 *
 * `ahora` entra por parámetro y no se lee de `Date.now()` adentro para que la
 * tabla entera mida contra el MISMO instante (si no, la primera fila puede decir
 * 15 min y la última 16) y para que el test no dependa del reloj de la máquina.
 *
 * "Supera el umbral" es estricto, como lo dice R3.1: una fila con exactamente
 * `umbralSegundos` de antigüedad todavía está al día. Con `>=`, el umbral de 900
 * marcaría a los 900 justos, que es el instante en el que la corrida del cron
 * (cada 15 min) llega a confirmarla.
 *
 * Un `umbralSegundos` que no sea un número finito deja todo en `al_dia`: la
 * comparación con `NaN` es falsa. Es el desenlace correcto para una fila de
 * `settings` corrupta —no marcar nada— y no el de marcar las 505 filas.
 */
export function frescuraDeFila(
  fila: Pick<MetricasObjeto, 'syncedAt' | 'desaparecidoAt'>,
  umbralSegundos: number,
  ahora: number,
): FrescuraFila {
  const edad = segundosDesde(fila.syncedAt, ahora);
  // Va PRIMERO: es la condición más grave y no depende del umbral. Se mira el
  // campo y no `desdeSegundos`, para que un `desaparecidoAt` presente pero
  // ilegible siga marcando la fila (un badge sin antigüedad avisa; ningún badge
  // esconde el objeto que Meta ya no devuelve).
  if (isoPresente(fila.desaparecidoAt) !== null) {
    return {
      marca: 'desaparecida',
      edadSegundos: edad,
      desdeSegundos: segundosDesde(fila.desaparecidoAt, ahora),
    };
  }
  if (edad === null) return { marca: 'sin_jerarquia' };
  if (edad > umbralSegundos) return { marca: 'vieja', edadSegundos: edad };
  return { marca: 'al_dia', edadSegundos: edad };
}

/**
 * Una duración en palabras: `'12 min'`, `'3 h'`, `'5 d 17 h'`.
 *
 * Con `Math.floor` y no `Math.round`, al revés que `textoEdadGasto` de
 * `lib/ads/polling.ts`: acá el número se lee como "por lo menos tan viejo" y
 * redondear para arriba exagera la antigüedad de un dato (el objeto más viejo
 * de producción, 5 d 17 h, se leería "hace 6 d"). Los días llevan las horas al
 * lado porque a partir del día el número solo pierde toda la resolución, y la
 * diferencia entre "5 d" y "5 d 17 h" es la que hace evidente que ese objeto
 * está abandonado y no atrasado.
 *
 * No se reusa `textoEdadGasto`: toma un `FrescuraAds` completo (la frescura de
 * la CUENTA) y armarle uno falso a partir de los segundos de una fila sería
 * pasar por un tipo que no describe esto. Su renombrado y su generalización son
 * la task 11 y tocan cuatro consumidores de tres pantallas.
 */
export function textoDuracion(segundos: number): string {
  const s = Number.isFinite(segundos) ? Math.max(0, Math.floor(segundos)) : 0;
  if (s < 60) return 'menos de 1 min';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** La misma duración, leída como antigüedad. */
export function textoAntiguedad(segundos: number): string {
  return `hace ${textoDuracion(segundos)}`;
}

/**
 * El badge de la celda de nombre cuando el dato de la fila está viejo o el
 * objeto desapareció (R3.1). `null` cuando no hay nada que marcar, que es el
 * caso normal.
 *
 * Dos estados VISUALMENTE distintos y no uno solo, porque la diferencia importa
 * al leerlos: la fila vieja puede volver sola en la próxima corrida del cron, la
 * desaparecida no vuelve nunca sin intervención. Neutro para la primera, tono de
 * advertencia para la segunda.
 *
 * La antigüedad va en el TEXTO del badge, no en el `title`: un `title` no lo
 * alcanza el teclado ni lo lee un lector de pantalla, así que una marca cuya
 * única información viva ahí es, para media pantalla, un cuadradito de color. El
 * `title` queda como el detalle largo para el mouse, igual que en el resto de
 * esta pantalla (`ToggleEstado` pone la acción en `aria-label` y deja el `title`
 * como adorno).
 */
export function MarcaFrescura({
  fila,
  umbralSegundos,
  ahora,
}: {
  fila: Pick<MetricasObjeto, 'syncedAt' | 'desaparecidoAt'>;
  umbralSegundos: number;
  /** El instante contra el que se mide, uno solo para toda la tabla. */
  ahora: number;
}): JSX.Element | null {
  const f = frescuraDeFila(fila, umbralSegundos, ahora);

  if (f.marca === 'desaparecida') {
    const texto =
      f.desdeSegundos !== null
        ? `sin respuesta de Meta ${textoAntiguedad(f.desdeSegundos)}`
        : 'sin respuesta de Meta';
    const detalle =
      'Meta dejó de devolver este objeto en la última sincronización de la jerarquía' +
      (f.edadSegundos !== null ? `; el dato local es ${textoAntiguedad(f.edadSegundos)}` : '') +
      '. No se va a poner al día solo: revisá si el objeto todavía existe en el administrador de anuncios.';
    return (
      <Badge tone="warn">
        <span title={detalle}>{texto}</span>
      </Badge>
    );
  }

  if (f.marca === 'vieja') {
    return (
      <Badge tone="neutral">
        <span
          title={`Este objeto no se confirma contra Meta ${textoAntiguedad(
            f.edadSegundos,
          )} (el umbral es ${textoDuracion(umbralSegundos)}). El estado y el presupuesto que se muestran pueden no ser los de Meta; la próxima corrida de la sincronización puede ponerlos al día.`}
        >
          dato {textoAntiguedad(f.edadSegundos)}
        </span>
      </Badge>
    );
  }

  return null;
}

/** Cuántas filas de las que están en pantalla están en cada condición (R3.3). */
export type ResumenFrescura = {
  viejas: number;
  desaparecidas: number;
  /** Filas que no vienen de la Jerarquía. Se cuentan aparte: no están viejas. */
  sinJerarquia: number;
  /**
   * La antigüedad del dato más viejo entre las filas MARCADAS, en segundos.
   * `null` = ninguna marcada. Es el número que hace visible el caso real: el
   * objeto más viejo de producción tenía 5 días y 17 horas y el panel lo dibujaba
   * como si fuera actual.
   */
  masViejaSegundos: number | null;
};

/**
 * El conteo de la pantalla, sobre las filas que se están mostrando (R3.3).
 *
 * Pura y separada del Banner por lo mismo que `frescuraDeFila`, y sobre las filas
 * VISIBLES a propósito: no hay ningún agregado del servidor que cuente
 * desactualizados sobre el filtro completo, así que decir "34 del filtro" cuando
 * se contó una página sería el mismo error que la barra de KPIs (R7.2, task 17).
 * Quien lo dibuja tiene que decir sobre qué está contado.
 */
export function resumenFrescura(
  filas: readonly Pick<MetricasObjeto, 'syncedAt' | 'desaparecidoAt'>[],
  umbralSegundos: number,
  ahora: number,
): ResumenFrescura {
  let viejas = 0;
  let desaparecidas = 0;
  let sinJerarquia = 0;
  let masViejaSegundos: number | null = null;
  for (const fila of filas) {
    const f = frescuraDeFila(fila, umbralSegundos, ahora);
    if (f.marca === 'al_dia') continue;
    if (f.marca === 'sin_jerarquia') {
      sinJerarquia++;
      continue;
    }
    if (f.marca === 'vieja') viejas++;
    else desaparecidas++;
    if (f.edadSegundos !== null && (masViejaSegundos === null || f.edadSegundos > masViejaSegundos)) {
      masViejaSegundos = f.edadSegundos;
    }
  }
  return { viejas, desaparecidas, sinJerarquia, masViejaSegundos };
}

/**
 * Las frases del Banner de frescura (R3.3): una por condición presente, y vacío
 * cuando no hay ninguna marca (un bloque que dice "0 filas viejas" es ruido en el
 * caso normal, así que el llamador no dibuja nada).
 *
 * Van acá y no en el JSX del Banner por dos razones. Cada frase tiene que decir
 * SOBRE QUÉ está contada —las filas en pantalla, no el filtro completo, porque no
 * hay ningún agregado del servidor que cuente desactualizados— y las dos tienen
 * que decir cosas distintas: la vieja se arregla con la próxima corrida de la
 * sincronización, la desaparecida no. Eso es texto con contenido, y el texto con
 * contenido se testea.
 */
export function frasesFrescura(
  resumen: ResumenFrescura,
  filasEnPantalla: number,
  umbralSegundos: number,
): string[] {
  if (resumen.viejas === 0 && resumen.desaparecidas === 0) return [];
  const frases: string[] = [];
  if (resumen.viejas > 0) {
    frases.push(
      `${fmtInt(resumen.viejas)} de las ${fmtInt(filasEnPantalla)} filas en pantalla ${
        resumen.viejas === 1 ? 'no se confirma' : 'no se confirman'
      } contra Meta desde hace más de ${textoDuracion(umbralSegundos)}: su estado y su presupuesto ` +
        'pueden no ser los de Meta. La próxima corrida de la sincronización de la jerarquía ' +
        'las vuelve a confirmar.',
    );
  }
  if (resumen.desaparecidas > 0) {
    frases.push(
      `Meta dejó de devolver ${fmtInt(resumen.desaparecidas)} de estas filas: eso no se pone al día ` +
        'solo. Los datos que se muestran son los últimos que Meta confirmó.',
    );
  }
  if (resumen.masViejaSegundos !== null) {
    frases.push(`El dato más viejo de la página es ${textoAntiguedad(resumen.masViejaSegundos)}.`);
  }
  return frases;
}

/**
 * Dónde vive el presupuesto, con el MISMO vocabulario que `destinoPresupuesto`
 * de GestorAnuncios.tsx ('campaña (CBO)' / 'cada conjunto (ABO)'), para que la
 * celda y el diálogo de duplicar no nombren de dos formas distintas la misma
 * cosa.
 */
const DESTINO_PRESUPUESTO: Record<'campaign' | 'adset', string> = {
  campaign: 'la campaña (CBO)',
  adset: 'cada conjunto (ABO)',
};

/** El rótulo de la pestaña de `TabsNivel` donde el presupuesto SÍ se edita. */
const PESTANA_NIVEL: Record<'campaign' | 'adset', string> = {
  campaign: 'Campañas',
  adset: 'Conjuntos',
};

/** La fila que se está mirando, en singular y con su artículo (el género no es
 *  el mismo: «esta campaña», «este conjunto»). */
const OBJETO_NIVEL: Record<'campaign' | 'adset', string> = {
  campaign: 'esta campaña',
  adset: 'este conjunto',
};

/**
 * Por qué la celda de presupuesto de esta fila no se puede editar (R1.7).
 *
 * Se deriva de `budgetLevel` —el nivel donde el presupuesto vive de verdad— y
 * NO de la desigualdad `budgetLevel !== level`, que era la versión anterior:
 * afirmaba siempre "se maneja en la campaña", y en estas cuentas (ABO,
 * `budget_level = 'adset'`) es exactamente al revés. El mensaje era falso a
 * nivel campaña, que es justo donde más se lee.
 *
 * El texto nombra la pestaña a la que hay que ir, y cuando el presupuesto vive
 * en ESTE mismo nivel no repite "se maneja en cada conjunto" mirando conjuntos
 * (sería cierto e inútil): ahí lo que falta es un presupuesto diario cargado.
 *
 * Pura y exportada a propósito: es un texto que estuvo invertido meses sin que
 * nadie lo notara, y así queda fijado por un test.
 */
export function motivoPresupuestoNoEditable(
  fila: Pick<MetricasObjeto, 'level' | 'budgetLevel' | 'budgetMode'>,
): string {
  // Va primero porque es la única razón que no se arregla cambiando de
  // pestaña: el panel no escribe presupuestos totales en ningún nivel.
  if (fila.budgetMode === 'lifetime') return 'presupuesto total: este panel sólo edita presupuestos diarios';
  if (fila.budgetLevel === null) return 'este objeto no tiene presupuesto propio: no hay nada que editar acá';
  if (fila.budgetLevel !== fila.level) {
    return `el presupuesto se maneja en ${DESTINO_PRESUPUESTO[fila.budgetLevel]}: editalo en la pestaña ${
      PESTANA_NIVEL[fila.budgetLevel]
    }`;
  }
  // El presupuesto vive en este mismo nivel pero el objeto no tiene ninguno
  // cargado.
  if (fila.budgetMode === null) {
    return `${OBJETO_NIVEL[fila.budgetLevel]} no tiene un presupuesto diario cargado en Meta`;
  }
  // Vive acá y es diario: ésa es exactamente la combinación editable, así que
  // la celda no llega hasta acá. Se devuelve algo que no afirma nada del objeto
  // en lugar de inventarle un motivo.
  return 'no editable';
}

export function RatioTone({ v, umbral }: { v: number | null; umbral: number }): JSX.Element {
  if (v === null) return <span className="text-neutral-600">—</span>;
  const ratio = v.toFixed(2);
  const tone = v < umbral ? 'text-bad-400' : v < umbral + 1 ? 'text-warn-400' : 'text-good-400';
  return <span className={tone}>{ratio}</span>;
}

/**
 * Con qué se dibuja la celda de estado de una fila y, cuando es el interruptor,
 * en qué posición queda.
 *
 * Unión discriminada y no un par de booleanos, por lo que la rama `badge` NO
 * tiene: no lleva `encendido`. Un objeto que no se puede escribir no tiene
 * posición de interruptor, así que no hay de dónde derivarle una, y "togglear
 * una fila que dibuja un badge" queda imposible por tipo en lugar de depender
 * del cuidado del llamador.
 *
 * Pura y exportada para el test de la Property 1 (task 4.3): la coherencia
 * entre lo que se dibuja y lo que se pide tiene que poder verificarse para TODO
 * valor de `status`, y este repo corre vitest en node, sin render. Antes esta
 * decisión vivía adentro del JSX de `ToggleEstado` y comparaba contra un
 * `NO_TOGGLEABLE` sin exportar: no había forma de nombrarla desde un test.
 *
 * `status === 'ACTIVE'` es LA MISMA comparación que invierte `accionDeToggle` de
 * `GestorAnuncios.tsx`. Que las dos salgan de la misma expresión es todo el
 * punto: la fila que se dibuja apagada pide activar.
 */
export type DibujoEstado =
  | { control: 'interruptor'; encendido: boolean }
  | { control: 'badge'; texto: string };

export function dibujoDeEstado(
  fila: Pick<MetricasObjeto, 'status' | 'effectiveStatus'>,
): DibujoEstado {
  if (NO_TOGGLEABLE.has(fila.status ?? '') || NO_TOGGLEABLE.has(fila.effectiveStatus ?? '')) {
    // El badge nunca queda en blanco. La cadena vacía cuenta como AUSENTE y no
    // como valor, el mismo criterio que `textoONulo` de `lib/ads/mensajes.ts`:
    // con el `??` pelado que había acá, una fila con `effective_status = ''` y
    // `status = 'ARCHIVED'` dibujaba un badge de advertencia sin una letra
    // adentro. Lo encontró la Property 1 de la task 4.3.
    //
    // El `'?'` final es un piso que no se puede alcanzar —para entrar acá uno de
    // los dos estados tiene que estar en `NO_TOGGLEABLE`, y ninguno de esos es
    // vacío— y se deja para que la expresión sea total sin obligar a razonar
    // sobre el contenido del Set.
    return { control: 'badge', texto: textoDeEstado(fila.effectiveStatus) ?? textoDeEstado(fila.status) ?? '?' };
  }
  return { control: 'interruptor', encendido: fila.status === 'ACTIVE' };
}

/** El estado si dice algo. `''` es ausencia de estado, no un estado. */
function textoDeEstado(s: string | null): string | null {
  return s !== null && s !== '' ? s : null;
}

export function ToggleEstado({
  fila,
  onToggle,
}: {
  fila: MetricasObjeto;
  onToggle: (f: MetricasObjeto) => void;
}): JSX.Element {
  const dibujo = dibujoDeEstado(fila);
  if (dibujo.control === 'badge') {
    return <Badge tone="warn">{dibujo.texto}</Badge>;
  }
  const activo = dibujo.encendido;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={`${fila.objectName ?? fila.objectId}: ${activo ? 'pausar' : 'activar'}`}
      onClick={() => onToggle(fila)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
        activo ? 'bg-good-500' : 'bg-overlay/12'
      }`}
      title={activo ? 'Pausar' : 'Activar'}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          activo ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function PresupuestoCelda({
  fila,
  edit,
  onEdit,
  onConfirm,
}: {
  fila: MetricasObjeto;
  edit: string | undefined;
  onEdit: (v: string) => void;
  onConfirm: (eur: number) => void;
}): JSX.Element {
  const editable = fila.budgetLevel === fila.level && fila.budgetMode === 'daily';

  if (fila.level === 'ad') return <span className="text-neutral-600">—</span>;

  if (!editable) {
    const motivo = motivoPresupuestoNoEditable(fila);
    return (
      <span className="text-neutral-500" title={motivo}>
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </span>
    );
  }

  if (edit === undefined) {
    return (
      <button
        type="button"
        onClick={() => onEdit(fila.dailyBudgetEur !== null ? String(fila.dailyBudgetEur) : '')}
        className="rounded px-1 text-neutral-200 underline decoration-dotted underline-offset-2 hover:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        title="Editar presupuesto"
      >
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        step={0.01}
        value={edit}
        autoFocus
        onChange={(e) => onEdit(e.target.value)}
        onBlur={() => {
          const n = Number(edit);
          if (Number.isFinite(n) && n > 0) onConfirm(n);
          else onEdit(''); // descarta
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number(edit);
            if (Number.isFinite(n) && n > 0) onConfirm(n);
          }
          if (e.key === 'Escape') onEdit('');
        }}
        className="w-24 rounded border border-border-strong bg-overlay/4 px-1 py-0.5 text-right text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        aria-label="Presupuesto en euros"
      />
    </span>
  );
}
