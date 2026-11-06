-- Suppliers reuse lot numbers across deliveries (and the prototype accepts this):
-- each receipt is its own warehouse_lots row identified by id, so the
-- (lot_number, item_id) uniqueness rule is dropped. Recall by lot number
-- already returns every matching receipt.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'warehouse_lots'::regclass
       AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
              FROM unnest(con.conkey) k
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k)
           = ARRAY['item_id', 'lot_number']
  LOOP
    EXECUTE format('ALTER TABLE warehouse_lots DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_lots_lot_number ON warehouse_lots (lot_number);
