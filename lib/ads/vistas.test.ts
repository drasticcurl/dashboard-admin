import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  VERSION_VISTAS,
  hayCambios,
  parseRepoVistas,
  repoVistasSchema,
  resolverVista,
  type RepoVistas,
  type Vista,
} from './vistas';
import { CATALOGO_METRICAS, columnasParaRender } from './catalogo';
import { genVista } from '../test/generadores-ads';

/**
 * Tests de ejemplo de Vista y Repo_Vistas (task 5.4). Las propiedades P3 (ida y
 * vuelta) y P4 (escritura inválida no deja rastro) viven en las tasks 5.2 y 5.3.
 */

function vistaBase(): Vista {
  return {
    id: '9f1c2f7a-3b6d-4e21-8a55-0d2a7c9b1e44',
    nombre: 'Rentabilidad',
    columnas: [
      { clave: 'seleccion', ancho: 48 },
      { clave: 'nombre', ancho: 280 },
      { clave: 'gastos', ancho: 110 },
      { clave: 'roi', ancho: 90 },
    ],
    orden: { clave: 'gastos', dir: 'desc' },
  };
}

describe('parseRepoVistas (R3 c9, c16)', () => {
  it('null (nunca se guardó) y el repo vacío son DOS estados distintos', () => {
    expect(parseRepoVistas(null)).toBeNull();
    const vacio = parseRepoVistas({ v: 1, vistas: [], porDefecto: null });
    expect(vacio).not.toBeNull();
    expect(vacio!.vistas).toEqual([]);
  });

  it('una versión desconocida no se aplica, no se borra y devuelve null (el fallback avisa)', () => {
    expect(parseRepoVistas({ v: 999, vistas: [], porDefecto: null })).toBeNull();
  });

  it('basura no tira: devuelve null', () => {
    expect(parseRepoVistas('no soy un repo')).toBeNull();
    expect(parseRepoVistas({ v: 1, vistas: [{ id: 'no-uuid' }] })).toBeNull();
  });
});

describe('esquema (R3 c4, c7, c12)', () => {
  it('rechaza una clave de columna ajena al catálogo', () => {
    const r = repoVistasSchema.safeParse({
      v: 1,
      vistas: [
        {
          ...vistaBase(),
          columnas: [
            { clave: 'seleccion', ancho: 48 },
            { clave: 'nombre', ancho: 280 },
            { clave: 'clave_ajena', ancho: 100 },
          ],
        },
      ],
      porDefecto: null,
    });
    expect(r.success).toBe(false);
  });

  it('rechaza un ancho fuera de 48..640', () => {
    const r = repoVistasSchema.safeParse({
      v: 1,
      vistas: [{ ...vistaBase(), columnas: vistaBase().columnas.map((c, i) => (i === 0 ? { ...c, ancho: 47 } : c)) }],
      porDefecto: null,
    });
    expect(r.success).toBe(false);
  });

  it('rechaza un nombre vacío o de más de 60 tras quitar los espacios de los extremos', () => {
    const vacio = repoVistasSchema.safeParse({
      v: 1,
      vistas: [{ ...vistaBase(), nombre: '   ' }],
      porDefecto: null,
    });
    expect(vacio.success).toBe(false);
    const largo = repoVistasSchema.safeParse({
      v: 1,
      vistas: [{ ...vistaBase(), nombre: 'a'.repeat(61) }],
      porDefecto: null,
    });
    expect(largo.success).toBe(false);
  });

  it('rechaza nombres repetidos sin distinguir mayúsculas', () => {
    const r = repoVistasSchema.safeParse({
      v: 1,
      vistas: [
        vistaBase(),
        { ...vistaBase(), id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nombre: 'RENTABILIDAD' },
      ],
      porDefecto: null,
    });
    expect(r.success).toBe(false);
  });

  it('rechaza porDefecto que no referencia una Vista existente', () => {
    const r = repoVistasSchema.safeParse({
      v: 1,
      vistas: [vistaBase()],
      porDefecto: '99999999-9999-4999-8999-999999999999',
    });
    expect(r.success).toBe(false);
  });

  it('marcar por defecto desmarca la anterior en la misma escritura: es un campo único del repo', () => {
    const a = vistaBase();
    const b = { ...vistaBase(), id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nombre: 'Creativos' };
    const r = repoVistasSchema.safeParse({ v: 1, vistas: [a, b], porDefecto: b.id });
    expect(r.success).toBe(true);
    expect(r.data!.porDefecto).toBe(b.id);
  });
});

