/**
 * `npm run ads:auditar-montos` — el reporte de los montos YA GUARDADOS que
 * huelen al bug de parseo de `parseo-montos-anuncios` (cláusulas 2.12 y 2.13).
 *
 * SÓLO LECTURA, Y ESO ES EL CONTRATO
 * 2.12 pide que no modifique ninguna fila, y la forma de garantizarlo no es una
 * promesa: en este archivo no hay una sola sentencia de escritura. Una consulta,
 * un `SELECT`, sin transacción, sin `UPDATE`, sin `INSERT`, sin `DELETE`. Si
 * alguna vez hace falta corregir algo, se hace a mano y no acá.
 *
 * POR QUÉ NO CORRIGE (decisión 2 del bugfix)
 * Un `budget_max = 1` no se distingue con certeza de un techo de un euro puesto a
 * propósito. Cualquier `UPDATE` automático arriesga pisar un valor deliberado en
 * una regla que mueve plata real. Así que esto SEÑALA y decide una persona: todo
 * lo que imprime es **sospechoso, no error** (2.13).
 *
 * EL UMBRAL NO ESTÁ EN EL SQL
 * El `SELECT` es amplio y el filtro lo hace `sospechasDeRegla` de
 * `lib/ads/reglas/sospecha.ts`, el mismo predicado que usa el aviso de la lista
 * de Reglas. Si el `WHERE` filtrara por el umbral habría dos reglas capaces de
 * discrepar —una en SQL y otra en TypeScript—, que es exactamente el error que
 * este spec vino a arreglar en el parseo. Son cientos de filas: el costo de
 * traerlas todas es irrelevante al lado de tener dos verdades.
 *
 * EL EXIT CODE
 * Sale con 0 con cualquier cantidad de sospechas, incluidas cero. Es un reporte
 * para leer, no un gate de CI: un exit code distinto lo convertiría en algo que
 * alguien va a «arreglar» silenciando el script. Sale con 1 en un solo caso, que
 * no es un hallazgo sino la ausencia de reporte: cuando no pudo LEER la base
 * (sin `DATABASE_URL`, o Postgres caído). Ahí un 0 diría «no hay nada
 * sospechoso», que es la mentira más cara que este script puede contar.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPool, q } from '../lib/db';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '../lib/moneda-reporte';
import {
  METRICAS_EUR_AUDITABLES,
  METRICAS_NO_AUDITABLES,
  UMBRAL_ALTO_EUR,
  UMBRAL_BAJO_EUR,
  sospechasDeRegla,
  type ReglaAuditable,
  type Sospecha,
} from '../lib/ads/reglas/sospecha';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * La fila del JOIN. Los `numeric` de pg llegan como string (`'1.50'`) y se
 * convierten con `Number()` una sola vez, en el mapeo de abajo — el mismo
 * criterio que `lib/ads/reglas/repo.ts`.
 */
type Fila = {
  id: number;
  account_id: string;
  name: string;
  action: string;
  action_unit: string | null;
  action_value: string | null;
  budget_max: string | null;
  budget_min: string | null;
  max_runs_per_day: number | null;
  metric: string | null;
  op: string | null;
  value: string | null;
  position: number | null;
};

/**
 * LA ÚNICA consulta del script, y es un `SELECT`.
 *
 * `LEFT JOIN` y no `JOIN`: una regla sin condiciones («aplica a todo») también
 * tiene techo, piso y valor de acción, y es justo la que más caro sale si su
 * importe está corrompido. Ordenada por cuenta, regla y `position` porque la
 * etiqueta de una condición dice «(condición N)» con N = índice + 1, igual que
 * la pantalla: sin este orden el número del reporte no coincidiría con el que la
 * persona ve en el formulario.
 */
