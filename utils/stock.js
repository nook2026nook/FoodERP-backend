/**
 * Lot stock movements for production batches. Always called inside a
 * transaction; lots are locked in id order to avoid deadlocks.
 */
const { ROUND } = require('./costing');

const TOLERANCE = 0.01; // same 0.01 tolerance the HTML uses for baking splits

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const unitLabel = (unitType) => (unitType === 'kg' ? 'kg' : 'units');

/** Put a batch's deductions for one stage back into the lots and forget them. */
async function refundStage(client, batchId, stage) {
  const { rows } = await client.query(
    `SELECT lot_id, SUM(quantity) AS quantity FROM batch_lot_allocations
      WHERE batch_id = $1 AND stage = $2 GROUP BY lot_id ORDER BY lot_id`,
    [batchId, stage]
  );
  for (const r of rows) {
    await client.query('SELECT id FROM warehouse_lots WHERE id = $1 FOR UPDATE', [r.lot_id]);
    await client.query(
      'UPDATE warehouse_lots SET remaining_quantity = remaining_quantity + $1 WHERE id = $2',
      [r.quantity, r.lot_id]
    );
  }
  await client.query('DELETE FROM batch_lot_allocations WHERE batch_id = $1 AND stage = $2', [batchId, stage]);
  return rows;
}

/**
 * Deduct lot splits for one stage.
 * @param requirements [{item_id, item_name, unit_type, required}] — every item with
 *        required > 0 must be covered by splits summing to it (within TOLERANCE).
 * @param splits [{item_id, lot_id, quantity}]
 */
async function deductStage(client, batchId, stage, requirements, splits) {
  const required = new Map(requirements.map(r => [r.item_id, r]));
  const sums = new Map();
  for (const s of splits) {
    if (!required.has(s.item_id)) throw httpError(400, 'A lot split names an item that is not in this recipe');
    sums.set(s.item_id, (sums.get(s.item_id) || 0) + Number(s.quantity));
  }
  for (const r of requirements) {
    const got = sums.get(r.item_id) || 0;
    if (Math.abs(got - r.required) > TOLERANCE) {
      throw httpError(400,
        `${r.item_name}: lot splits total ${ROUND(got)} ${unitLabel(r.unit_type)} but ${r.required} ${unitLabel(r.unit_type)} is required`);
    }
  }

  // One deduction per (lot, item); lock lots in a stable order.
  const perLot = new Map();
  for (const s of splits) {
    if (Number(s.quantity) <= 0) continue;
    const key = `${s.lot_id}:${s.item_id}`;
    const entry = perLot.get(key) || { lot_id: s.lot_id, item_id: s.item_id, quantity: 0 };
    entry.quantity += Number(s.quantity);
    perLot.set(key, entry);
  }
  const moves = [...perLot.values()].sort((a, b) => a.lot_id.localeCompare(b.lot_id));

  for (const m of moves) {
    const { rows } = await client.query(
      'SELECT id, lot_number, item_id, remaining_quantity FROM warehouse_lots WHERE id = $1 FOR UPDATE',
      [m.lot_id]
    );
    const lot = rows[0];
    const item = required.get(m.item_id);
    if (!lot) throw httpError(400, `A lot chosen for ${item.item_name} no longer exists`);
    if (lot.item_id !== m.item_id) throw httpError(400, `Lot ${lot.lot_number} is not a lot of ${item.item_name}`);

    const qty = ROUND(m.quantity);
    const available = Number(lot.remaining_quantity);
    if (qty > available + 0.0001) {
      // Decision 24: block the save, show available vs requested.
      throw httpError(409,
        `Lot ${lot.lot_number} (${item.item_name}) has ${ROUND(available)} ${unitLabel(item.unit_type)} available; ${qty} ${unitLabel(item.unit_type)} requested`);
    }
    await client.query(
      'UPDATE warehouse_lots SET remaining_quantity = GREATEST(0, remaining_quantity - $1) WHERE id = $2',
      [qty, m.lot_id]
    );
    await client.query(
      `INSERT INTO batch_lot_allocations (batch_id, lot_id, item_id, stage, quantity)
       VALUES ($1,$2,$3,$4,$5)`,
      [batchId, m.lot_id, m.item_id, stage, qty]
    );
  }
}

/**
 * Lots with stock available for the given items, oldest first. A batch being
 * re-saved may reuse what it already holds, so its own deductions are added back.
 */
async function availableLots(db, itemIds, stage, batchId = null) {
  if (!itemIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT l.id, l.lot_number, l.item_id, l.expiry_date, l.received_at,
            l.remaining_quantity + COALESCE((
              SELECT SUM(a.quantity) FROM batch_lot_allocations a
               WHERE a.lot_id = l.id AND a.batch_id = $2 AND a.stage = $3), 0) AS available
       FROM warehouse_lots l
      WHERE l.item_id = ANY($1::uuid[])
      ORDER BY l.received_at ASC, l.created_at ASC`,
    [itemIds, batchId, stage]
  );
  const byItem = new Map();
  for (const r of rows) {
    if (Number(r.available) <= 0) continue;
    const list = byItem.get(r.item_id) || [];
    list.push({ ...r, available: Number(r.available) });
    byItem.set(r.item_id, list);
  }
  return byItem;
}

module.exports = { refundStage, deductStage, availableLots, httpError };
