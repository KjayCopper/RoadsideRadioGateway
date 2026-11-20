const logger = require('../logging/logger');
const eventsRepo = require('../db/eventsRepo');

function emit(type, { level = 'info', message, presenterId = null, username = null, details = null } = {}) {
  const payload = { type, presenterId, username, details };
  if (level === 'error') logger.error(payload, message);
  else if (level === 'warn') logger.warn(payload, message);
  else logger.info(payload, message);
  try {
    eventsRepo.logEvent({ type, level, message, presenterId, username, details });
  } catch (err) {
    logger.error({ err, type }, 'failed_to_persist_event');
  }
}

module.exports = { emit };