const SQL = `
  SELECT r.id, r.account_id, r.name, r.action, r.action_unit, r.action_value,
         r.budget_max, r.budget_min, r.max_runs_per_day,
         c.metric, c.op, c.value, c.position
    FROM ad_rules r
    LEFT JOIN ad_rule_conditions c ON c.rule_id = r.id
   ORDER BY r.account_id, r.id, c.position`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** Lo que el reporte necesita de cada regla: la parte auditable más su identidad. */
type ReglaLeida = ReglaAuditable & {
  id: number;
  accountId: string;
  name: string;
  action: string;
};

/** Las filas del JOIN agrupadas por regla, conservando el orden del `ORDER BY`. */
function agrupar(filas: readonly Fila[]): ReglaLeida[] {
  const porId = new Map<number, ReglaLeida>();
  const orden: number[] = [];

  for (const f of filas) {
    let regla = porId.get(f.id);
    if (!regla) {
      regla = {
        id: f.id,
        accountId: f.account_id,
        name: f.name,
        action: f.action,
        actionUnit: f.action_unit,
        actionValue: num(f.action_value),
        budgetMax: num(f.budget_max),
        budgetMin: num(f.budget_min),
        maxRunsPerDay: f.max_runs_per_day,
        condiciones: [],
      };
      porId.set(f.id, regla);
      orden.push(f.id);
    }
    // Con LEFT JOIN, una regla sin condiciones trae una fila con los tres campos
    // en NULL. No es una condición vacía: es la ausencia de condiciones.
    if (f.metric !== null && f.op !== null && f.value !== null) {
      (regla.condiciones as { metric: string; op: string; value: number }[]).push({
        metric: f.metric,
        op: f.op,
        value: Number(f.value),
      });
    }
  }

  return orden.map((id) => porId.get(id)!);
}

const eur = (n: number): string => `${SIMBOLO_REPORTE}${n.toFixed(2)}`;

/** Los nombres de las bandas, tal como los define §Decisión 5 del diseño. */
const NOMBRE_BANDA: Record<Sospecha['banda'], string> = {
  alta: 'muy probable',
  baja: 'posible',
};

function imprimirSospecha(s: Sospecha): void {
  const marca = s.extension ? '  (extensión sobre 2.12: es un porcentaje, no un importe)' : '';
  console.log(
    `    · ${s.etiqueta.padEnd(26)} guardado ${String(s.valor).padEnd(9)}` +
      `texto probable «${s.textoProbable}» → quiso decir ${s.valorProbable}` +
      `   [${NOMBRE_BANDA[s.banda]}]${marca}`,
  );
}

