-- lpad(text, 2) truncates longer text, so the 100th item became BAKE-10 /
-- PKG-10 and collided with uq_master_items_code. Pad to at least two digits
-- without truncating, and skip any code already taken (including codes a
-- truncated value may already have produced).
CREATE OR REPLACE FUNCTION assign_item_code() RETURNS trigger AS $$
DECLARE
  n BIGINT;
  code TEXT;
BEGIN
  IF NEW.item_code IS NULL THEN
    LOOP
      IF NEW.category = 'Baking' THEN
        n := nextval('item_code_baking_seq'::regclass);
        code := 'BAKE-' || lpad(n::text, greatest(2, length(n::text)), '0');
      ELSE
        n := nextval('item_code_packaging_seq'::regclass);
        code := 'PKG-' || lpad(n::text, greatest(2, length(n::text)), '0');
      END IF;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM master_items WHERE item_code = code);
    END LOOP;
    NEW.item_code := code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
