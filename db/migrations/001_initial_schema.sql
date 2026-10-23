-- ============================================================================
-- FoodTrace ERP - Production Schema (Phase 1)
-- PostgreSQL 14+. Idempotent: safe to run repeatedly.
-- Design notes / fixes are recorded in DECISIONS.md.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. USERS, SETTINGS, AUDIT
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN (
        'Administrator','Production Operator','Quality Assurance (QA)',
        'Shipping Clerk','View-Only Guest','Custom Staff')),
    allowed_menus TEXT[] NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT true,
    force_password_reset BOOLEAN NOT NULL DEFAULT false,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- One-row settings table (key/value keeps migrations simple and additive)
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity VARCHAR(60) NOT NULL,
    entity_id TEXT,
    before_state JSONB,
    after_state JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- ============================================================================
-- 2. SUPPLIERS & MASTER ITEMS
-- ============================================================================
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    contact_info TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS master_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(20) NOT NULL CHECK (category IN ('Baking','Packaging')),
    -- 'kg' = goods measured by weight; 'units' = countable goods (bags/boxes)
    unit_type VARCHAR(10) NOT NULL CHECK (unit_type IN ('kg','units')),
    -- For kg items this is kg per purchased pack; for units items this is units per pack.
    unit_pack_size NUMERIC(14,4) NOT NULL CHECK (unit_pack_size > 0),
    cost_per_pack NUMERIC(12,4) NOT NULL CHECK (cost_per_pack >= 0),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    -- Optional default packaging role used to pre-fill recipe BOM rows
    package_role VARCHAR(20) CHECK (package_role IN ('bag','box',NULL)),
    quickbooks_item_ref VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, category)
);
CREATE INDEX IF NOT EXISTS idx_items_category ON master_items (category);
CREATE INDEX IF NOT EXISTS idx_items_supplier ON master_items (supplier_id);

-- ============================================================================
-- 3. WAREHOUSE LOTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS warehouse_lots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_number VARCHAR(100) NOT NULL,
    item_id UUID NOT NULL REFERENCES master_items(id) ON DELETE RESTRICT,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    po_number VARCHAR(100),
    dock_temp VARCHAR(30),
    packs_received NUMERIC(14,4) NOT NULL CHECK (packs_received > 0),
    -- Quantity expressed in the item's own unit_type (kg or units).
    total_quantity NUMERIC(14,4) NOT NULL CHECK (total_quantity > 0),
    remaining_quantity NUMERIC(14,4) NOT NULL CHECK (remaining_quantity >= 0),
    expiry_date DATE,
    received_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lot_number, item_id)
);
CREATE INDEX IF NOT EXISTS idx_lots_item ON warehouse_lots (item_id);
CREATE INDEX IF NOT EXISTS idx_lots_remaining ON warehouse_lots (remaining_quantity) WHERE remaining_quantity > 0;
CREATE INDEX IF NOT EXISTS idx_lots_received ON warehouse_lots (received_at);