async function main(): Promise<void> {
  console.log('Auditoría de montos guardados en las reglas de anuncios — SÓLO LECTURA');
  console.log(
    `Bandas: «muy probable» por debajo de ${eur(UMBRAL_ALTO_EUR)} · ` +
      `«posible» de ${eur(UMBRAL_ALTO_EUR)} a ${eur(UMBRAL_BAJO_EUR - 0.01)} · ` +
      `desde ${eur(UMBRAL_BAJO_EUR)} no se reporta nada.`,
  );
  console.log(
    'La corrupción divide por 1000, así que una intención de cuatro dígitos (1000–9999) cae en la\n' +
      'primera banda y una de cinco (10.000, 25.000) en la segunda. Dos bandas y no una para que la\n' +
      'segunda familia no se pierda en silencio y el reporte no se llene de techos chicos legítimos.\n',
  );

  const filas = await q<Fila>(SQL);
  const reglas = agrupar(filas);
  const condiciones = filas.filter((f) => f.metric !== null).length;

  if (reglas.length === 0) {
    // Decirlo en voz alta: un reporte vacío por falta de datos y un reporte vacío
    // porque no hay nada sospechoso se ven igual, y significan cosas opuestas.
    console.log('NO HAY NINGUNA REGLA GUARDADA en esta base: no hay nada que auditar.');
    console.log('  (`ad_rules` está vacía. Es normal en una base local recién migrada;');
    console.log('   contra la base de producción este mensaje sería el hallazgo.)');
    return;
  }

  console.log(`${reglas.length} reglas leídas, ${condiciones} condiciones.\n`);

  let cuentaActual = '';
  let totalAlta = 0;
  let totalBaja = 0;
  let totalExtension = 0;
  let reglasConSospecha = 0;

  for (const r of reglas) {
    const sospechas = sospechasDeRegla(r);
    if (sospechas.length === 0) continue;

    reglasConSospecha++;
    if (r.accountId !== cuentaActual) {
      cuentaActual = r.accountId;
      console.log(`cuenta ${cuentaActual}`);
    }
    console.log(`  #${r.id} «${r.name}» (${r.action}${r.actionUnit ? `, ${r.actionUnit}` : ''})`);
    for (const s of sospechas) {
      imprimirSospecha(s);
      if (s.banda === 'alta') totalAlta++;
      else totalBaja++;
      if (s.extension) totalExtension++;
    }
  }

  // ─── El cierre: los totales y lo que el reporte NO puede ver ───────────────
  console.log('\n─────────────────────────────────────────────────────────────────────────────');
  if (reglasConSospecha === 0) {
    console.log(`Ninguno de los montos guardados cae en las bandas: 0 sospechas en ${reglas.length} reglas.`);
  } else {
    console.log(
      `${totalAlta + totalBaja} valores sospechosos en ${reglasConSospecha} de ${reglas.length} reglas: ` +
        `${totalAlta} «muy probable», ${totalBaja} «posible».`,
    );
    if (totalExtension > 0) {
      console.log(
        `  De esos, ${totalExtension} son porcentajes: van más allá de lo que 2.12 pide y están marcados como extensión.`,
      );
    }
  }

  console.log('\nSOSPECHOSO, NO ERROR. Un techo de €1 escrito a propósito es indistinguible de un «1.000»');
  console.log('corrompido, así que el script no corrige nada y no propone ningún UPDATE: la decisión de');
  console.log('cada línea es de una persona, mirando la regla. Este script no modificó ninguna fila.');

  console.log('\nLO QUE ESTE REPORTE NO PUEDE VER, dicho en voz alta para que la omisión no sea silenciosa:');
  console.log(
    `  · max_runs_per_day: NO DETECTABLE por decisión (2.13). Un límite de 1 ejecución por día es\n` +
      '    legítimo y frecuente, e indistinguible de un «1.000» corrompido. No se reporta ninguno.',
  );
  console.log(
    `  · condiciones de ${METRICAS_NO_AUDITABLES.join(', ')}: no se auditan.\n` +
      '    Un CPA de €8, un CPC de €0,30 y un ROI de 1,3 son valores normales; reportarlos sería\n' +
      '    ruido que entierra las sospechas reales.',
  );
  console.log(`  · sólo se auditan las condiciones de ${METRICAS_EUR_AUDITABLES.join(', ')}, que están en EUR.`);
  console.log(
    `  · un valor con más de tres decimales (ad_rule_conditions.value es numeric(16,4)) no pudo salir\n` +
      '    de un texto de tres decimales, así que no se reporta.',
  );
  console.log('  · el aviso equivalente en la pantalla de Reglas usa este mismo predicado y este mismo umbral.');
}

main()
  .then(async () => {
    await getPool().end();
    // Siempre 0: la cantidad de sospechas no es un fallo del script (ver el
    // encabezado). Lo que se hace con el reporte lo decide una persona.
    process.exit(0);
  })
  .catch(async (e) => {
    // No hubo reporte. Un 0 acá diría «no hay nada sospechoso» sin haber mirado.
    console.error('\nverificar-montos-reglas NO PUDO LEER LA BASE:', e instanceof Error ? e.message : e);
    console.error('El reporte no se generó. Verificá DATABASE_URL y que Postgres esté arriba.');
    try {
      await getPool().end();
    } catch {
      // Si el pool nunca se abrió (falta DATABASE_URL), cerrarlo también tira.
    }
    process.exit(1);
  });
