'use strict';

function sessionObserverEnabled(session) {
  return session?.observerEnabled !== false;
}

function cancelSessionObserverCompletion(record, now = Date.now()) {
  if (!record || !['reviewing', 'pending', 'scheduled'].includes(record.status)) return record;
  return { ...record, status: 'cancelled', endedAt: now, cancelReason: 'observer-disabled' };
}

module.exports = { sessionObserverEnabled, cancelSessionObserverCompletion };