describe('resolverVista (R3 c10, R5 c11)', () => {
  it('claves que el catálogo ya no declara se ignoran conservando orden relativo y anchos, y cuenta cuántas', () => {
    const vista: Vista = {
      ...vistaBase(),
      columnas: [
        { clave: 'seleccion', ancho: 48 },
        { clave: 'nombre', ancho: 280 },
        { clave: 'metrica_borrada', ancho: 120 },
        { clave: 'gastos', ancho: 110 },
        { clave: 'otra_borrada', ancho: 99 },
        { clave: 'roi', ancho: 90 },
      ],
    };
    const r = resolverVista(vista);
    expect(r.ignoradas).toEqual(['metrica_borrada', 'otra_borrada']);
    const claves = r.columnas.map((c) => c.clave);
    expect(claves).toEqual(['seleccion', 'nombre', 'gastos', 'roi']);
    expect(r.columnas.find((c) => c.clave === 'gastos')!.ancho).toBe(110);
  });

  it('acota los anchos al rango 48..640 al aplicar la Vista (R5 c11)', () => {
    const vista: Vista = {
      ...vistaBase(),
      columnas: vistaBase().columnas.map((c) => (c.clave === 'nombre' ? { ...c, ancho: 9999 } : c)),
    };
    const r = resolverVista(vista);
    expect(r.columnas.find((c) => c.clave === 'nombre')!.ancho).toBe(640);
  });

  it('no modifica la Vista guardada al ignorar claves (R3 c10)', () => {
    const vista: Vista = {
      ...vistaBase(),
      columnas: [
        ...vistaBase().columnas,
        { clave: 'metrica_borrada', ancho: 120 },
      ],
    };
    resolverVista(vista);
    expect(vista.columnas.some((c) => c.clave === 'metrica_borrada')).toBe(true);
  });

  it('un Orden_Tabla con clave ya no ordenable cae al orden por defecto', () => {
    const vista: Vista = {
      ...vistaBase(),
      orden: { clave: 'seleccion' as never, dir: 'desc' },
    };
    const r = resolverVista(vista);
    expect(r.orden).toEqual({ clave: 'gastos', dir: 'desc' });
  });
});

describe('hayCambios (R3 c13)', () => {
  it('detecta cambios de columnas, orden, anchos y Orden_Tabla', () => {
    const guardada = vistaBase();
    const resuelta = resolverVista(guardada);

    // sin cambios
    expect(hayCambios(resuelta.columnas, resuelta.orden, guardada)).toBe(false);

    // columna agregada
    const conColumna = [...resuelta.columnas, { clave: 'ctr', ancho: 80 }];
    expect(hayCambios(conColumna, resuelta.orden, guardada)).toBe(true);

    // ancho cambiado
    const conAncho = resuelta.columnas.map((c) => (c.clave === 'gastos' ? { ...c, ancho: 130 } : c));
    expect(hayCambios(conAncho, resuelta.orden, guardada)).toBe(true);

    // Orden_Tabla cambiado
    expect(hayCambios(resuelta.columnas, { clave: 'roi', dir: 'asc' }, guardada)).toBe(true);
  });

  it('sin Vista guardada compara contra las doce columnas base', () => {
    const base = columnasParaRender(
      CATALOGO_METRICAS.filter((e) => e.base).map((e) => ({
        clave: e.clave,
        ancho: e.clave === 'nombre' ? 280 : 48,
      })),
    );
    expect(hayCambios(base, { clave: 'gastos', dir: 'desc' }, null)).toBe(false);
    expect(hayCambios([...base, { clave: 'ctr', ancho: 80 }], { clave: 'gastos', dir: 'desc' }, null)).toBe(true);
  });
});

describe('constantes', () => {
  it('VERSION_VISTAS es la que declara el esquema', () => {
    expect(VERSION_VISTAS).toBe(1);
    expect(repoVistasSchema.parse({ v: VERSION_VISTAS, vistas: [], porDefecto: null }).v).toBe(1);
  });
});

