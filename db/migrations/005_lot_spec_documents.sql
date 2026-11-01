-- ============================================================================
-- FoodTrace ERP - 005: specification document reference on received lots.
-- Records the name and size of the supplier specification sheet / certificate
-- that came with a lot (shown in Receiving and the recall dossier). Idempotent.
-- ============================================================================

ALTER TABLE warehouse_lots ADD COLUMN IF NOT EXISTS spec_doc_name VARCHAR(255);
ALTER TABLE warehouse_lots ADD COLUMN IF NOT EXISTS spec_doc_size VARCHAR(30);
