const express = require('express');
const { z } = require('zod');
const { authenticate, requireMenuAccess, requireEdit, ROLE_CAN_EDIT } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { withTransaction } = require('../db');
const { loadRecipe } = require('../utils/recipeData');
const { varianceStatus } = require('../utils/costing');
const { batchRunCosts, withPackagingCost } = require('../utils/batchCosts');
const {
  bakingRequirements, packagingRequirements, yieldVariance, fifoSplit
} = require('../utils/production');
const { refundStage, deductStage, availableLots, httpError } = require('../utils/stock');

const router = express.Router();
router.use(authenticate, requireMenuAccess('production', 'wastage', 'recall', 'ready_to_ship', 'shipping'));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const splitSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().uuid(),
  quantity: z.number().min(0)
});
const countsSchema = {
  bags_575g: z.number().int().min(0).default(0),
  boxes_575g: z.number().int().min(0).default(0),
  bags_312g: z.number().int().min(0).default(0),
  boxes_312g: z.number().int().min(0).default(0)
};

const planSchema = z.object({
  batch_number: z.string().trim().min(1).max(100),
  recipe_id: z.string().uuid(),
  production_date: date.optional(),
  bins_count: z.number().positive(),
  scale_basis: z.enum(['batch', 'bin']).optional()
});
const bakingSchema = planSchema.extend({ splits: z.array(splitSchema).min(1) });
const employeeNamesSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(4);
const bakingGroupSchema = z.object({
  batch_number: z.string().trim().min(1).max(100),
  original_batch_number: z.string().trim().min(1).max(100).optional(),
  production_date: date,
  baking_employees: employeeNamesSchema,
  runs: z.array(z.object({
    id: z.string().uuid().optional(),
    recipe_id: z.string().uuid(),
    bins_large: z.number().min(0),
    bins_small: z.number().min(0),
    scale_basis: z.enum(['batch', 'bin']).optional(),
    splits: z.array(splitSchema).min(1)
  }).refine(run => run.bins_large + run.bins_small > 0, {
    message: 'Each formulation must use at least one bin'
  })).min(1).superRefine((runs, ctx) => {
    const recipeIds = new Set();
    const batchIds = new Set();
    runs.forEach((run, index) => {
      if (recipeIds.has(run.recipe_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'recipe_id'], message: 'A formulation can only appear once per batch number' });
      }
      recipeIds.add(run.recipe_id);
      if (run.id && batchIds.has(run.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'A production item can only appear once per save' });
      }
      if (run.id) batchIds.add(run.id);
    });
  })
});
const packagingSchema = z.object({ ...countsSchema, splits: z.array(splitSchema).default([]) });
const packagingGroupSchema = z.object({
  batch_number: z.string().trim().min(1).max(100),
  packaging_date: date,
  packaging_employees: employeeNamesSchema,
  runs: z.array(z.object({
    batch_id: z.string().uuid(),
    ...countsSchema,
    splits: z.array(splitSchema).default([])
  })).min(1).superRefine((runs, ctx) => {
    const batchIds = new Set();
    runs.forEach((run, index) => {
      if (batchIds.has(run.batch_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'batch_id'], message: 'A production item can only be packaged once per save' });
      }
      batchIds.add(run.batch_id);
    });
  })
});
const statusSchema = z.object({
  status: z.enum(['Quality Hold', 'Released', 'Cancelled']),
  note: z.string().max(2000).optional()
});

// Batches whose baking may still be (re)saved, and whose packaging may be (re)saved.
const BAKING_EDITABLE = ['Planned', 'In Production', 'Completed', 'Quality Hold'];
const PACKAGING_EDITABLE = ['In Production', 'Completed', 'Quality Hold'];

function handleError(e, res, next) {
  if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: e.errors });
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (e.code === '23505') return res.status(409).json({ error: 'That batch number already has a record for this formulation' });
  return next(e);
}

async function loadBatch(db, id, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM production_batches WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]
  );
  return rows[0] || null;
}