-- ============================================================================
-- 4. RECIPES (FORMULATIONS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    scale_basis VARCHAR(10) NOT NULL DEFAULT 'batch' CHECK (scale_basis IN ('batch','bin')),
    wastage_percent NUMERIC(6,3) NOT NULL DEFAULT 2.5 CHECK (wastage_percent >= 0),
    labor_cost_per_batch NUMERIC(12,4) NOT NULL DEFAULT 150 CHECK (labor_cost_per_batch >= 0),
    manufacturer_margin_percent NUMERIC(6,3) NOT NULL DEFAULT 40,
    distributor_margin_percent NUMERIC(6,3) NOT NULL DEFAULT 20,
    retailer_margin_percent NUMERIC(6,3) NOT NULL DEFAULT 35,
    total_baking_grams NUMERIC(14,3) NOT NULL DEFAULT 0,
    total_packaging_grams NUMERIC(14,3) NOT NULL DEFAULT 0,
    -- Component costs (stored separately; single source = utils/costing.js)
    cost_per_batch NUMERIC(12,4) NOT NULL DEFAULT 0,
    dough_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    bag_material_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    box_material_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    shared_material_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    units_575 NUMERIC(10,2) NOT NULL DEFAULT 0,
    units_312 NUMERIC(10,2) NOT NULL DEFAULT 0,
    cost_per_575g NUMERIC(12,4) NOT NULL DEFAULT 0,
    cost_per_312g NUMERIC(12,4) NOT NULL DEFAULT 0,
    mfg_price_575g NUMERIC(12,4) NOT NULL DEFAULT 0,
    mfg_price_312g NUMERIC(12,4) NOT NULL DEFAULT 0,
    dist_price_575g NUMERIC(12,4) NOT NULL DEFAULT 0,
    dist_price_312g NUMERIC(12,4) NOT NULL DEFAULT 0,
    retail_price_575g NUMERIC(12,4) NOT NULL DEFAULT 0,
    retail_price_312g NUMERIC(12,4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes (name);

CREATE TABLE IF NOT EXISTS recipe_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES master_items(id) ON DELETE RESTRICT,
    grams_per_batch NUMERIC(14,3) NOT NULL CHECK (grams_per_batch > 0),
    UNIQUE (recipe_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items (recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_item ON recipe_items (item_id);

-- Packaging BOM. amount is in 'measure' (units or grams).
-- assignment: where the consumed material belongs in the cost model.
CREATE TABLE IF NOT EXISTS recipe_packaging_bom (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    packaging_id UUID NOT NULL REFERENCES master_items(id) ON DELETE RESTRICT,
    amount NUMERIC(14,4) NOT NULL CHECK (amount > 0),
    measure VARCHAR(10) NOT NULL DEFAULT 'units' CHECK (measure IN ('units','grams')),
    assignment VARCHAR(10) NOT NULL DEFAULT 'batch'
        CHECK (assignment IN ('bag575','box575','bag312','box312','batch')),
    UNIQUE (recipe_id, packaging_id)
);
CREATE INDEX IF NOT EXISTS idx_bom_recipe ON recipe_packaging_bom (recipe_id);
CREATE INDEX IF NOT EXISTS idx_bom_packaging ON recipe_packaging_bom (packaging_id);

-- ============================================================================
-- 5. PRODUCTION BATCHES
-- ============================================================================
CREATE TABLE IF NOT EXISTS production_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_number VARCHAR(100) UNIQUE NOT NULL,
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    production_date DATE NOT NULL DEFAULT CURRENT_DATE,
    bins_count NUMERIC(8,2) NOT NULL CHECK (bins_count > 0),
    scale_basis VARCHAR(10) NOT NULL DEFAULT 'batch' CHECK (scale_basis IN ('batch','bin')),
    theoretical_dough_grams NUMERIC(14,3) NOT NULL DEFAULT 0,
    packaged_weight_grams NUMERIC(14,3) NOT NULL DEFAULT 0,
    variance_delta_grams NUMERIC(14,3) NOT NULL DEFAULT 0,
    -- Packaging cost breakdown actually consumed (from lots)
    bag575_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    box575_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    bag312_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    box312_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    other_pkg_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    total_pkg_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'Baked (Awaiting Packaging)'
        CHECK (status IN ('Baked (Awaiting Packaging)','Fully Packaged & Dispatched')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batches_recipe ON production_batches (recipe_id);
CREATE INDEX IF NOT EXISTS idx_batches_date ON production_batches (production_date);
CREATE INDEX IF NOT EXISTS idx_batches_status ON production_batches (status);

CREATE TABLE IF NOT EXISTS batch_packaging (
    batch_id UUID PRIMARY KEY REFERENCES production_batches(id) ON DELETE CASCADE,
    bags_575g INTEGER NOT NULL DEFAULT 0 CHECK (bags_575g >= 0),
    boxes_575g INTEGER NOT NULL DEFAULT 0 CHECK (boxes_575g >= 0),
    bags_312g INTEGER NOT NULL DEFAULT 0 CHECK (bags_312g >= 0),
    boxes_312g INTEGER NOT NULL DEFAULT 0 CHECK (boxes_312g >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_lot_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    lot_id UUID NOT NULL REFERENCES warehouse_lots(id) ON DELETE RESTRICT,
    item_id UUID NOT NULL REFERENCES master_items(id) ON DELETE RESTRICT,
    stage VARCHAR(10) NOT NULL CHECK (stage IN ('baking','packaging')),
    -- Quantity in the item's unit_type at the time of deduction.
    quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, lot_id, stage, item_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_batch ON batch_lot_allocations (batch_id);
CREATE INDEX IF NOT EXISTS idx_alloc_lot ON batch_lot_allocations (lot_id);
CREATE INDEX IF NOT EXISTS idx_alloc_item ON batch_lot_allocations (item_id);

-- ============================================================================
-- 6. SHIPMENTS (header + explicit lines)
-- ============================================================================
CREATE TABLE IF NOT EXISTS shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(100) NOT NULL,
    customer_name VARCHAR(255) NOT NULL,
    shipped_at DATE NOT NULL DEFAULT CURRENT_DATE,
    source VARCHAR(30) NOT NULL DEFAULT 'Manual' CHECK (source IN ('Manual','QuickBooks API')),
    qbo_invoice_id VARCHAR(100),
    qbo_customer_id VARCHAR(100),
    qbo_sync_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (qbo_sync_status IN ('PENDING','SYNCED','FAILED','NOT_REQUIRED')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_qbo_invoice ON shipments (qbo_invoice_id) WHERE qbo_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_customer ON shipments (customer_name);
CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments (shipped_at);
CREATE INDEX IF NOT EXISTS idx_shipments_sync ON shipments (qbo_sync_status);

CREATE TABLE IF NOT EXISTS shipment_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
    format VARCHAR(10) NOT NULL CHECK (format IN ('575g','312g')),
    unit_type VARCHAR(10) NOT NULL CHECK (unit_type IN ('box','bag')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,4) CHECK (unit_price >= 0),
    qbo_line_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shipment_id, batch_id, format, unit_type)
);
CREATE INDEX IF NOT EXISTS idx_lines_shipment ON shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS idx_lines_batch ON shipment_lines (batch_id);

-- Box opening / manual adjustments (1 box -> 12 bags)
CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    format VARCHAR(10) NOT NULL CHECK (format IN ('575g','312g')),
    box_delta INTEGER NOT NULL DEFAULT 0,
    bag_delta INTEGER NOT NULL DEFAULT 0,
    reason VARCHAR(50) NOT NULL DEFAULT 'open_box',
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adjust_recipe ON inventory_adjustments (recipe_id, format);

-- ============================================================================
-- 7. QUICKBOOKS
-- ============================================================================
CREATE TABLE IF NOT EXISTS qbo_auth_tokens (
    realm_id VARCHAR(100) PRIMARY KEY,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    access_token_expires_at TIMESTAMPTZ NOT NULL,
    refresh_token_expires_at TIMESTAMPTZ NOT NULL,
    environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
    last_sync_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qbo_customer_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    erp_customer_name VARCHAR(255) UNIQUE NOT NULL,
    qbo_customer_id VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qbo_item_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    format VARCHAR(10) NOT NULL CHECK (format IN ('575g','312g')),
    unit_type VARCHAR(10) NOT NULL CHECK (unit_type IN ('box','bag')),
    qbo_item_id VARCHAR(100) NOT NULL,
    qbo_item_name VARCHAR(255) NOT NULL,
    unit_price NUMERIC(12,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (recipe_id, format, unit_type)
);

CREATE TABLE IF NOT EXISTS qbo_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('push','pull')),
    shipment_id UUID REFERENCES shipments(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100),
    status VARCHAR(20) NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qbo_log_created ON qbo_sync_log (created_at DESC);

-- ============================================================================
-- 8. READY-TO-SHIP VIEW (derived; never a mutable table)
-- ============================================================================
CREATE OR REPLACE VIEW ready_to_ship_inventory AS
WITH produced AS (
    SELECT b.recipe_id,
           575::int AS format,
           COALESCE(SUM(p.boxes_575g),0)::int AS boxes,
           COALESCE(SUM(p.bags_575g),0)::int AS bags
      FROM production_batches b
      JOIN batch_packaging p ON p.batch_id = b.id
     GROUP BY b.recipe_id
    UNION ALL
    SELECT b.recipe_id,
           312::int AS format,
           COALESCE(SUM(p.boxes_312g),0)::int AS boxes,
           COALESCE(SUM(p.bags_312g),0)::int AS bags
      FROM production_batches b
      JOIN batch_packaging p ON p.batch_id = b.id
     GROUP BY b.recipe_id
),
shipped AS (
    SELECT b.recipe_id,
           CASE sl.format WHEN '575g' THEN 575 ELSE 312 END AS format,
           COALESCE(SUM(CASE WHEN sl.unit_type = 'box' THEN sl.quantity ELSE 0 END),0)::int AS boxes,
           COALESCE(SUM(CASE WHEN sl.unit_type = 'bag' THEN sl.quantity ELSE 0 END),0)::int AS bags
      FROM shipment_lines sl
      JOIN production_batches b ON b.id = sl.batch_id
     GROUP BY b.recipe_id, sl.format
),
adjusted AS (
    SELECT recipe_id,
           CASE format WHEN '575g' THEN 575 ELSE 312 END AS format,
           COALESCE(SUM(box_delta),0)::int AS boxes,
           COALESCE(SUM(bag_delta),0)::int AS bags
      FROM inventory_adjustments
     GROUP BY recipe_id, format
),
keys AS (
    SELECT recipe_id, format FROM produced
    UNION SELECT recipe_id, format FROM shipped
    UNION SELECT recipe_id, format FROM adjusted
)
SELECT k.recipe_id,
       r.name AS recipe_name,
       CASE k.format WHEN 575 THEN '575g' ELSE '312g' END AS format,
       COALESCE(p.boxes,0) + COALESCE(a.boxes,0) - COALESCE(s.boxes,0) AS boxes,
       COALESCE(p.bags,0) + COALESCE(a.bags,0) - COALESCE(s.bags,0) AS bags,
       (COALESCE(p.boxes,0) + COALESCE(a.boxes,0) - COALESCE(s.boxes,0)) * 12
         + (COALESCE(p.bags,0) + COALESCE(a.bags,0) - COALESCE(s.bags,0)) AS total_bags
  FROM keys k
  JOIN recipes r ON r.id = k.recipe_id
  LEFT JOIN produced p ON p.recipe_id = k.recipe_id AND p.format = k.format
  LEFT JOIN shipped  s ON s.recipe_id = k.recipe_id AND s.format = k.format
  LEFT JOIN adjusted a ON a.recipe_id = k.recipe_id AND a.format = k.format;

-- ============================================================================
-- 9. updated_at TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','suppliers','master_items','recipes','production_batches',
                           'shipments','qbo_item_map','app_settings']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated') THEN
      EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
                      FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;
