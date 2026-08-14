\echo '=== 1. LEAST/GREATEST ignoran NULL (base del upsert de sessions, plan §3.3) ==='
SELECT LEAST('2026-01-02'::timestamptz, NULL)            AS least_con_null,
       LEAST(NULL::timestamptz, '2026-01-02'::timestamptz) AS least_null_primero,
       LEAST(NULL::timestamptz, NULL)                    AS least_todo_null,
       GREATEST(5::smallint, NULL)                       AS greatest_con_null;

\echo ''
\echo '=== 2. Seed minimo ==='
INSERT INTO funnels (slug, name, ingest_key_hash, variants)
VALUES ('chauhinchazon','Chau Hinchazon','PENDING_A', ARRAY['ar','latam']),
       ('reset','Protocolo Reset+','PENDING_B', ARRAY['default'])
ON CONFLICT (slug) DO NOTHING;

INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind)
SELECT f.id, g.i, 'paso_'||g.i, 'Paso '||g.i,
       CASE WHEN g.i=0 THEN 'landing' WHEN g.i=21 THEN 'sales' ELSE 'question' END
FROM funnels f, generate_series(0,21) AS g(i)
WHERE f.slug='chauhinchazon'
ON CONFLICT DO NOTHING;

\echo ''
\echo '=== 3. Upsert de sessions: primera escritura ==='
INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
                      max_step_index, sales_view_at, checkout_click_at,
                      utm_source, utm_campaign, country)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM funnels WHERE slug='chauhinchazon'),
        '22222222-2222-2222-2222-222222222222', 'ar', '2026-08-11',
        '2026-08-11T10:00:00Z','2026-08-11T10:00:00Z', 3, NULL, NULL,
        '(directo)','(directo)', NULL)
ON CONFLICT (id) DO NOTHING;

\echo '--- segundo lote: llega desordenado, con menos profundidad, con UTMs y con un hito ---'
INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
                      max_step_index, sales_view_at, checkout_click_at,
                      utm_source, utm_campaign, country)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM funnels WHERE slug='chauhinchazon'),
        '22222222-2222-2222-2222-222222222222', 'latam', '2026-08-12',
        '2026-08-11T09:30:00Z','2026-08-11T10:45:00Z', 1, '2026-08-11T10:40:00Z', NULL,
        'facebook','camp-x','AR')
ON CONFLICT (id) DO UPDATE SET
  started_at        = LEAST(sessions.started_at, EXCLUDED.started_at),
  last_seen_at      = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
  max_step_index    = GREATEST(sessions.max_step_index, EXCLUDED.max_step_index),
  sales_view_at     = LEAST(sessions.sales_view_at, EXCLUDED.sales_view_at),
  checkout_click_at = LEAST(sessions.checkout_click_at, EXCLUDED.checkout_click_at),
  utm_source   = CASE WHEN sessions.utm_source   = '(directo)' THEN EXCLUDED.utm_source   ELSE sessions.utm_source   END,
  utm_campaign = CASE WHEN sessions.utm_campaign = '(directo)' THEN EXCLUDED.utm_campaign ELSE sessions.utm_campaign END,
  country      = COALESCE(sessions.country, EXCLUDED.country);

SELECT max_step_index AS "max (no baja: 3)",
       started_at     AS "started (el mas viejo: 09:30)",
       last_seen_at   AS "last_seen (el mas nuevo: 10:45)",
       sales_view_at  AS "hito (se completa)",
       checkout_click_at AS "hito sin dato (sigue NULL)",
       utm_campaign   AS "utm (se completa)",
       day            AS "day (NO cambia: 08-11)",
       variant        AS "variant (NO cambia: ar)"
FROM sessions WHERE id='11111111-1111-1111-1111-111111111111';

\echo ''
\echo '=== 4. La atribucion NO se sobrescribe una vez seteada ==='
INSERT INTO sessions (id, funnel_id, visitor_id, day, started_at, last_seen_at, max_step_index, utm_campaign)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM funnels WHERE slug='chauhinchazon'),
        '22222222-2222-2222-2222-222222222222','2026-08-11',
        '2026-08-11T09:30:00Z','2026-08-11T11:00:00Z',1,'camp-PISADA')
ON CONFLICT (id) DO UPDATE SET
  utm_campaign = CASE WHEN sessions.utm_campaign = '(directo)' THEN EXCLUDED.utm_campaign ELSE sessions.utm_campaign END;
SELECT utm_campaign AS "sigue camp-x" FROM sessions WHERE id='11111111-1111-1111-1111-111111111111';

