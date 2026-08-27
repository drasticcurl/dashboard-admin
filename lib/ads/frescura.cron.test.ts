/**
 * La verificación ejecutable de R2.3 (spec `toggle-conjuntos-entrega`, task 11.2):
 * `PERIODO_SYNC_JERARQUIA_SEGUNDOS` es un espejo del crontab, y esto es lo que
 * rompe cuando el espejo se desincroniza.
 *
 * ## Qué pedía R1.4 y por qué un test y no un comentario
 *
 * El umbral de frescura y el período del cron son dos números en dos archivos
 * distintos que tienen que estar relacionados, y hasta acá el desajuste no
 * producía ningún error, no rompía ningún test y no aparecía en ninguna pantalla.
 * Este archivo lee `deploy/cron.panel`, busca la línea de
 * `scripts/sync-ads-jerarquia.ts`, traduce su schedule a segundos y lo compara con
 * la constante. Cambiar el período del cron sin tocar el código deja la suite en
 * rojo.
 *
 * **Verificado a mano en la task 11.2 (2026-08-27)**: con el schedule del archivo
 * cambiado de 15 a 30 minutos, rompe **un solo test** —el de acá abajo— con
 * `expected 1800 to be 900` y el mensaje nombrando la línea entera. Sin esa
 * comprobación el test sería una afirmación sobre sí mismo.
 *
 * ## LO QUE ESTE TEST NO CUBRE, y no es un detalle
 *
 * Compara contra el archivo del REPO, no contra `crontab -l`. Que el crontab
 * instalado en el host sea `deploy/cron.panel` es exactamente el hueco que el
 * propio `deploy/cron.panel` ya advierte —la línea del gasto de anuncios «YA ESTABA
 * EN EL CRONTAB DE LA VPS Y NO ESTABA EN ESTE ARCHIVO»— y la única forma de
 * cerrarlo es el `diff` contra `crontab -l` que ese archivo documenta. Un test de
 * la suite no puede verificarlo: no tiene el host.
 *
 * ## Precedente
 *
 * Ningún otro test del repo lee `deploy/`. Por eso queda solo en su archivo: es un
 * `readFileSync` en un test de entorno node, **sin red y sin CLI**, y si algún día
 * hay que sacarlo o moverlo se saca uno solo.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PERIODO_SYNC_JERARQUIA_SEGUNDOS } from './frescura';

const RUTA_CRONTAB = path.join(process.cwd(), 'deploy', 'cron.panel');

/** El script cuya cadencia define el período. Se busca con el path completo: con
 *  sólo `sync-ads` matchearía también la línea de `scripts/sync-ads.ts`, que es el
 *  gasto y corre cada hora. */
const SCRIPT = 'scripts/sync-ads-jerarquia.ts';

/**
 * Las líneas de crontab de verdad: sin comentarios y sin vacías. El filtro de `#`
 * importa porque los comentarios de este archivo son largos y nombran scripts.
 */
