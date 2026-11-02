-- A production batch number may cover multiple recipe/product records.
-- Keep each recipe unique within that shared batch number.
ALTER TABLE production_batches
  DROP CONSTRAINT IF EXISTS production_batches_batch_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_batches_number_recipe
  ON production_batches (batch_number, recipe_id);