async function batchDetail(db, id) {
  const { rows } = await db.query(
    `SELECT b.*, r.name AS recipe_name,
            p.bags_575g, p.boxes_575g, p.bags_312g, p.boxes_312g
       FROM production_batches b
       JOIN recipes r ON r.id = b.recipe_id
       LEFT JOIN batch_packaging p ON p.batch_id = b.id
      WHERE b.id = $1`, [id]
  );
  if (!rows.length) return null;
  const batch = rows[0];
  const alloc = await db.query(
    `SELECT a.stage, a.lot_id, l.lot_number, a.item_id, i.name AS item_name, i.unit_type, a.quantity
       FROM batch_lot_allocations a
       JOIN warehouse_lots l ON l.id = a.lot_id
       JOIN master_items i ON i.id = a.item_id
      WHERE a.batch_id = $1
      ORDER BY a.stage, i.name, l.lot_number`, [id]
  );
  batch.baking_allocations = alloc.rows.filter(a => a.stage === 'baking');
  batch.packaging_allocations = alloc.rows.filter(a => a.stage === 'packaging');
  batch.variance_status = batch.packaged_at ? varianceStatus(Number(batch.variance_delta_grams)) : null;
  return batch;
}

async function requireRecipe(db, recipeId) {
  const recipe = await loadRecipe(db, recipeId);
  if (!recipe) throw httpError(400, 'Recipe not found');
  return recipe;
}

