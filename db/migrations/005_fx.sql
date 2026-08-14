-- fx_rates: la cotización del día, editable a mano (plan §3.7, D13).
--
-- rate se guarda como "1 unidad de base = rate unidades de quote" (base ARS,
-- quote EUR): con 1 EUR = 1728,65 ARS la fila es rate = 1/1728,65.
--
-- La PK (day, base, quote) permite que un INSERT ... ON CONFLICT DO UPDATE
-- pise el día a mano con source='manual' (por ejemplo, usar blue o una
-- cotización propia); el cron la escribe 1 vez por día y la fila manual gana
-- porque se inserta después.

CREATE TABLE IF NOT EXISTS fx_rates (
  day        date          NOT NULL,
  base       text          NOT NULL,
  quote      text          NOT NULL,
  rate       numeric(20,10) NOT NULL,
  source     text          NOT NULL,
  fetched_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (day, base, quote)
);
