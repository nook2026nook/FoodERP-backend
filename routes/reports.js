const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess } = require('../middleware/auth');
const { varianceStatus, ROUND } = require('../utils/costing');
const { BAGS_PER_BOX } = require('../utils/production');

const router = express.Router();
router.use(authenticate);

// Calendar periods (week starts Monday), evaluated in the database's time zone.
const PERIOD_START = {
  daily: "CURRENT_DATE",
  weekly: "date_trunc('week', CURRENT_DATE)::date",
  monthly: "date_trunc('month', CURRENT_DATE)::date",
  yearly: "date_trunc('year', CURRENT_DATE)::date",
  all: 'NULL::date'
};

// GET /api/reports/shipments?timeframe=daily|weekly|monthly|yearly|all
// One row per shipment line (product_description is set for manual and QuickBooks lines).
router.get('/shipments', requireMenuAccess('reports'), async (req, res, next) => {
  try {
    const { timeframe } = z.object({
      timeframe: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'all']).default('monthly')
    }).parse(req.query);

    const { rows } = await req.db.query(
      `WITH period AS (SELECT ${PERIOD_START[timeframe]} AS start_date)
       SELECT s.id AS shipment_id, s.shipped_at, s.customer_name, s.invoice_number, s.source,
              l.id AS line_id, l.product_description, l.format, l.unit_type, l.quantity, l.allocation_status,
              COALESCE(string_agg(b.batch_number, ', ' ORDER BY b.batch_number), '') AS batches
         FROM shipments s
         JOIN shipment_lines l ON l.shipment_id = s.id
         LEFT JOIN shipment_allocations a ON a.line_id = l.id
         LEFT JOIN production_batches b ON b.id = a.batch_id
         , period
        WHERE period.start_date IS NULL OR s.shipped_at >= period.start_date
        GROUP BY s.id, l.id
        ORDER BY s.shipped_at DESC, s.invoice_number, l.created_at`
    );

    const bagsOf = (r) => (r.unit_type === 'box' ? r.quantity * BAGS_PER_BOX : r.quantity);
    const byProduct = new Map();
    for (const r of rows) {
      const key = r.product_description || 'Unmapped item';
      const p = byProduct.get(key) || { product: key, boxes: 0, bags: 0, total_bags: 0 };
      if (r.unit_type === 'box') p.boxes += r.quantity; else p.bags += r.quantity;
      p.total_bags += bagsOf(r);
      byProduct.set(key, p);
    }

    res.json({
      timeframe,
      summary: {
        shipments: new Set(rows.map(r => r.shipment_id)).size,
        customers: new Set(rows.map(r => r.customer_name)).size,
        total_bags: rows.reduce((a, r) => a + bagsOf(r), 0),
        unallocated_lines: rows.filter(r => r.allocation_status !== 'allocated').length,
        by_product: [...byProduct.values()].sort((a, b) => b.total_bags - a.total_bags)
      },
      lines: rows
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
    next(e);
  }
});

// GET /api/reports/wastage — yield variance for every packaged batch (±50 g = balanced).
router.get('/wastage', requireMenuAccess('wastage'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT b.id, b.batch_number, r.name AS recipe_name, b.production_date, b.status,
              b.bins_count, b.scale_basis, b.theoretical_dough_grams, b.packaged_weight_grams,
              b.variance_delta_grams, b.total_pkg_cost, b.bag575_cost, b.box575_cost,
              b.bag312_cost, b.box312_cost, b.other_pkg_cost,
              p.bags_575g, p.boxes_575g, p.bags_312g, p.boxes_312g
         FROM production_batches b
         JOIN recipes r ON r.id = b.recipe_id
         LEFT JOIN batch_packaging p ON p.batch_id = b.id
        WHERE b.packaged_at IS NOT NULL AND b.status <> 'Cancelled'
        ORDER BY b.production_date DESC, b.batch_number`
    );
    const batches = rows.map(b => ({ ...b, variance_status: varianceStatus(Number(b.variance_delta_grams)) }));
    const sum = (f) => batches.reduce((a, b) => a + f(b), 0);
    res.json({
      summary: {
        batches: batches.length,
        balanced: batches.filter(b => b.variance_status === 'Balanced').length,
        over_yield: batches.filter(b => b.variance_status === 'Over-Yield').length,
        scrap: batches.filter(b => b.variance_status === 'Scrap / Loss').length,
        scrap_grams: ROUND(sum(b => Math.min(0, Number(b.variance_delta_grams)))),
        over_grams: ROUND(sum(b => Math.max(0, Number(b.variance_delta_grams)))),
        theoretical_grams: ROUND(sum(b => Number(b.theoretical_dough_grams))),
        packaged_grams: ROUND(sum(b => Number(b.packaged_weight_grams))),
        packaging_cost: ROUND(sum(b => Number(b.total_pkg_cost)))
      },
      batches
    });
  } catch (e) { next(e); }
});

// GET /api/reports/inventory-value — raw material stock value (lots x catalog cost).
router.get('/inventory-value', requireMenuAccess('dashboard', 'receiving', 'reports'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT i.category,
              COALESCE(SUM(l.remaining_quantity * i.cost_per_pack / NULLIF(i.unit_pack_size, 0)), 0) AS value
         FROM warehouse_lots l JOIN master_items i ON i.id = l.item_id
        WHERE l.remaining_quantity > 0
        GROUP BY i.category`
    );
    const byCategory = Object.fromEntries(rows.map(r => [r.category, ROUND(Number(r.value))]));
    res.json({ ...byCategory, total: ROUND(rows.reduce((a, r) => a + Number(r.value), 0)) });
  } catch (e) { next(e); }
});

module.exports = router;