/** Suggested FIFO splits for each requirement. */
async function suggest(db, requirements, stage, batchId) {
  const lots = await availableLots(db, requirements.map(r => r.item_id), stage, batchId);
  return requirements.map(r => {
    const itemLots = lots.get(r.item_id) || [];
    return {
      ...r,
      lots: itemLots.map(l => ({ lot_id: l.id, lot_number: l.lot_number, available: l.available, expiry_date: l.expiry_date })),
      ...fifoSplit(itemLots, r.required)
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT b.id, b.batch_number, b.recipe_id, r.name AS recipe_name, b.production_date,
              b.bins_count, b.bins_large_count, b.bins_small_count, b.baking_employees,
              b.packaging_employees, b.packaging_date, b.scale_basis, b.status, b.status_note,
              b.theoretical_dough_grams, b.packaged_weight_grams, b.variance_delta_grams,
              b.total_pkg_cost, b.packaged_at, b.created_at,
              p.bags_575g, p.boxes_575g, p.bags_312g, p.boxes_312g
         FROM production_batches b
         JOIN recipes r ON r.id = b.recipe_id
         LEFT JOIN batch_packaging p ON p.batch_id = b.id
        ORDER BY b.production_date DESC, b.created_at DESC`
    );
    const costs = await batchRunCosts(req.db, { batchIds: rows.map(b => b.id) });
    res.json(rows.map(b => ({
      ...b,
      variance_status: b.packaged_at ? varianceStatus(Number(b.variance_delta_grams)) : null,
      ...costs.get(b.id)
    })));
  } catch (e) { next(e); }
});

// GET /api/batches/baking-requirements?recipe_id&bins_count&scale_basis[&batch_id]
router.get('/baking-requirements', async (req, res, next) => {
  try {
    const q = z.object({
      recipe_id: z.string().uuid(),
      bins_count: z.coerce.number().positive(),
      scale_basis: z.enum(['batch', 'bin']).optional(),
      batch_id: z.string().uuid().optional()
    }).parse(req.query);
    const recipe = await requireRecipe(req.db, q.recipe_id);
    const basis = q.scale_basis || recipe.scale_basis;
    let batchId = null;
    if (q.batch_id) {
      const { rows } = await req.db.query(
        'SELECT id FROM production_batches WHERE id = $1',
        [q.batch_id]
      );
      if (!rows.length) throw httpError(404, 'Batch not found for this recipe');
      batchId = rows[0].id;
    }
    const requirements = bakingRequirements(recipe, basis, q.bins_count);
    res.json({
      scale_basis: basis,
      theoretical_dough_grams: yieldVariance(recipe, basis, q.bins_count, {}).theoretical_dough_grams,
      requirements: await suggest(req.db, requirements, 'baking', batchId)
    });
  } catch (e) { handleError(e, res, next); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const batch = await batchDetail(req.db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json(batch);
  } catch (e) { next(e); }
});

// GET /api/batches/:id/packaging-requirements?bags_575g&boxes_575g&bags_312g&boxes_312g
// Live delta, packaging cost breakdown and FIFO lot suggestions for the packing screen.
router.get('/:id/packaging-requirements', async (req, res, next) => {
  try {
    const counts = z.object(Object.fromEntries(
      Object.keys(countsSchema).map(k => [k, z.coerce.number().int().min(0).default(0)])
    )).parse(req.query);
    const batch = await loadBatch(req.db, req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const recipe = await requireRecipe(req.db, batch.recipe_id);
    const pkg = packagingRequirements(recipe, batch.scale_basis, batch.bins_count, counts);
    const variance = yieldVariance(recipe, batch.scale_basis, batch.bins_count, counts);
    const run = (await batchRunCosts(req.db, { batchIds: [batch.id] })).get(batch.id);
    res.json({
      ...variance,
      variance_status: varianceStatus(variance.variance_delta_grams),
      counts: pkg.counts,
      cost: pkg.cost,
      run_cost: withPackagingCost(run, pkg.cost.total),
      requirements: await suggest(req.db, pkg.requirements, 'packaging', batch.id)
    });
  } catch (e) { handleError(e, res, next); }
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// POST /api/batches/plan — reserve a batch number (status Planned, no stock moved).
router.post('/plan', requireEdit('production'), async (req, res, next) => {
  try {
    const d = planSchema.parse(req.body);
    const batch = await withTransaction(async (client) => {
      const recipe = await requireRecipe(client, d.recipe_id);
      const basis = d.scale_basis || recipe.scale_basis;
      const { theoretical_dough_grams } = yieldVariance(recipe, basis, d.bins_count, {});
      const { rows } = await client.query(
        `INSERT INTO production_batches
           (batch_number, recipe_id, production_date, bins_count, scale_basis, theoretical_dough_grams, status)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,'Planned') RETURNING id`,
        [d.batch_number, d.recipe_id, d.production_date || null, d.bins_count, basis, theoretical_dough_grams]
      );
      const saved = await batchDetail(client, rows[0].id);
      await logAudit(client, req.user.id, 'CREATE', 'production_batch', saved.id, null, saved, req.ip);
      return saved;
    });
    res.status(201).json(batch);
  } catch (e) { handleError(e, res, next); }
});

async function saveBaking(req, res, next, editBatchId = null) {
  try {
    const d = bakingSchema.parse(req.body);
    const result = await withTransaction(async (client) => {
      const recipe = await requireRecipe(client, d.recipe_id);
      const basis = d.scale_basis || recipe.scale_basis;

      const existing = editBatchId ? await loadBatch(client, editBatchId, { lock: true }) : null;
      if (editBatchId && !existing) throw httpError(404, 'Batch not found');
      const before = existing ? await batchDetail(client, existing.id) : null;

      if (existing) {
        if (!BAKING_EDITABLE.includes(existing.status)) {
          throw httpError(409, `Batch ${existing.batch_number} is ${existing.status}; its baking can no longer be changed`);
        }
        if (existing.recipe_id !== d.recipe_id && before.packaged_at) {
          throw httpError(409, `Batch ${existing.batch_number} is already packaged; its recipe can't be changed`);
        }
        await refundStage(client, existing.id, 'baking');
      }

      let batchId = existing?.id;
      if (!batchId) {
        const { rows } = await client.query(
          `INSERT INTO production_batches (batch_number, recipe_id, bins_count, scale_basis, status)
           VALUES ($1,$2,$3,$4,'In Production') RETURNING id`,
          [d.batch_number, d.recipe_id, d.bins_count, basis]
        );
        batchId = rows[0].id;
      }

      await deductStage(client, batchId, 'baking', bakingRequirements(recipe, basis, d.bins_count), d.splits);

      const counts = before?.packaged_at ? before : {};
      const v = yieldVariance(recipe, basis, d.bins_count, counts);
      const nextStatus = !existing || existing.status === 'Planned' ? 'In Production' : existing.status;
      await client.query(
        `UPDATE production_batches
            SET recipe_id = $1, production_date = COALESCE($2::date, production_date), bins_count = $3,
                scale_basis = $4, theoretical_dough_grams = $5, variance_delta_grams = $6, status = $7
          WHERE id = $8`,
        [d.recipe_id, d.production_date || null, d.bins_count, basis,
         v.theoretical_dough_grams, before?.packaged_at ? v.variance_delta_grams : 0, nextStatus, batchId]
      );

      const saved = await batchDetail(client, batchId);
      await logAudit(client, req.user.id, existing ? 'UPDATE' : 'CREATE', 'production_batch', batchId, before, saved, req.ip);
      return saved;
    });
    res.status(editBatchId ? 200 : 201).json(result);
  } catch (e) { handleError(e, res, next); }
}

// New batch numbers are always creates. Existing baking is edited by batch ID.
router.post('/baking', requireEdit('production'), (req, res, next) => saveBaking(req, res, next));
router.put('/:id/baking', requireEdit('production'), (req, res, next) => saveBaking(req, res, next, req.params.id));

