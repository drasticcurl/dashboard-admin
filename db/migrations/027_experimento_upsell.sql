-- ═══════════════════════════════════════════════════════════════════════════
-- 027 — Declarar los brazos del test A/B del UPSELL en `chauhinchazon`.
--
-- EL BUG QUE ARREGLA, que es de nomenclatura y era silencioso: la 020 declaró
-- `experiments = ARRAY['A','B']` porque el experimento de entonces era el de la
-- PORTADA y emitía la dimensión como 'A' / 'B' pelados. El test que corre ahora
-- es otro —el segundo en el que el VSL del upsell revela el precio— y emite
-- 'pitch_A' / 'pitch_B', con prefijo a propósito: el slot `experiment` no tiene
-- un campo aparte con el nombre del experimento, así que sin el prefijo los
-- datos de este test quedarían indistinguibles de los del anterior cuando se los
-- mire dentro de seis meses (lo documenta `lib/quiz-v2/pitchVariant.ts` del
-- funnel, constante DIMENSION_PREFIX).
--
-- Con 'pitch_A' sin declarar, `lib/ingest/apply.ts` lo trata como valor
-- desconocido: NO descarta la sesión (D20: no se pierde nada, la dimensión se
-- guarda igual) pero suma un `unknown_experiment:pitch_A` a `ingest_errors` en
-- CADA lote. O sea el desglose funcionaba y el banner de avisos del embudo se
-- llenaba de ruido al mismo tiempo, que es la peor combinación: los datos
-- estaban bien y el panel gritaba que estaban mal.
--
-- SE SUMAN, NO SE REEMPLAZAN: 'A' y 'B' se quedan. Son los valores de las
-- sesiones históricas del test de portada, que siguen en la tabla, y sacarlos de
-- la declaración haría que esas filas empezaran a contar como desconocidas
-- retroactivamente. La columna declara "qué valores son legítimos en este
-- funnel", no "qué test corre hoy".
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE funnels
   SET experiments = ARRAY['A', 'B', 'pitch_A', 'pitch_B']
 WHERE slug = 'chauhinchazon';

-- LATAM NO participa de este test y por eso no se toca: `/upsell-latam` no le
-- pasa `abPitch` al reproductor, así que nunca asigna brazo. El gate es
-- estructural y no un chequeo de versión, porque un brazo asignado en LATAM no
-- tendría con qué medirse: su compra la reporta el webhook de Hotmart, que no lee
-- los cart attributes de Shopify donde viaja el brazo.

-- SIN índice nuevo, y esta vez el motivo es del lado de `orders`: el desglose
-- suma las compras del upsell con una subconsulta correlacionada por
-- `orders.session_id` que además filtra `status` y `tier`. `orders_session_idx`
-- (migración 004, parcial sobre session_id IS NOT NULL) ya la resuelve; los dos
-- filtros extra se aplican sobre las pocas filas que tiene una sesión (una o dos
-- órdenes), así que un índice compuesto pagaría mantenimiento en cada venta para
-- ahorrar un filtro sobre dos filas.
