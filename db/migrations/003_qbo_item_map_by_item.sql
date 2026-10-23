-- ============================================================================
-- FoodTrace ERP - 003: QuickBooks item mapping is keyed by the QuickBooks item.
-- Each QuickBooks product maps to exactly one recipe + format + bag/box, and
-- several QuickBooks products (e.g. a wholesale and a retail SKU) may map to
-- the same recipe/format/unit. DECISIONS.md #36.
-- ============================================================================

ALTER TABLE qbo_item_map DROP CONSTRAINT IF EXISTS qbo_item_map_recipe_id_format_unit_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qbo_item_map_item ON qbo_item_map (qbo_item_id);
CREATE INDEX IF NOT EXISTS idx_qbo_item_map_recipe ON qbo_item_map (recipe_id);
CREATE INDEX IF NOT EXISTS idx_lines_qbo_item ON shipment_lines (qbo_item_id) WHERE qbo_item_id IS NOT NULL;