// Save every formulation under one batch number atomically.
router.post('/baking/group', requireEdit('production'), async (req, res, next) => {
  try {
    const d = bakingGroupSchema.parse(req.body);
    const saved = await withTransaction(async (client) => {
      const { rows: groupRows } = await client.query(
        `SELECT * FROM production_batches
          WHERE batch_number = $1
          ORDER BY id
          FOR UPDATE`, [d.original_batch_number || d.batch_number]
      );
      const existingById = new Map(groupRows.map(batch => [batch.id, batch]));
      const submittedIds = new Set(d.runs.map(run => run.id).filter(Boolean));
      for (const run of d.runs) {
        if (run.id && !existingById.has(run.id)) {
          throw httpError(404, `Production item ${run.id} is not part of batch ${d.original_batch_number || d.batch_number}`);
        }
      }

      for (const batch of groupRows) {
        if (submittedIds.has(batch.id)) continue;
        const shipped = await client.query(
          'SELECT COUNT(*)::int AS n FROM shipment_allocations WHERE batch_id = $1', [batch.id]
        );
        if (shipped.rows[0].n > 0) {
          throw httpError(409, `Batch ${batch.batch_number} (${batch.recipe_id}) has shipments and can't be removed from this group`);
        }
        const before = await batchDetail(client, batch.id);
        await refundStage(client, batch.id, 'baking');
        await refundStage(client, batch.id, 'packaging');
        await client.query('DELETE FROM production_batches WHERE id = $1', [batch.id]);
        await logAudit(client, req.user.id, 'DELETE', 'production_batch', batch.id, before, null, req.ip);
      }

      const runs = [];
      for (const run of d.runs) {
        const recipe = await requireRecipe(client, run.recipe_id);
        const basis = run.scale_basis || recipe.scale_basis;
        const binsCount = run.bins_large + run.bins_small;
        const existing = run.id ? existingById.get(run.id) : null;
        const before = existing ? await batchDetail(client, existing.id) : null;
        if (existing && !BAKING_EDITABLE.includes(existing.status)) {
          throw httpError(409, `Batch ${existing.batch_number} is ${existing.status}; its baking can no longer be changed`);
        }
        if (existing?.packaged_at && existing.recipe_id !== run.recipe_id) {
          throw httpError(409, `Batch ${existing.batch_number} is already packaged; its recipe can't be changed`);
        }
        if (existing) await refundStage(client, existing.id, 'baking');

        let batchId = existing?.id;
        if (!batchId) {
          const { rows } = await client.query(
            `INSERT INTO production_batches (batch_number, recipe_id, production_date, bins_count, scale_basis, status)
             VALUES ($1,$2,$3,$4,$5,'In Production') RETURNING id`,
            [d.batch_number, run.recipe_id, d.production_date, binsCount, basis]
          );
          batchId = rows[0].id;
        }

        await deductStage(client, batchId, 'baking', bakingRequirements(recipe, basis, binsCount), run.splits);
        const counts = before?.packaged_at ? before : {};
        const v = yieldVariance(recipe, basis, binsCount, counts);
        const nextStatus = !existing || existing.status === 'Planned' ? 'In Production' : existing.status;
        await client.query(
          `UPDATE production_batches
              SET batch_number = $1, recipe_id = $2, production_date = $3, bins_count = $4,
                  bins_large_count = $5, bins_small_count = $6, baking_employees = $7::jsonb,
                  scale_basis = $8, theoretical_dough_grams = $9, variance_delta_grams = $10, status = $11
            WHERE id = $12`,
          [d.batch_number, run.recipe_id, d.production_date, binsCount, run.bins_large, run.bins_small,
           JSON.stringify(d.baking_employees), basis, v.theoretical_dough_grams,
           before?.packaged_at ? v.variance_delta_grams : 0, nextStatus, batchId]
        );
        const after = await batchDetail(client, batchId);
        await logAudit(client, req.user.id, existing ? 'UPDATE' : 'CREATE',
          'production_batch', batchId, before, after, req.ip);
        runs.push(after);
      }
      return { batch_number: d.batch_number, runs };
    });
    res.status(200).json(saved);
  } catch (e) { handleError(e, res, next); }
});

