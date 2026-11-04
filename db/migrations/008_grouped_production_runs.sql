ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS bins_large_count NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS bins_small_count NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS baking_employees JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS packaging_employees JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS packaging_date DATE;

UPDATE production_batches
   SET bins_large_count = COALESCE(bins_large_count, FLOOR(bins_count / 2)),
       bins_small_count = COALESCE(bins_small_count, bins_count - FLOOR(bins_count / 2)),
       packaging_date = COALESCE(packaging_date, packaged_at::date)
 WHERE bins_large_count IS NULL OR bins_small_count IS NULL
    OR (packaged_at IS NOT NULL AND packaging_date IS NULL);
