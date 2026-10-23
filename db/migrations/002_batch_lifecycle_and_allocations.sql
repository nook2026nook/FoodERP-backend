-- ============================================================================
-- FoodTrace ERP - 002: batch lifecycle, shipment allocations, per-batch stock
-- Client decisions 21-26 in DECISIONS.md (2026-10-23).
-- ============================================================================

-- ============================================================================
-- 1. BATCH LIFECYCLE (Decision 23)
-- ============================================================================
ALTER TABLE production_batches DROP CONSTRAINT IF EXISTS production_batches_status_check;

UPDATE production_batches SET status = 'In Production' WHERE status = 'Baked (Awaiting Packaging)';
UPDATE production_batches SET status = 'Completed'     WHERE status = 'Fully Packaged & Dispatched';

ALTER TABLE production_batches ALTER COLUMN status SET DEFAULT 'Planned';
ALTER TABLE production_batches ADD CONSTRAINT production_batches_status_check CHECK (status IN (
    'Planned','In Production','Completed','Quality Hold','Released',
    'Partially Shipped','Fully Shipped','Cancelled'));

ALTER TABLE production_batches
    ADD COLUMN IF NOT EXISTS status_note TEXT,
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS packaged_at TIMESTAMPTZ;

-- ============================================================================
-- 2. PACKAGING BOM: one material may serve several assignments
--    (e.g. the same film for 575g and 312g bags)
-- ============================================================================
ALTER TABLE recipe_packaging_bom DROP CONSTRAINT IF EXISTS recipe_packaging_bom_recipe_id_packaging_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_recipe_pkg_assignment
    ON recipe_packaging_bom (recipe_id, packaging_id, assignment);

-- ============================================================================
-- 3. SHIPMENT LINES: describe what was sold; batches come from allocations.
--    A line may be unmapped (QBO item with no recipe) and stays unallocated.
-- ============================================================================
DROP VIEW IF EXISTS ready_to_ship_inventory;

