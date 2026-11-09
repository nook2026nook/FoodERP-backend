-- Production Planning (client prototype v60, 2026-11-09): saved order plans
-- (customer order -> batches, bins and material pull list). A plan is a
-- what-if worksheet: it reserves no stock and links to no lot or batch, so
-- recall queries are unaffected and the order lines live in JSONB.
CREATE TABLE IF NOT EXISTS production_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    customer_name VARCHAR(255),
    po_number VARCHAR(100),
    delivery_date DATE,
    deduct_inventory BOOLEAN NOT NULL DEFAULT true,
    -- [{recipe_id, pack_size: '575'|'312', boxes_ordered, in_stock_override?}]
    order_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Finalized')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_production_plans_updated ON production_plans (updated_at DESC);