function lineasDeCron(texto: string): string[] {
  return texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Traduce los cinco campos de un schedule de cron a segundos entre corridas.
 *
 * **Traduce sólo las formas que este repo usa y TIRA con todo el resto.** No es
 * una limitación a tapar: un traductor que devuelve un número inventado para un
 * schedule que no entiende haría pasar el test con un período equivocado, que es
 * peor que no tenerlo. Si alguna vez la línea de la jerarquía pasa a una forma más
 * rara (una lista, un rango, un día de la semana), este error es la señal de que
 * hay que decidir a mano qué período tiene y escribirlo acá.
 */
function segundosEntreCorridas(schedule: string): number {
  const campos = schedule.split(/\s+/);
  if (campos.length !== 5) {
    throw new Error(
      `un schedule de cron tiene 5 campos, éste tiene ${campos.length}: «${schedule}»`,
    );
  }

  const [minuto, hora, dom, mes, dow] = campos as [string, string, string, string, string];

  // Todo lo que no sea «todos los días de todos los meses» queda fuera: una
  // cadencia diaria o semanal no es un período en segundos comparable con esto.
  if (dom !== '*' || mes !== '*' || dow !== '*') {
    throw new Error(
      `no sé traducir a segundos un schedule que no corre todos los días: «${schedule}»`,
    );
  }

  const cadaNMinutos = /^\*\/(\d+)$/.exec(minuto);
  const cadaNHoras = /^\*\/(\d+)$/.exec(hora);
  const minutoFijo = /^\d+$/.test(minuto);

  if (cadaNMinutos && hora === '*') return Number(cadaNMinutos[1]) * 60;
  if (minuto === '*' && hora === '*') return 60;
  if (minutoFijo && hora === '*') return 3_600;
  if (minutoFijo && cadaNHoras) return Number(cadaNHoras[1]) * 3_600;
  if (minutoFijo && /^\d+$/.test(hora)) return 86_400;

  throw new Error(`no sé traducir este schedule a segundos: «${schedule}»`);
}

/** La línea de la jerarquía, o un error que dice qué se buscó y dónde. */
function periodoDelCrontab(texto: string): { segundos: number; linea: string } {
  const candidatas = lineasDeCron(texto).filter((l) => l.includes(SCRIPT));

  // El caso de que la línea NO exista tiene que FALLAR, y con el mensaje puesto:
  // un test que pasa porque no encontró nada es peor que no tenerlo.
  if (candidatas.length === 0) {
    throw new Error(
      `no encontré ninguna línea con «${SCRIPT}» en ${RUTA_CRONTAB}. ` +
        `Si el script se renombró o se movió, este test y ` +
        `PERIODO_SYNC_JERARQUIA_SEGUNDOS hay que actualizarlos juntos; si la línea ` +
        `se borró, el sync de la jerarquía dejó de correr y la relectura del ` +
        `preflight es lo único que queda trayendo estado de Meta.`,
    );
  }

  // Dos líneas para el mismo script no son «más sync»: son dos cadencias y
  // ninguna es EL período. Falla en lugar de elegir una.
  if (candidatas.length > 1) {
    throw new Error(
      `hay ${candidatas.length} líneas con «${SCRIPT}» en ${RUTA_CRONTAB} y ninguna ` +
        `es el período: ${candidatas.map((l) => `«${l}»`).join(', ')}`,
    );
  }

  const linea = candidatas[0]!;
  const schedule = linea.split(/\s+/).slice(0, 5).join(' ');
  return { segundos: segundosEntreCorridas(schedule), linea };
}

describe('PERIODO_SYNC_JERARQUIA_SEGUNDOS contra deploy/cron.panel (R2.3)', () => {
  it('el archivo del crontab existe donde este test lo busca', () => {
    // Sin esto, un `deploy/` renombrado dejaría el resto de los casos fallando con
    // un ENOENT que no dice nada de lo que se está verificando.
    expect(existsSync(RUTA_CRONTAB), `no existe ${RUTA_CRONTAB}`).toBe(true);
  });

  it('el schedule de sync-ads-jerarquia.ts coincide con la constante', () => {
    const { segundos, linea } = periodoDelCrontab(readFileSync(RUTA_CRONTAB, 'utf8'));

    expect(
      segundos,
      `el crontab dice ${segundos} s y el código ${PERIODO_SYNC_JERARQUIA_SEGUNDOS} s. ` +
        `La línea es: «${linea}». Los dos números tienen que moverse juntos: el margen ` +
        `de relectura (mitad del período) sale de la constante, así que un cron más ` +
        `lento con la constante vieja deja al margen sin absorber la corrida, que es ` +
        `el bug 1 otra vez.`,
    ).toBe(PERIODO_SYNC_JERARQUIA_SEGUNDOS);
  });
});

/**
 * El traductor y el buscador, verificados aparte.
 *
 * Es lo que hace que el caso de arriba signifique algo sin tener que editar
 * `deploy/cron.panel` para verlo fallar: acá se ve que un schedule distinto da un
 * número distinto, que una línea ausente tira, y que el error nombra qué se buscó.
 * La comprobación a mano (cambiar el archivo de verdad y ver la suite en rojo) se
 * hizo una vez y está anotada en el docblock de arriba; esto es la parte que queda
 * corriendo en cada suite.
 */
describe('el traductor de schedules, y el caso de que la línea no exista', () => {
  const LINEA_REAL = readFileSync(RUTA_CRONTAB, 'utf8');

  it('traduce las formas que este crontab usa', () => {
    expect(segundosEntreCorridas('*/15 * * * *')).toBe(900);
    expect(segundosEntreCorridas('*/30 * * * *')).toBe(1_800);
    expect(segundosEntreCorridas('*/10 * * * *')).toBe(600);
    expect(segundosEntreCorridas('* * * * *')).toBe(60);
    expect(segundosEntreCorridas('7 * * * *')).toBe(3_600);
    expect(segundosEntreCorridas('0 */2 * * *')).toBe(7_200);
    // Las diarias del mismo archivo (el fetch-fx de las 05:10 y los rollups).
    expect(segundosEntreCorridas('10 5 * * *')).toBe(86_400);
  });

  it('tira con lo que no sabe traducir, en lugar de inventar un número', () => {
    // La mensual del mismo archivo: `ensure-partitions.ts` corre el día 1, y una
    // cadencia que depende del día del mes no es un período en segundos.
    expect(() => segundosEntreCorridas('0 4 1 * *')).toThrow(/no corre todos los días/);
    // Formas que un cron acepta y este traductor no: se enteran con un error.
    expect(() => segundosEntreCorridas('0,30 * * * *')).toThrow(/no sé traducir/);
    expect(() => segundosEntreCorridas('*/15 * * *')).toThrow(/5 campos/);
  });

  it('si la línea del script no está, FALLA y el error dice qué se buscó', () => {
    const sinLaLinea = LINEA_REAL.split('\n')
      .filter((l) => !l.includes(SCRIPT))
      .join('\n');

    expect(() => periodoDelCrontab(sinLaLinea)).toThrow(/sync-ads-jerarquia\.ts/);
    expect(() => periodoDelCrontab(sinLaLinea)).toThrow(/no encontré ninguna línea/);
  });

  it('si la línea está duplicada con dos cadencias, tampoco elige una', () => {
    const duplicada = `${LINEA_REAL}\n*/5 * * * * cd /srv/panel/current && node ${SCRIPT}\n`;

    expect(() => periodoDelCrontab(duplicada)).toThrow(/hay 2 líneas/);
  });

  it('un comentario que nombre el script no cuenta como la línea', () => {
    // El filtro de `#` verificado y no supuesto: los comentarios de este crontab son
    // largos y nombran scripts, y un comentario que matcheara haría fallar el conteo
    // de «hay 2 líneas» por la razón equivocada.
    const conComentario = `# ojo con ${SCRIPT}, no la borres\n${LINEA_REAL}`;

    // Se compara contra el archivo real y NO contra la constante, a propósito: este
    // caso es sobre el filtro de comentarios. Con la constante acá, cambiar el
    // schedule del crontab pondría en rojo DOS tests y uno de los dos estaría
    // mintiendo sobre qué se rompió (medido: pasa exactamente eso).
    expect(periodoDelCrontab(conComentario).segundos).toBe(periodoDelCrontab(LINEA_REAL).segundos);
  });
});
