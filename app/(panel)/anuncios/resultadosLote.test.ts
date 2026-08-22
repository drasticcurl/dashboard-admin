import { describe, expect, it } from 'vitest';
import {
  leyendaDeLista,
  necesitaRenglon,
  textoDeLaEdad,
  textoQuePaso,
  type ResultadoLote,
} from './ResultadosLote';
import { MOTIVO_TEXTO } from '@/lib/ads/mensajes';

/**
 * La lista por objeto de `ResultadosLote` (R3.4, R6.4, R6.1).
 *
 * EL AGUJERO QUE ESTE ARCHIVO CIERRA. `avisoDeLote` devuelve `null` para un lote
 * de varios objetos en el que algo se aplicó, y su comentario deja dicho que las
 * advertencias por objeto van en esta lista. La lista no las mostraba y además
 * filtraba por `estado !== 'confirmado'`, así que el caso completo se caía por
 * dos lados a la vez: veinte conjuntos activados bajo campañas pausadas —veinte
 * escrituras que Meta confirmó y veinte objetos que no van a entregar— no dejaban
 * ni un renglón en pantalla. El aviso de arriba callado por diseño, la lista
 * vacía por el filtro, y el resumen diciendo «20 de 20 aplicados».
 *
 * Las funciones puras y no el componente: vitest corre en node, sin jsdom
 * (`vitest.config.ts`), y estas cuatro son todo el texto y todo el criterio de
 * inclusión del renglón. El JSX que las usa no decide nada más.
 */

function resultado(over: Partial<ResultadoLote> = {}): ResultadoLote {
  return {
    objectId: '120000000000000001',
    objectName: 'Conjunto frío EUR',
    estado: 'omitido',
    mensaje: null,
    codigoMeta: null,
    ...over,
  };
}

const PADRE_APAGADO =
  'la campaña está pausada: el conjunto queda activo pero no entrega hasta que se active la campaña';

describe('necesitaRenglon: qué objetos entran a la lista', () => {
  it('un confirmado CON advertencia entra: es el caso que no dejaba rastro en pantalla', () => {
    const r = resultado({ estado: 'confirmado', advertencia: PADRE_APAGADO });
    expect(necesitaRenglon(r)).toBe(true);
  });

  it('un confirmado sin advertencia no entra: el conteo de arriba ya lo cuenta', () => {
    expect(necesitaRenglon(resultado({ estado: 'confirmado', advertencia: null }))).toBe(false);
    // Sin la clave, que es lo que manda el route para las acciones que no
    // calculan advertencia.
    expect(necesitaRenglon(resultado({ estado: 'confirmado' }))).toBe(false);
    // `advertencia: ''` es un servidor que no dijo nada, no una advertencia vacía
    // que haya que dibujar.
    expect(necesitaRenglon(resultado({ estado: 'confirmado', advertencia: '' }))).toBe(false);
  });

  it('los cuatro desenlaces que no son un cambio aplicado entran siempre', () => {
    for (const estado of ['fallido', 'indeterminado', 'omitido', 'no_intentado'] as const) {
      expect(necesitaRenglon(resultado({ estado }))).toBe(true);
    }
  });
});

describe('textoQuePaso: el motivo y la advertencia no compiten', () => {
  it('con los dos muestra los dos, con el mismo separador que la Previsualizacion', () => {
    // El caso mayoritario de la cuenta real: omitido por «ya está en ese estado» Y
    // sin entregar porque el padre está apagado.
    const texto = textoQuePaso(
      resultado({ motivo: 'ya_esta_en_ese_estado', advertencia: PADRE_APAGADO }),
    );
    expect(texto).toBe(`${MOTIVO_TEXTO.ya_esta_en_ese_estado} · ${PADRE_APAGADO}`);
  });

  it('con la advertencia sola la muestra sola: es el renglón de un aplicado', () => {
    const texto = textoQuePaso(resultado({ estado: 'confirmado', advertencia: PADRE_APAGADO }));
    expect(texto).toBe(PADRE_APAGADO);
  });

  it('el motivo sale del catálogo y no como clave cruda', () => {
    const texto = textoQuePaso(resultado({ motivo: 'ya_esta_entregando' }));
    expect(texto).toBe(MOTIVO_TEXTO.ya_esta_entregando);
    expect(texto).not.toContain('ya_esta_entregando');
  });

  it('un motivo que este cliente no conoce se muestra igual, no se traga el renglón', () => {
    // El cuerpo entra de un `res.json()`: un servidor más nuevo puede mandar un
    // motivo que este catálogo todavía no tiene. La clave cruda es peor que el
    // texto y mucho mejor que un hueco.
    const texto = textoQuePaso(resultado({ motivo: 'motivo_del_futuro' as never }));
    expect(texto).toBe('motivo_del_futuro');
  });

  it('sin motivo ni advertencia devuelve vacío, y ahí el renglón queda con el resultado solo', () => {
    expect(textoQuePaso(resultado({ estado: 'fallido', mensaje: 'Meta rechazó el cambio.' }))).toBe('');
  });
});

describe('textoDeLaEdad: la antigüedad del dato de una Omisión (R6.1)', () => {
  it('la compone con las mismas palabras que el aviso de un objeto solo', () => {
    const r = resultado({ motivo: 'ya_esta_en_ese_estado', edadDelDato: 'de hace 5 d' });
    expect(textoDeLaEdad(r)).toBe('Se decidió según un dato de hace 5 d.');
  });

  it('no dice nada cuando no viajó: los desenlaces que decidió Meta no la llevan', () => {
    expect(textoDeLaEdad(resultado({ estado: 'confirmado' }))).toBeNull();
    expect(textoDeLaEdad(resultado({ edadDelDato: null }))).toBeNull();
    expect(textoDeLaEdad(resultado({ edadDelDato: '' }))).toBeNull();
  });
});

describe('leyendaDeLista: la lista dice qué es', () => {
  const omitido = resultado({ objectId: '1', motivo: 'ya_esta_en_ese_estado' });
  const aplicadoConAviso = resultado({
    objectId: '2',
    estado: 'confirmado',
    advertencia: PADRE_APAGADO,
  });

  it('sin aplicados, habla de los que no se aplicaron', () => {
    expect(leyendaDeLista([omitido])).toContain('no se aplicaron');
  });

  it('con todos aplicados, no puede decir que no se aplicaron', () => {
    const leyenda = leyendaDeLista([aplicadoConAviso, aplicadoConAviso]);
    expect(leyenda).toContain('se aplicaron en Meta');
    expect(leyenda).toContain('advertir');
  });

  it('con las dos clases juntas, nombra las dos', () => {
    const leyenda = leyendaDeLista([omitido, aplicadoConAviso]);
    expect(leyenda).toContain('no se aplicaron');
    expect(leyenda).toContain('advertencia');
  });
});