\echo ''
\echo '=== 5. Embudo: histograma + suma acumulada inversa (plan D3, task T06) ==='
INSERT INTO sessions (id, funnel_id, visitor_id, day, started_at, last_seen_at, max_step_index)
SELECT gen_random_uuid(), (SELECT id FROM funnels WHERE slug='chauhinchazon'),
       gen_random_uuid(), '2026-08-11','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z',
       (ARRAY[0,0,0,1,1,3,3,3,7,21])[1 + (g % 10)]
FROM generate_series(1,100) AS g;

WITH hist AS (
  SELECT max_step_index AS mx, count(*)::int AS n
  FROM sessions
  WHERE funnel_id = (SELECT id FROM funnels WHERE slug='chauhinchazon') AND day = '2026-08-11'
  GROUP BY 1
), base AS (SELECT sum(n)::int AS total FROM hist)
SELECT s.step_index, s.label,
       COALESCE((SELECT sum(h.n)::int FROM hist h WHERE h.mx >= s.step_index), 0) AS llegaron,
       round(100.0 * COALESCE((SELECT sum(h.n) FROM hist h WHERE h.mx >= s.step_index),0)
             / (SELECT total FROM base), 1) AS pct
FROM funnel_steps s
WHERE s.funnel_id = (SELECT id FROM funnels WHERE slug='chauhinchazon')
  AND s.step_index IN (0,1,3,7,21)
ORDER BY s.step_index;

\echo ''
\echo '=== 6. Aislamiento por funnel: reset no ve las sesiones de chauhinchazon ==='
SELECT f.slug, count(s.id)::int AS sesiones
FROM funnels f LEFT JOIN sessions s ON s.funnel_id = f.id
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 7. El unico de product_map con el centinela * (plan §3.6) ==='
INSERT INTO product_map (shop_domain, product_id, funnel_id, tier)
VALUES ('*','777',(SELECT id FROM funnels WHERE slug='reset'),'front') ON CONFLICT DO NOTHING;
INSERT INTO product_map (shop_domain, product_id, funnel_id, tier)
VALUES ('*','777',(SELECT id FROM funnels WHERE slug='reset'),'upsell') ON CONFLICT DO NOTHING;
SELECT count(*)::int AS "filas para (*,777) — tiene que ser 1" FROM product_map WHERE product_id='777';

\echo ''
\echo '=== 8. orders: el unico (source, external_id) deduplica el reenvio del webhook ==='
INSERT INTO orders (funnel_id, source, external_id, amount, currency, purchased_at, day)
VALUES ((SELECT id FROM funnels WHERE slug='reset'),'shopify','shopify_1',7790,'ARS',now(),'2026-08-11')
ON CONFLICT (source, external_id) DO NOTHING;
INSERT INTO orders (funnel_id, source, external_id, amount, currency, purchased_at, day)
VALUES ((SELECT id FROM funnels WHERE slug='reset'),'shopify','shopify_1',7790,'ARS',now(),'2026-08-11')
ON CONFLICT (source, external_id) DO NOTHING;
SELECT count(*)::int AS "ordenes shopify_1 — tiene que ser 1" FROM orders WHERE external_id='shopify_1';

\echo ''
\echo '=== 9. sum() sobre amount_eur NULL: el total no explota pero queda corto (T07) ==='
INSERT INTO orders (funnel_id, source, external_id, amount, currency, amount_eur, fx_stale, purchased_at, day)
VALUES ((SELECT id FROM funnels WHERE slug='reset'),'shopify','shopify_2',7790,'ARS',NULL,true,now(),'2026-08-11')
ON CONFLICT (source, external_id) DO NOTHING;
SELECT COALESCE(sum(amount),0) AS gross_ars,
       COALESCE(sum(amount_eur),0) AS gross_eur,
       count(*) FILTER (WHERE fx_stale)::int AS fx_stale_count
FROM orders WHERE funnel_id = (SELECT id FROM funnels WHERE slug='reset');

\echo ''
\echo '=== 10. Routing de particiones de events ==='
INSERT INTO events (funnel_id, session_id, name, step_index, occurred_at, day)
VALUES ((SELECT id FROM funnels WHERE slug='reset'),'11111111-1111-1111-1111-111111111111',
        'step_view',0, now(), CURRENT_DATE),
       ((SELECT id FROM funnels WHERE slug='reset'),'11111111-1111-1111-1111-111111111111',
        'step_view',0,'2019-01-01T00:00:00Z','2019-01-01');
SELECT tableoid::regclass AS particion, count(*)::int
FROM events GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 11. Dia local por TZ del funnel (plan D19) ==='
SELECT ('2026-08-12T02:30:00Z'::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
         AS "02:30 UTC es el 11 en ART",
       ('2026-08-12T02:30:00Z'::timestamptz AT TIME ZONE 'UTC')::date
         AS "y el 12 en UTC";
