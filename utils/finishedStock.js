/**
 * Finished-goods stock per batch (575g / 312g boxes and loose bags) and the
 * allocation of shipments to batches. Always used inside a transaction.
 */
const { BAGS_PER_BOX } = require('./production');
const { httpError } = require('./stock');

// Batches whose stock may ship (DECISIONS.md #23: only QA-released stock ships).
const SHIPPABLE = ['Released', 'Partially Shipped', 'Fully Shipped'];

/** Lock the batches so concurrent shipments can't both take the same boxes. */
async function lockBatches(client, batchIds) {
  const ids = [...new Set(batchIds)].sort();
  if (ids.length) {
    await client.query('SELECT id FROM production_batches WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  }
}

/** Shippable stock of one recipe/format, oldest batch first. */
async function shippableStock(client, recipeId, format, batchId = null) {
  const { rows } = await client.query(
    `SELECT batch_id, batch_number, production_date, status, boxes_on_hand, bags_on_hand
       FROM batch_finished_stock
      WHERE recipe_id = $1 AND format = $2 AND status = ANY($3::text[])
        AND ($4::uuid IS NULL OR batch_id = $4)
      ORDER BY production_date ASC, batch_number ASC`,
    [recipeId, format, SHIPPABLE, batchId]
  );
  return rows.map(r => ({ ...r, boxes_on_hand: Number(r.boxes_on_hand), bags_on_hand: Number(r.bags_on_hand) }));
}

/**
 * Plan which batches a line draws from. Boxes come from full boxes only. Bags
 * come from loose bags first; when a batch runs out of loose bags, boxes in that
 * batch are opened (1 box = 12 bags) and recorded as an adjustment.
 * Returns { plan: [{batch_id, batch_number, boxes, bags, opened_boxes}], shortfall }.
 */
function planAvailable(stock, unitType, quantity) {
  let need = quantity;
  const plan = [];
  for (const s of stock) {
    if (need <= 0) break;
    if (unitType === 'box') {
      const take = Math.min(need, s.boxes_on_hand);
      if (take > 0) { plan.push({ batch_id: s.batch_id, batch_number: s.batch_number, boxes: take, bags: 0, opened_boxes: 0 }); need -= take; }
    } else {
      const available = s.bags_on_hand + s.boxes_on_hand * BAGS_PER_BOX;
      const take = Math.min(need, available);
      if (take > 0) {
        const opened = Math.max(0, Math.ceil((take - s.bags_on_hand) / BAGS_PER_BOX));
        plan.push({ batch_id: s.batch_id, batch_number: s.batch_number, boxes: 0, bags: take, opened_boxes: opened });
        need -= take;
      }
    }
  }
  return { plan, shortfall: Math.max(0, need) };
}

/** Same as planAvailable, but all-or-nothing: throws 409 when stock is short. */
function planAllocation(stock, unitType, quantity, label) {
  const { plan, shortfall } = planAvailable(stock, unitType, quantity);
  if (shortfall > 0) {
    const have = quantity - shortfall;
    throw httpError(409, `${label}: only ${have} ${unitType === 'box' ? 'boxes' : 'bags'} are released and in stock; ${quantity} requested`);
  }
  return plan;
}

/**
 * Allocate what is still unallocated on a shipment line (quantity minus existing
 * allocations, in the line's unit) to released batches, oldest first, or to one
 * batch when batchId is given. strict = all-or-nothing (manual dispatch);
 * otherwise allocate what exists and leave the rest open (QuickBooks sync).
 * Updates the line's allocation_status and the batches' shipped status.
 */
async function allocateLine(client, lineId, { batchId = null, userId = null, strict = false, method = 'fifo' } = {}) {
  const { rows } = await client.query(
    `SELECT l.*, r.name AS recipe_name,
            COALESCE((SELECT SUM(CASE WHEN l.unit_type = 'box' THEN a.boxes ELSE a.bags END)
                        FROM shipment_allocations a WHERE a.line_id = l.id), 0)::int AS allocated
       FROM shipment_lines l LEFT JOIN recipes r ON r.id = l.recipe_id
      WHERE l.id = $1 FOR UPDATE OF l`, [lineId]
  );
  const line = rows[0];
  if (!line) throw httpError(404, 'Shipment line not found');
  if (!line.recipe_id || !line.format || !line.unit_type) {
    throw httpError(409, 'This line is not mapped to a product yet; map its QuickBooks item first');
  }
  const remaining = line.quantity - line.allocated;
  if (remaining <= 0) return { allocated: 0, shortfall: 0, status: 'allocated' };

  const candidates = await client.query(
    'SELECT DISTINCT batch_id FROM batch_finished_stock WHERE recipe_id = $1 AND format = $2',
    [line.recipe_id, line.format]
  );
  await lockBatches(client, candidates.rows.map(r => r.batch_id));

  const label = `${line.recipe_name} ${line.format}`;
  const stock = await shippableStock(client, line.recipe_id, line.format, batchId);
  if (batchId && !stock.length) throw httpError(409, `${label}: the chosen batch is not released or has no stock`);
  const { plan, shortfall } = strict
    ? { plan: planAllocation(stock, line.unit_type, remaining, label), shortfall: 0 }
    : planAvailable(stock, line.unit_type, remaining);

  for (const p of plan) {
    if (p.opened_boxes > 0) {
      await recordBoxOpening(client, {
        batchId: p.batch_id, recipeId: line.recipe_id, format: line.format,
        boxes: p.opened_boxes, reason: 'auto_open_for_shipment', userId
      });
    }
    await client.query(
      `INSERT INTO shipment_allocations (line_id, batch_id, boxes, bags, method, allocated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (line_id, batch_id) DO UPDATE SET boxes = shipment_allocations.boxes + EXCLUDED.boxes,
                                                     bags = shipment_allocations.bags + EXCLUDED.bags`,
      [line.id, p.batch_id, p.boxes, p.bags, method, userId]
    );
  }
  const allocatedNow = remaining - shortfall;
  const total = line.allocated + allocatedNow;
  const status = total >= line.quantity ? 'allocated' : total > 0 ? 'partial' : 'unallocated';
  await client.query('UPDATE shipment_lines SET allocation_status = $1 WHERE id = $2', [status, line.id]);
  await refreshShipStatus(client, plan.map(p => p.batch_id));
  return { allocated: allocatedNow, shortfall, status };
}

/** Remove a line's allocations (stock returns to the batches). */
async function releaseLine(client, lineId) {
  const { rows } = await client.query('DELETE FROM shipment_allocations WHERE line_id = $1 RETURNING batch_id', [lineId]);
  await client.query("UPDATE shipment_lines SET allocation_status = 'unallocated' WHERE id = $1", [lineId]);
  await refreshShipStatus(client, rows.map(r => r.batch_id));
  return rows.length;
}

async function recordBoxOpening(client, { batchId, recipeId, format, boxes, reason, userId }) {
  await client.query(
    `INSERT INTO inventory_adjustments (recipe_id, batch_id, format, box_delta, bag_delta, reason, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [recipeId, batchId, format, -boxes, boxes * BAGS_PER_BOX, reason, userId]
  );
}

/**
 * Released / Partially Shipped / Fully Shipped follow the allocations:
 * nothing shipped -> Released, everything shipped -> Fully Shipped.
 */
async function refreshShipStatus(client, batchIds) {
  for (const id of new Set(batchIds)) {
    const { rows } = await client.query(
      `SELECT b.status,
              COALESCE(SUM(s.boxes_on_hand * 12 + s.bags_on_hand), 0)::int AS left_bags,
              COALESCE(SUM(s.shipped_boxes * 12 + s.shipped_bags), 0)::int AS shipped_bags
         FROM production_batches b
         LEFT JOIN batch_finished_stock s ON s.batch_id = b.id
        WHERE b.id = $1
        GROUP BY b.status`, [id]
    );
    if (!rows.length || !SHIPPABLE.includes(rows[0].status)) continue;
    const { left_bags: left, shipped_bags: shipped } = rows[0];
    const next = shipped === 0 ? 'Released' : left <= 0 ? 'Fully Shipped' : 'Partially Shipped';
    if (next !== rows[0].status) {
      await client.query(
        'UPDATE production_batches SET status = $1, status_changed_at = NOW() WHERE id = $2', [next, id]
      );
    }
  }
}

module.exports = {
  SHIPPABLE, lockBatches, shippableStock, planAvailable, planAllocation, recordBoxOpening,
  refreshShipStatus, allocateLine, releaseLine
};