ALTER TABLE shipment_lines DROP COLUMN IF EXISTS batch_id;
ALTER TABLE shipment_lines ALTER COLUMN format DROP NOT NULL;
ALTER TABLE shipment_lines ALTER COLUMN unit_type DROP NOT NULL;
ALTER TABLE shipment_lines
    ADD COLUMN IF NOT EXISTS recipe_id UUID REFERENCES recipes(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS product_description VARCHAR(255),
    ADD COLUMN IF NOT EXISTS qbo_item_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS allocation_status VARCHAR(20) NOT NULL DEFAULT 'unallocated';

ALTER TABLE shipment_lines DROP CONSTRAINT IF EXISTS shipment_lines_allocation_status_check;
ALTER TABLE shipment_lines ADD CONSTRAINT shipment_lines_allocation_status_check
    CHECK (allocation_status IN ('allocated','partial','unallocated'));

-- Allocated lines must say exactly what product and pack they are.
ALTER TABLE shipment_lines DROP CONSTRAINT IF EXISTS shipment_lines_mapped_check;
ALTER TABLE shipment_lines ADD CONSTRAINT shipment_lines_mapped_check
    CHECK (allocation_status = 'unallocated'
           OR (recipe_id IS NOT NULL AND format IS NOT NULL AND unit_type IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_lines_recipe ON shipment_lines (recipe_id);
CREATE INDEX IF NOT EXISTS idx_lines_alloc_status ON shipment_lines (allocation_status);
-- Idempotency for QuickBooks sync: one row per invoice line.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lines_qbo_line
    ON shipment_lines (shipment_id, qbo_line_id) WHERE qbo_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_id UUID NOT NULL REFERENCES shipment_lines(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
    boxes INTEGER NOT NULL DEFAULT 0 CHECK (boxes >= 0),
    bags INTEGER NOT NULL DEFAULT 0 CHECK (bags >= 0),
    method VARCHAR(10) NOT NULL DEFAULT 'fifo' CHECK (method IN ('fifo','manual')),
    allocated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (boxes + bags > 0),
    UNIQUE (line_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_ship_alloc_line ON shipment_allocations (line_id);
CREATE INDEX IF NOT EXISTS idx_ship_alloc_batch ON shipment_allocations (batch_id);

-- ============================================================================
-- 4. BOX OPENING is tracked per batch so recall still knows where bags came from
-- ============================================================================
ALTER TABLE inventory_adjustments
    ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES production_batches(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_adjust_batch ON inventory_adjustments (batch_id, format);

-- ============================================================================
-- 5. FINISHED-GOODS STOCK (derived; never a mutable table)
-- ============================================================================
CREATE OR REPLACE VIEW batch_finished_stock AS
WITH packed AS (
    SELECT b.id AS batch_id, b.recipe_id, b.batch_number, b.production_date, b.status,
           f.format, f.boxes, f.bags
      FROM production_batches b
      JOIN batch_packaging p ON p.batch_id = b.id
     CROSS JOIN LATERAL (VALUES ('575g'::varchar, p.boxes_575g, p.bags_575g),
                                ('312g'::varchar, p.boxes_312g, p.bags_312g)) AS f(format, boxes, bags)
     WHERE b.status <> 'Cancelled'
),
shipped AS (
    SELECT a.batch_id, l.format,
           SUM(a.boxes)::int AS boxes, SUM(a.bags)::int AS bags
      FROM shipment_allocations a
      JOIN shipment_lines l ON l.id = a.line_id
     GROUP BY a.batch_id, l.format
),
adjusted AS (
    SELECT batch_id, format,
           SUM(box_delta)::int AS boxes, SUM(bag_delta)::int AS bags
      FROM inventory_adjustments
     WHERE batch_id IS NOT NULL
     GROUP BY batch_id, format
)
SELECT p.batch_id, p.recipe_id, p.batch_number, p.production_date, p.status, p.format,
       p.boxes AS packed_boxes,
       p.bags AS packed_bags,
       COALESCE(s.boxes, 0) AS shipped_boxes,
       COALESCE(s.bags, 0) AS shipped_bags,
       p.boxes + COALESCE(a.boxes, 0) - COALESCE(s.boxes, 0) AS boxes_on_hand,
       p.bags + COALESCE(a.bags, 0) - COALESCE(s.bags, 0) AS bags_on_hand
  FROM packed p
  LEFT JOIN shipped s ON s.batch_id = p.batch_id AND s.format = p.format
  LEFT JOIN adjusted a ON a.batch_id = p.batch_id AND a.format = p.format;

-- boxes/bags = stock that may ship (QA released). awaiting_qa_* = packed but not released.
CREATE OR REPLACE VIEW ready_to_ship_inventory AS
SELECT s.recipe_id,
       r.name AS recipe_name,
       s.format,
       COALESCE(SUM(s.boxes_on_hand) FILTER (WHERE s.status IN ('Released','Partially Shipped','Fully Shipped')), 0)::int AS boxes,
       COALESCE(SUM(s.bags_on_hand)  FILTER (WHERE s.status IN ('Released','Partially Shipped','Fully Shipped')), 0)::int AS bags,
       COALESCE(SUM(s.boxes_on_hand * 12 + s.bags_on_hand)
                FILTER (WHERE s.status IN ('Released','Partially Shipped','Fully Shipped')), 0)::int AS total_bags,
       COALESCE(SUM(s.boxes_on_hand) FILTER (WHERE s.status IN ('In Production','Completed','Quality Hold')), 0)::int AS awaiting_qa_boxes,
       COALESCE(SUM(s.bags_on_hand)  FILTER (WHERE s.status IN ('In Production','Completed','Quality Hold')), 0)::int AS awaiting_qa_bags
  FROM batch_finished_stock s
  JOIN recipes r ON r.id = s.recipe_id
 GROUP BY s.recipe_id, r.name, s.format;
