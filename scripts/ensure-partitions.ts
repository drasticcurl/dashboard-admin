import { getPool, q1 } from '../lib/db';

/**
 * Crea las particiones mensuales de events que falten para los próximos N
 * meses (default 3). Va por cron mensual (D2): sin esto, el primer evento del
 * mes N+1 cae en events_default, que es un cajón pensado para fechas raras,
 * no para el mes en curso.
 *
 * La aritmética de meses se hace en SQL con date_trunc('month', now()), igual
 * que en la migración 003, para que el corte de mes sea el mismo que el del
 * contenedor (TZ del .env) y no dependa del reloj de la máquina que corre el
 * cron.
 */
const DEFAULT_MONTHS = 3;
const NAME_RE = /^events_\d{4}_\d{2}$/;

function parseMonths(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith('--months='));
  if (!flag) return DEFAULT_MONTHS;
  const n = Number(flag.split('=')[1]);
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    console.error(`--months inválido: ${flag} (tiene que ser un entero entre 1 y 60)`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const months = parseMonths(process.argv.slice(2));
  const pool = getPool();

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < months; i++) {
    const fromRow = await q1<{ d: string }>(
      `SELECT (date_trunc('month', now()) + ($1::int || ' month')::interval)::date::text AS d`,
      [i],
    );
    const toRow = await q1<{ d: string }>(
      `SELECT (date_trunc('month', now()) + (($1::int + 1) || ' month')::interval)::date::text AS d`,
      [i],
    );
    const from = fromRow!.d;
    const to = toRow!.d;
    // from viene como 'YYYY-MM-01' (día 1 del mes): el nombre de partición es
    // 'YYYY_MM', sin el día.
    const name = `events_${from.slice(0, 7).replaceAll('-', '_')}`;
    // El nombre sale de aritmética de fechas validada, nunca de input del
    // usuario; igual se valida el formato antes de usarlo como identificador,
    // porque va concatenado al SQL y un error acá sería inyección.
    if (!NAME_RE.test(name)) {
      throw new Error(`nombre de partición inválido: ${name}`);
    }

    const exists = await pool.query('SELECT 1 FROM pg_class WHERE relname = $1', [name]);
    if (exists.rowCount) {
      skipped += 1;
      continue;
    }
    await pool.query(
      `CREATE TABLE ${name} PARTITION OF events FOR VALUES FROM ($1) TO ($2)`,
      [from, to],
    );
    created += 1;
    console.log(`creada: ${name}`);
  }

  console.log(`particiones: ${created} creadas, ${skipped} existentes`);
  await pool.end();
}

main().catch((err) => {
  console.error('ensure-partitions falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
