/**
 * Los textos de los avisos del profit (PWA) — PURO: sin red ni base.
 *
 * Recibe el resultado del día (neto − gasto de ads, el mismo número del widget
 * Resultado del Resumen) y devuelve título y cuerpo. El tono es en joda a
 * propósito: el número va siempre en el título, así que el chiste nunca tapa el
 * dato.
 *
 * QUÉ CHISTE TOCA
 * El tramo sale del ROI (neto ÷ gasto, equilibrio en 1.00×) y no del monto en
 * plata: "+€200" es una fiesta con €50 de gasto y un susto con €5.000. Sin gasto
 * cargado no hay ROI y el tramo se decide por el signo del resultado.
 *
 * La frase dentro del tramo se elige con `semilla` (día + hora), así que es
 * determinística —el test la puede fijar— y no se repite la misma en los cuatro
 * avisos del día.
 */

export type Tramo = 'fuego' | 'ganancia' | 'empate' | 'perdida' | 'catastrofe' | 'sin_movimiento';

export type DatosAviso = {
  /** Neto − gasto de ads, en la moneda de reporte. */
  resultado: number;
  neto: number;
  gasto: number;
  ventas: number;
  /** null sin gasto cargado (igual que `totals.roi`). */
  roi: number | null;
  simbolo: string;
  /** true = el aviso de medianoche, que habla del día que acaba de cerrar. */
  cierre: boolean;
};

export type Aviso = { titulo: string; cuerpo: string; tramo: Tramo };

/** Menos de esto en valor absoluto es "empatado": centavos arriba o abajo no merecen drama. */
const UMBRAL_EMPATE = 5;

export function tramoDe(d: Pick<DatosAviso, 'resultado' | 'roi' | 'ventas' | 'gasto'>): Tramo {
  if (d.ventas === 0 && d.gasto === 0) return 'sin_movimiento';
  if (Math.abs(d.resultado) < UMBRAL_EMPATE) return 'empate';
  if (d.roi !== null) {
    if (d.roi >= 1.5) return 'fuego';
    if (d.roi >= 1) return 'ganancia';
    if (d.roi >= 0.6) return 'perdida';
    return 'catastrofe';
  }
  return d.resultado > 0 ? 'ganancia' : 'perdida';
}

const FRASES: Record<Tramo, readonly string[]> = {
  fuego: [
    'Esto ya no es un negocio, es una impresora de billetes. 🖨️',
    'Andá eligiendo el color del Lambo. 🏎️',
    'Meta te debería pagar a vos. 🔥',
    'Hoy invitás vos el asado, no hay discusión. 🥩',
    'Zuckerberg te está mirando con respeto. 👀',
    'Si sigue así hay que contratar a alguien que cuente la plata. 💸',
  ],
  ganancia: [
    'Verde es verde. Nadie se hizo rico quejándose. 💚',
    'Va ganando, tranqui, sin hacer ruido. 😎',
    'Rinde. No es para tirar manteca al techo, pero rinde. 🧈',
    'Vamos bien, que no se entere el contador todavía. 🤫',
    'El funnel hace su laburo. Vos tomate un café. ☕',
    'Ganando como quien no quiere la cosa. 📈',
  ],
  empate: [
    'Ni fu ni fa. Empate técnico con Zuckerberg. 🤝',
    'Tablas. El ajedrez del e-commerce. ♟️',
    'Cero a cero. Partido trabado en el mediocampo. ⚽',
    'Plata que entra, plata que sale. Equilibrio zen. 🧘',
  ],
  perdida: [
    'Rojito. Nada que un buen creativo no arregle. 🩹',
    'Meta viene ganando el partido, pero queda segundo tiempo. ⏱️',
    'Se perdió un poco. Respirá, mirá los anuncios, no rompas nada. 🫁',
    'Estamos financiando el yate de Zuckerberg. Un ratito nomás. 🛥️',
    'Va en rojo, como la cara cuando ves el gasto. 😳',
    'Pequeño traspié. Los grandes también pierden. 🙃',
  ],
  catastrofe: [
    'Houston, tenemos un problema. Mirá los anuncios YA. 🚨',
    'Meta te está comiendo vivo. Apagá algo antes de que apague tu cuenta. 🔥🧯',
    'Esto no es un funnel, es una licuadora de plata. 🌀',
    'Zuckerberg ya se compró otro yate con tu presupuesto. 🛳️',
    'Respiremos hondo y entremos al panel, porfa. 😵‍💫',
    'Si esto fuera una película sería de terror. 🎬👻',
  ],
  sin_movimiento: [
    'Ni una venta ni un peso gastado. ¿Está todo prendido? 🦗',
    'Silencio absoluto. Se escuchan los grillos. 🦗',
    'Día de descanso para todos, incluso para Meta. 😴',
  ],
};