// Save packaging for all formulation records under a batch number atomically.
router.post('/packaging/group', requireEdit('production'), async (req, res, next) => {
  try {
    const d = packagingGroupSchema.parse(req.body);
    const saved = await withTransaction(async (client) => {
      const { rows: groupRows } = await client.query(
        `SELECT * FROM production_batches
          WHERE batch_number = $1
          ORDER BY id
          FOR UPDATE`, [d.batch_number]
      );
      const eligible = groupRows.filter(batch => PACKAGING_EDITABLE.includes(batch.status));
      const expectedIds = eligible.map(batch => batch.id).sort();
      const submittedIds = d.runs.map(run => run.batch_id).sort();
      if (!expectedIds.length || expectedIds.length !== submittedIds.length ||
          expectedIds.some((id, index) => id !== submittedIds[index])) {
        throw httpError(409, `Refresh batch ${d.batch_number}; its production items changed before packaging was saved`);
      }

      const byId = new Map(eligible.map(batch => [batch.id, batch]));
      const runs = [];
      for (const run of d.runs) {
        const batch = byId.get(run.batch_id);
        if (!batch) throw httpError(404, 'Production item not found in this batch');
        const before = await batchDetail(client, batch.id);
        const recipe = await requireRecipe(client, batch.recipe_id);
        const pkg = packagingRequirements(recipe, batch.scale_basis, batch.bins_count, run);
        const v = yieldVariance(recipe, batch.scale_basis, batch.bins_count, run);
        await refundStage(client, batch.id, 'packaging');
        await deductStage(client, batch.id, 'packaging',
          pkg.requirements.filter(requirement => requirement.required > 0), run.splits);
        await client.query(
          `INSERT INTO batch_packaging (batch_id, bags_575g, boxes_575g, bags_312g, boxes_312g, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (batch_id) DO UPDATE SET bags_575g = EXCLUDED.bags_575g,
             boxes_575g = EXCLUDED.boxes_575g, bags_312g = EXCLUDED.bags_312g,
             boxes_312g = EXCLUDED.boxes_312g, updated_at = NOW()`,
          [batch.id, pkg.counts.bags_575g, pkg.counts.boxes_575g,
           pkg.counts.bags_312g, pkg.counts.boxes_312g]
        );
        await client.query(
          `UPDATE production_batches
              SET theoretical_dough_grams = $1, packaged_weight_grams = $2, variance_delta_grams = $3,
                  bag575_cost = $4, box575_cost = $5, bag312_cost = $6, box312_cost = $7,
                  other_pkg_cost = $8, total_pkg_cost = $9, packaged_at = NOW(),
                  packaging_date = $10, packaging_employees = $11::jsonb, status = 'Completed'
            WHERE id = $12`,
          [v.theoretical_dough_grams, v.packaged_weight_grams, v.variance_delta_grams,
           pkg.cost.bag575, pkg.cost.box575, pkg.cost.bag312, pkg.cost.box312, pkg.cost.other,
           pkg.cost.total, d.packaging_date, JSON.stringify(d.packaging_employees), batch.id]
        );
        const after = await batchDetail(client, batch.id);
        await logAudit(client, req.user.id, 'UPDATE', 'batch_packaging', batch.id, before, after, req.ip);
        runs.push(after);
      }
      return { batch_number: d.batch_number, runs };
    });
    res.json(saved);
  } catch (e) { handleError(e, res, next); }
});

