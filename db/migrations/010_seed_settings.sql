-- Settings iniciales del panel (plan §3.10, D13, P-01).
--
-- ON CONFLICT DO NOTHING a propósito: si el usuario cambió fx_source a 'blue'
-- o la vista por defecto a 'ARS' desde la UI, re-correr la migración no se lo
-- puede pisar. El seed corre una sola vez, en la creación de la base.

INSERT INTO settings (key, value) VALUES
  ('fx_source',             '"oficial"'),
  ('default_currency_view', '"EUR"'),
  ('retention_days_events', '180')
ON CONFLICT (key) DO NOTHING;