// Feature: gestion-campanas-anuncios, Property 3: Una Vista sobrevive la ida y
// vuelta al Repo_Vistas
describe('Property 3 (R3 c5, c1, c3)', () => {
  it('para toda Vista válida, guardarla y volver a leerla devuelve lo mismo, sin columnas agregadas ni quitadas', () => {
    fc.assert(
      fc.property(genVista(), (vista) => {
        const repo: RepoVistas = { v: VERSION_VISTAS, vistas: [vista], porDefecto: null };
        // la ida y vuelta pasa por la serialización jsonb del Repo_Vistas
        const releido = parseRepoVistas(JSON.parse(JSON.stringify(repo)));
        expect(releido).not.toBeNull();
        const v = releido!.vistas[0]!;

        // mismo nombre normalizado (espacios de los extremos quitados)
        expect(v.nombre).toBe(vista.nombre.trim());
        // mismas claves, en las mismas posiciones de izquierda a derecha
        expect(v.columnas.map((c) => c.clave)).toEqual(vista.columnas.map((c) => c.clave));
        // mismo ancho numérico en cada columna
        expect(v.columnas.map((c) => c.ancho)).toEqual(vista.columnas.map((c) => c.ancho));
        // mismo Orden_Tabla: misma clave y mismo sentido
        expect(v.orden).toEqual(vista.orden);
        // sin columnas agregadas ni quitadas
        expect(v.columnas).toHaveLength(vista.columnas.length);
        // el id sobrevive (la identidad no es el nombre)
        expect(v.id).toBe(vista.id);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: gestion-campanas-anuncios, Property 4: Una escritura inválida al
// Endpoint_Vistas no deja rastro
describe('Property 4 (R3 c4, c15, c12, c7)', () => {
  const mutaciones = fc.constantFrom(
    'clave_ajena',
    'clave_repetida',
    'columnas_vacio',
    'ancho_chico',
    'ancho_grande',
    'nombre_vacio',
    'nombre_largo',
    'nombre_repetido',
    'orden_invalida',
    'sin_fijas',
    'porDefecto_invalido',
    'mas_de_50',
  );

  function aplicarMutacion(repo: RepoVistas, m: string, v1: Vista, v2: Vista): RepoVistas {
    const clonar = (): RepoVistas => JSON.parse(JSON.stringify(repo)) as RepoVistas;
    switch (m) {
      case 'clave_ajena': {
        const r = clonar();
        r.vistas[0]!.columnas.push({ clave: 'clave_que_no_existe', ancho: 100 });
        return r;
      }
      case 'clave_repetida': {
        const r = clonar();
        const copia = { ...r.vistas[0]!.columnas[0]! };
        r.vistas[0]!.columnas.push(copia);
        return r;
      }
      case 'columnas_vacio': {
        const r = clonar();
        r.vistas[0]!.columnas = [];
        return r;
      }
      case 'ancho_chico': {
        const r = clonar();
        r.vistas[0]!.columnas[0]!.ancho = 47;
        return r;
      }
      case 'ancho_grande': {
        const r = clonar();
        r.vistas[0]!.columnas[0]!.ancho = 641;
        return r;
      }
      case 'nombre_vacio': {
        const r = clonar();
        r.vistas[0]!.nombre = '   ';
        return r;
      }
      case 'nombre_largo': {
        const r = clonar();
        r.vistas[0]!.nombre = 'x'.repeat(61);
        return r;
      }
      case 'nombre_repetido': {
        const r = clonar();
        r.vistas[1]!.nombre = r.vistas[0]!.nombre.toUpperCase();
        return r;
      }
      case 'orden_invalida': {
        const r = clonar();
        r.vistas[0]!.orden = { clave: 'seleccion' as never, dir: 'desc' };
        return r;
      }
      case 'sin_fijas': {
        const r = clonar();
        r.vistas[0]!.columnas = r.vistas[0]!.columnas.filter((c) => c.clave !== 'nombre');
        return r;
      }
      case 'porDefecto_invalido': {
        const r = clonar();
        r.porDefecto = '99999999-9999-4999-8999-999999999999';
        return r;
      }
      case 'mas_de_50': {
        const r = clonar();
        r.vistas = Array.from({ length: 51 }, (_, i) => ({
          ...JSON.parse(JSON.stringify(v1)),
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          nombre: `${v1.nombre.trim().slice(0, 50)} ${i}`,
        }));
        return r;
      }
      default:
        return repo;
    }
  }

  it('para toda Vista válida con UNA cota rota al azar, el esquema rechaza la escritura completa y el repo parsea null', () => {
    fc.assert(
      fc.property(genVista(), genVista(), mutaciones, (v1, v2, m) => {
        // las dos Vistas base tienen que ser válidas: ids y nombres distintos
        const nombreBase = v1.nombre.trim().toLowerCase();
        if (v2.nombre.trim().toLowerCase() === nombreBase) {
          v2 = { ...v2, nombre: `${v2.nombre.trim()} b` };
        }
        if (v2.id === v1.id) v2 = { ...v2, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
        const repo: RepoVistas = { v: VERSION_VISTAS, vistas: [v1, v2], porDefecto: null };

        const mutado = aplicarMutacion(repo, m, v1, v2);
        // rechaza la escritura completa
        expect(repoVistasSchema.safeParse(mutado).success, `mutación ${m}`).toBe(false);
        // y el repo "queda como estaba": el parseo del mutado no produce repo
        expect(parseRepoVistas(mutado), `mutación ${m}`).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