/** Hash chico y estable (djb2) para elegir frase. No es criptografía. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function formatearMonto(valor: number, simbolo: string): string {
  const abs = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(valor)));
  const signo = valor > 0.5 ? '+' : valor < -0.5 ? '−' : '';
  return `${signo}${simbolo}${abs}`;
}

/**
 * `semilla` cambia en cada aviso (día + hora): la frase rota sin estado guardado.
 */
export function armarAvisoProfit(d: DatosAviso, semilla: string): Aviso {
  const tramo = tramoDe(d);
  const frases = FRASES[tramo];
  const frase = frases[hash(semilla) % frases.length]!;

  const monto = formatearMonto(d.resultado, d.simbolo);
  const cuando = d.cierre ? 'Cierre de ayer' : 'Hoy vamos';
  const emoji = tramo === 'fuego' || tramo === 'ganancia' ? '🟢' : tramo === 'perdida' || tramo === 'catastrofe' ? '🔴' : '⚪';
  const titulo =
    tramo === 'sin_movimiento' ? `${cuando}: sin movimiento` : `${emoji} ${cuando} ${monto}`;

  const detalle =
    tramo === 'sin_movimiento'
      ? ''
      : `\n${d.ventas} ${d.ventas === 1 ? 'venta' : 'ventas'} · gasto ${formatearMonto(d.gasto, d.simbolo).replace('+', '')}` +
        (d.roi !== null ? ` · ROI ${d.roi.toFixed(2)}×` : '');

  return { titulo, cuerpo: `${frase}${detalle}`, tramo };
}

// ─── Aviso por venta ─────────────────────────────────────────────────────────
//
// Uno por orden nueva, apenas entra el webhook: "¡Venta aprobada!" para el
// front y "Upsell aceptado" para los post-compra, con el monto en la moneda en
// la que se cobró (la que ve el cliente, no el EUR de reporte).

export type DatosVenta = {
  /** `orders.tier`: front, bump, upsell, upsell2, downsell, unknown. */
  tier: string;
  amount: number;
  currency: string;
  /** `orders.order_number` (Shopify); null en checkout propio. */
  numero: string | null;
  /** `funnels.name`; null si la venta no se pudo atribuir. */
  funnel: string | null;
  /**
   * Lo que suman los ítems `bump` de la orden. El order bump no es una orden
   * aparte: viaja en la misma que el front, así que se avisa adentro de ese aviso.
   */
  bump?: number;
};

const SIMBOLOS: Record<string, string> = { ARS: '$', USD: 'US$', EUR: '€', BRL: 'R$', MXN: 'MX$' };

/** "$ 39.990" — miles con punto, sin centavos salvo que el monto los tenga. */
export function formatearPrecio(monto: number, moneda: string): string {
  const cod = moneda.toUpperCase();
  const decimales = Number.isInteger(Math.round(monto * 100) / 100) ? 0 : 2;
  const n = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(monto);
  const simbolo = SIMBOLOS[cod];
  return simbolo ? `${simbolo} ${n}` : `${n} ${cod}`;
}

/**
 * Front y post-compra se distinguen de un vistazo por DOS lados: el emoji del
 * título (💰 / ➕), que se ve en todos lados, y el ícono (verde con $ / ámbar
 * con +), que sólo muestra Android: iOS siempre pone el ícono de la app.
 */
export type AvisoVenta = { titulo: string; cuerpo: string; tipo: 'front' | 'post' };

export function armarAvisoVenta(d: DatosVenta): AvisoVenta {
  const precio = formatearPrecio(d.amount, d.currency);
  const numero = d.numero ? ` #${d.numero}` : '';
  const funnel = d.funnel ?? 'sin atribuir';

  const post = /^upsell(\d*)$/.exec(d.tier);
  if (post) {
    const n = post[1] && post[1] !== '1' ? ` ${post[1]}` : '';
    return { titulo: `➕ Upsell${n} aceptado${numero}`, cuerpo: `${precio} (post-compra) · ${funnel}`, tipo: 'post' };
  }
  if (d.tier === 'downsell') {
    return { titulo: `➕ Downsell aceptado${numero}`, cuerpo: `${precio} (post-compra) · ${funnel}`, tipo: 'post' };
  }
  const conBump = (d.bump ?? 0) > 0;
  return {
    titulo: `💰 ¡Venta aprobada${conBump ? ' + bump' : ''}! | ${funnel}`,
    cuerpo:
      `Valor: ${precio}` +
      (conBump ? ` (bump ${formatearPrecio(d.bump!, d.currency)})` : '') +
      (numero ? ` · ${numero.trim()}` : ''),
    tipo: 'front',
  };
}
