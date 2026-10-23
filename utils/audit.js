const logger = require('../logger');

async function logAudit(db, userId, action, entity, entityId, beforeState, afterState, ip = null) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, before_state, after_state, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, action, entity, entityId != null ? String(entityId) : null,
       beforeState ?? null, afterState ?? null, ip || null]
    );
  } catch (err) {
    // Never block a business operation because auditing failed.
    logger.error({ err, action, entity }, 'audit log write failed');
  }
}

module.exports = { logAudit };
