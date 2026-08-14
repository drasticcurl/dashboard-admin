-- Seeds: los dos funnels y sus catálogos de pasos (plan §3.12).
--
-- Las listas de pasos se verificaron contra el código antes de escribir este
-- archivo (testfunnel/lib/quiz-v2/data.ts y reset-app/lib/quiz-v2/data.ts):
-- 22 y 27 pasos, mismos ids y mismo orden que slidesV3. slidesV3Latam
-- comparte catálogo y se distingue por variant, así que no se seedea aparte
-- (D1). Si un día el código cambia y el catálogo se desalinea, el embudo
-- mostraría el nombre de una pregunta en la fila de otra: peor que no mostrar
-- nada. Se revisa con el paso 6 de la verificación de T01.
--
-- ingest_key_hash se seedea con un placeholder imposible de matchear (no es
-- un hash real y no es string vacío): si alguien despliega sin correr
-- scripts/set-ingest-key.ts, el ingest devuelve 401 en vez de aceptar
-- cualquier cosa. Encontrar una key cuyo sha256 sea
-- 'PENDING_SET_INGEST_KEY_CHAUHINCHAZON' es encontrar una preimagen de
-- sha256: no pasa.

INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash, variants, color, active)
VALUES
  ('chauhinchazon', 'Chau Hinchazón', 'America/Argentina/Buenos_Aires', 'ARS',
   'PENDING_SET_INGEST_KEY_CHAUHINCHAZON', ARRAY['ar','latam'], '#8b5cf6', true),
  ('reset', 'Protocolo Reset+', 'America/Argentina/Buenos_Aires', 'ARS',
   'PENDING_SET_INGEST_KEY_RESET', ARRAY['default'], '#8b5cf6', true)
ON CONFLICT (slug) DO NOTHING;

-- chauhinchazon · 22 pasos · testfunnel/lib/quiz-v2/data.ts
INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind)
SELECT f.id, v.step_index, v.slug, v.label, v.kind
FROM (VALUES
  (0,  'landing_hook',      'Landing',              'landing'),
  (1,  'edad',              'Edad',                 'question'),
  (2,  'tipo_cuerpo',       'Tipo de cuerpo',       'question'),
  (3,  'donde_acumula',     'Dónde acumula',        'question'),
  (4,  'viral_news',        'Nota viral',           'content'),
  (5,  'nombre',            'Nombre',               'question'),
  (6,  'como_afecta',       'Cómo le afecta',       'question'),
  (7,  'conforme_panza',    'Conforme con la panza','question'),
  (8,  'impide_deshincharse','Qué le impide deshincharse', 'question'),
  (9,  'no_es_tu_culpa',    'No es tu culpa',       'question'),
  (10, 'que_queres_lograr', 'Qué quiere lograr',    'question'),
  (11, 'peso_actual',       'Peso actual',          'question'),
  (12, 'altura',            'Altura',               'question'),
  (13, 'peso_deseado',      'Peso deseado',         'question'),
  (14, 'embarazos',         'Embarazos',            'question'),
  (15, 'rutina_diaria',     'Rutina diaria',        'question'),
  (16, 'horas_sueno',       'Horas de sueño',       'question'),
  (17, 'agua_dia',          'Agua por día',         'question'),
  (18, 'expert_bridge',     'Puente al experto',    'content'),
  (19, 'diagnosis_result',  'Diagnóstico',          'content'),
  (20, 'loading_steps',     'Armando el plan',      'content'),
  (21, 'sales_page',        'Página de venta',      'sales')
) AS v(step_index, slug, label, kind)
JOIN funnels f ON f.slug = 'chauhinchazon'
ON CONFLICT (funnel_id, step_index) DO NOTHING;

-- reset · 27 pasos · reset-app/lib/quiz-v2/data.ts
INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind)
SELECT f.id, v.step_index, v.slug, v.label, v.kind
FROM (VALUES
  (0,  'landing_hook',      'Landing',              'landing'),
  (1,  'edad',              'Edad',                 'question'),
  (2,  'tipo_cuerpo',       'Tipo de cuerpo',       'question'),
  (3,  'donde_acumula',     'Dónde acumula',        'question'),
  (4,  'viral_news',        'Nota viral',           'content'),
  (5,  'nombre',            'Nombre',               'question'),
  (6,  'probo_antes',       'Probó antes',          'question'),
  (7,  'desayuno_tipo',     'Tipo de desayuno',     'question'),
  (8,  'hora_desayuno',     'Hora del desayuno',    'question'),
  (9,  'como_afecta',       'Cómo le afecta',       'question'),
  (10, 'conforme_panza',    'Conforme con la panza','question'),
  (11, 'que_te_frena',      'Qué lo frena',         'question'),
  (12, 'no_es_tu_culpa',    'No es tu culpa',       'question'),
  (13, 'que_queres_lograr', 'Qué quiere lograr',    'question'),
  (14, 'peso_actual',       'Peso actual',          'question'),
  (15, 'altura',            'Altura',               'question'),
  (16, 'peso_deseado',      'Peso deseado',         'question'),
  (17, 'cinturon',          'Cinturón',             'question'),
  (18, 'cerveza_semana',    'Alcohol por semana',   'question'),
  (19, 'actividad_fisica',  'Actividad física',     'question'),
  (20, 'horas_sentado',     'Horas sentado',        'question'),
  (21, 'horas_sueno',       'Horas de sueño',       'question'),
  (22, 'agua_dia',          'Agua por día',         'question'),
  (23, 'expert_bridge',     'Puente al experto',    'content'),
  (24, 'diagnosis_result',  'Diagnóstico',          'content'),
  (25, 'loading_steps',     'Armando el plan',      'content'),
  (26, 'sales_page',        'Página de venta',      'sales')
) AS v(step_index, slug, label, kind)
JOIN funnels f ON f.slug = 'reset'
ON CONFLICT (funnel_id, step_index) DO NOTHING;
