-- Repair item-code schema drift in databases where migration 004 was recorded
-- as applied but its schema changes are missing.
ALTER TABLE master_items ADD COLUMN IF NOT EXISTS item_code VARCHAR(20);

CREATE SEQUENCE IF NOT EXISTS item_code_baking_seq;
CREATE SEQUENCE IF NOT EXISTS item_code_packaging_seq;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, category
      FROM master_items
     WHERE item_code IS NULL
     ORDER BY created_at, name
  LOOP
    UPDATE master_items
       SET item_code = CASE r.category
             WHEN 'Baking' THEN 'BAKE-' || lpad(nextval('item_code_baking_seq')::text, 2, '0')
             ELSE 'PKG-' || lpad(nextval('item_code_packaging_seq')::text, 2, '0')
           END
     WHERE id = r.id;
  END LOOP;
END $$;

SELECT setval(
  'item_code_baking_seq',
  GREATEST(
    (SELECT last_value FROM item_code_baking_seq),
    COALESCE((SELECT MAX(substring(item_code FROM '^BAKE-([0-9]+)$')::bigint)
                FROM master_items WHERE item_code ~ '^BAKE-[0-9]+$'), 1)
  ),
  (SELECT is_called FROM item_code_baking_seq)
    OR EXISTS (SELECT 1 FROM master_items WHERE item_code ~ '^BAKE-[0-9]+$')
);

SELECT setval(
  'item_code_packaging_seq',
  GREATEST(
    (SELECT last_value FROM item_code_packaging_seq),
    COALESCE((SELECT MAX(substring(item_code FROM '^PKG-([0-9]+)$')::bigint)
                FROM master_items WHERE item_code ~ '^PKG-[0-9]+$'), 1)
  ),
  (SELECT is_called FROM item_code_packaging_seq)
    OR EXISTS (SELECT 1 FROM master_items WHERE item_code ~ '^PKG-[0-9]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_master_items_code ON master_items (item_code);

CREATE OR REPLACE FUNCTION assign_item_code() RETURNS trigger AS $$
BEGIN
  IF NEW.item_code IS NULL THEN
    NEW.item_code := CASE NEW.category
      WHEN 'Baking' THEN 'BAKE-' || lpad(nextval('item_code_baking_seq')::text, 2, '0')
      ELSE 'PKG-' || lpad(nextval('item_code_packaging_seq')::text, 2, '0')
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_item_code ON master_items;
CREATE TRIGGER trg_assign_item_code
  BEFORE INSERT ON master_items
  FOR EACH ROW EXECUTE FUNCTION assign_item_code();