// PUT /api/batches/:id/packaging — save the packing screen; refunds previous
// packaging deductions first. Packaging materials are deducted in their own unit.
router.put('/:id/packaging', requireEdit('production'), async (req, res, next) => {
  try {
    const d = packagingSchema.parse(req.body);
    const saved = await withTransaction(async (client) => {
      const batch = await loadBatch(client, req.params.id, { lock: true });
      if (!batch) throw httpError(404, 'Batch not found');
      if (!PACKAGING_EDITABLE.includes(batch.status)) {
        throw httpError(409, batch.status === 'Planned'
          ? `Batch ${batch.batch_number} has not been baked yet`
          : `Batch ${batch.batch_number} is ${batch.status}; its packaging can no longer be changed`);
      }
      const before = await batchDetail(client, batch.id);
      const recipe = await requireRecipe(client, batch.recipe_id);
      const pkg = packagingRequirements(recipe, batch.scale_basis, batch.bins_count, d);
      const v = yieldVariance(recipe, batch.scale_basis, batch.bins_count, d);

      await refundStage(client, batch.id, 'packaging');
      await deductStage(client, batch.id, 'packaging', pkg.requirements.filter(r => r.required > 0), d.splits);

      await client.query(
        `INSERT INTO batch_packaging (batch_id, bags_575g, boxes_575g, bags_312g, boxes_312g, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (batch_id) DO UPDATE SET bags_575g = EXCLUDED.bags_575g, boxes_575g = EXCLUDED.boxes_575g,
           bags_312g = EXCLUDED.bags_312g, boxes_312g = EXCLUDED.boxes_312g, updated_at = NOW()`,
        [batch.id, pkg.counts.bags_575g, pkg.counts.boxes_575g, pkg.counts.bags_312g, pkg.counts.boxes_312g]
      );
      // Re-packing sends the batch back to QA review.
      await client.query(
        `UPDATE production_batches
            SET theoretical_dough_grams = $1, packaged_weight_grams = $2, variance_delta_grams = $3,
                bag575_cost = $4, box575_cost = $5, bag312_cost = $6, box312_cost = $7,
                other_pkg_cost = $8, total_pkg_cost = $9, packaged_at = NOW(), status = 'Completed'
          WHERE id = $10`,
        [v.theoretical_dough_grams, v.packaged_weight_grams, v.variance_delta_grams,
         pkg.cost.bag575, pkg.cost.box575, pkg.cost.bag312, pkg.cost.box312, pkg.cost.other, pkg.cost.total,
         batch.id]
      );

      const after = await batchDetail(client, batch.id);
      await logAudit(client, req.user.id, 'UPDATE', 'batch_packaging', batch.id, before, after, req.ip);
      return after;
    });
    res.json(saved);
  } catch (e) { handleError(e, res, next); }
});

// PATCH /api/batches/:id/status — QA hold/release, or cancel (refunds all lots).
router.patch('/:id/status', async (req, res, next) => {
  try {
    const d = statusSchema.parse(req.body);
    const saved = await withTransaction(async (client) => {
      const batch = await loadBatch(client, req.params.id, { lock: true });
      if (!batch) throw httpError(404, 'Batch not found');
      const before = await batchDetail(client, batch.id);

      const allowedFrom = {
        'Quality Hold': ['Completed'],
        Released: ['Completed', 'Quality Hold'],
        Cancelled: ['Planned', 'In Production', 'Completed', 'Quality Hold']
      }[d.status];
      if (!allowedFrom.includes(batch.status)) {
        throw httpError(409, `A ${batch.status} batch can't be moved to ${d.status}`);
      }

      const role = req.user.role;
      const canQuality = (ROLE_CAN_EDIT.quality || []).includes(role);
      const canProduction = (ROLE_CAN_EDIT.production || []).includes(role);
      if (d.status !== 'Cancelled' && !canQuality) {
        throw httpError(403, 'Only Quality Assurance or an Administrator can hold or release a batch');
      }
      if (d.status === 'Cancelled' && !(canQuality || canProduction)) {
        throw httpError(403, 'Your role cannot cancel batches');
      }

      if (d.status === 'Cancelled') {
        await refundStage(client, batch.id, 'baking');
        await refundStage(client, batch.id, 'packaging');
      }
      await client.query(
        `UPDATE production_batches SET status = $1, status_note = $2, status_changed_at = NOW(), status_changed_by = $3
          WHERE id = $4`,
        [d.status, d.note || null, req.user.id, batch.id]
      );
      const after = await batchDetail(client, batch.id);
      await logAudit(client, req.user.id, 'STATUS_CHANGE', 'production_batch', batch.id, before, after, req.ip);
      return after;
    });
    res.json(saved);
  } catch (e) { handleError(e, res, next); }
});

// DELETE /api/batches/:id — refunds every lot deduction, as in the HTML.
router.delete('/:id', requireEdit('production'), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const batch = await loadBatch(client, req.params.id, { lock: true });
      if (!batch) throw httpError(404, 'Batch not found');
      const shipped = await client.query(
        'SELECT COUNT(*)::int AS n FROM shipment_allocations WHERE batch_id = $1', [batch.id]
      );
      if (shipped.rows[0].n > 0) {
        throw httpError(409, `Batch ${batch.batch_number} has shipments and can't be deleted (traceability)`);
      }
      const before = await batchDetail(client, batch.id);
      await refundStage(client, batch.id, 'baking');
      await refundStage(client, batch.id, 'packaging');
      await client.query('DELETE FROM production_batches WHERE id = $1', [batch.id]);
      await logAudit(client, req.user.id, 'DELETE', 'production_batch', batch.id, before, null, req.ip);
    });
    res.json({ message: 'Batch deleted; lot stock refunded' });
  } catch (e) { handleError(e, res, next); }
});

module.exports = router;
