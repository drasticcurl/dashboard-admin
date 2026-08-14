/**
 * Reglas de comisión: lectura y aplicación.
 *
 * Una regla es global (`funnelId: null`) o de un funnel, y porcentual o fija.
 * Para una venta se aplican TODAS las activas que le corresponden: las globales
 * más las de su funnel.
 *
 * Decisiones que conviene no revertir sin leer la migración 012:
 *
 * · Los porcentajes NO se componen. Todos se calculan sobre el monto de la
 *   venta, no en cascada uno sobre el resultado del anterior. Con 5 % y 3 %
 *   sobre 1000 el total es 80, no 79,85. Componer sería una sorpresa: nadie
 *   espera que el orden de dos filas cambie el resultado.
 *
 * · Una regla fija en otra moneda que la de la venta se SALTEA y se informa, en
 *   lugar de convertirse. Convertir 100 ARS a USD con la cotización del día
 *   metería una variable nueva en un número que el usuario cargó como fijo.
 *
 * · El total nunca supera el monto de la venta. Un porcentaje mal tipeado daría
 *   un neto negativo que después nadie sabe explicar.
 */

import { q } from './db';

export type CommissionKind = 'percent' | 'fixed';

export type CommissionRule = {
  id: number;
  name: string;
  /** `null` = global, aplica a todos los funnels. */
  funnelId: number | null;
  kind: CommissionKind;
  value: number;
  /** Obligatoria en las fijas, `null` en las porcentuales. */
  currency: string | null;
  active: boolean;
};

/** Lo que se congela en la orden, por regla aplicada. */
export type AppliedCommission = {
  id: number;
  name: string;
  kind: CommissionKind;
  value: number;
  currency: string | null;
  amount: number;
};

export type CommissionResult = {
  /** Total en la moneda de la venta. */
  amount: number;
  /** El total convertido con la cotización de la orden, o `null` si no había. */
  amountEur: number | null;
  breakdown: AppliedCommission[];
  /** Reglas salteadas y por qué. Se muestran como aviso, no se esconden. */
  warnings: string[];
};

const SELECT = `
  SELECT id, name, funnel_id AS "funnelId", kind,
         -- ::float8: pg devuelve numeric como string y acá se hace aritmética.
         value::float8 AS value, currency, active
  FROM commissions`;

/** Todas las reglas, para la pantalla de configuración. */
export async function listCommissions(): Promise<CommissionRule[]> {
  return q<CommissionRule>(`${SELECT} ORDER BY funnel_id NULLS FIRST, kind DESC, id`);
}

/** Las que aplican a una venta de este funnel: las globales más las suyas. */
export async function rulesForFunnel(funnelId: number | null): Promise<CommissionRule[]> {
  if (funnelId === null) {
    // Venta sin funnel resuelto (D10 paso 4): solo las globales. Se le aplican
    // igual, porque la plata entró y su costo existe.
    return q<CommissionRule>(`${SELECT} WHERE active AND funnel_id IS NULL ORDER BY id`);
  }
  return q<CommissionRule>(
    `${SELECT} WHERE active AND (funnel_id IS NULL OR funnel_id = $1) ORDER BY funnel_id NULLS FIRST, id`,
    [funnelId],
  );
}

/** Redondeo a centavos, sin arrastrar el error de punto flotante. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Aplica las reglas a una venta. Función pura: recibe las reglas ya leídas para
 * que sea testeable sin base y para no pegarle a la base por cada orden.
 */
export function applyCommissions(input: {
  amount: number;
  currency: string;
  rules: CommissionRule[];
  /** Cotización ya aplicada a esta orden (1 unidad de `currency` en euros). */
  fxRate?: number | null;
}): CommissionResult {
  const amount = Number.isFinite(input.amount) && input.amount > 0 ? input.amount : 0;
  const breakdown: AppliedCommission[] = [];
  const warnings: string[] = [];
  let total = 0;

  for (const r of input.rules) {
    if (!r.active) continue;
    if (!Number.isFinite(r.value) || r.value < 0) {
      warnings.push(`regla '${r.name}' con valor inválido: se ignoró`);
      continue;
    }

    let monto = 0;
    if (r.kind === 'percent') {
      if (r.value > 100) {
        warnings.push(`regla '${r.name}' con ${r.value} % (fuera de 0-100): se ignoró`);
        continue;
      }
      monto = round2((amount * r.value) / 100);
    } else {
      if (r.currency && r.currency !== input.currency) {
        warnings.push(
          `regla '${r.name}' es fija en ${r.currency} y la venta es en ${input.currency}: se ignoró`,
        );
        continue;
      }
      monto = round2(r.value);
    }

    if (monto <= 0) continue;
    breakdown.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      value: r.value,
      currency: r.currency,
      amount: monto,
    });
    total += monto;
  }

  total = round2(total);

  // Tope: la comisión no puede ser mayor que la venta. Si se pasa, se informa y
  // se recorta — el desglose queda igual, para que se vea de dónde vino.
  if (total > amount) {
    warnings.push(
      `las comisiones (${total}) superaban el monto de la venta (${amount}): se recortaron`,
    );
    total = amount;
  }

  const rate = input.fxRate;
  const amountEur =
    typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? round2(total * rate) : null;

  return { amount: total, amountEur, breakdown, warnings };
}
