const { EventEmitter } = require('events');
const config = require('../config');
const { emit } = require('./eventService');

class QueueManager extends EventEmitter {
  constructor() {
    super();
    this.live = null; // connection state
    this.next = null; // connection state
  }

  snapshot() {
    return {
      live: this._publicSlot(this.live),
      next: this._publicSlot(this.next),
      occupancy: (this.live ? 1 : 0) + (this.next ? 1 : 0),
      capacity: 2,
    };
  }

  _publicSlot(slot) {
    if (!slot) return null;
    return {
      presenterId: slot.presenter.id,
      username: slot.presenter.username,
      displayName: slot.presenter.display_name,
      connectedAt: slot.connectedAt,
      role: slot.role,
      mountpoint: slot.mountpoint || null,
      contentType: slot.contentType || null,
    };
  }

  _isPresenterConnected(presenterId) {
    return (this.live && this.live.presenter.id === presenterId) || (this.next && this.next.presenter.id === presenterId);
  }

  reserve(presenter, meta = {}) {
    if (!config.gateway.allowDuplicatePresenterConnections && this._isPresenterConnected(presenter.id)) {
      emit('queue_rejected', { level: 'warn', message: 'Presenter connection rejected (duplicate)', presenterId: presenter.id, username: presenter.username, details: { reason: 'duplicate_connection' } });
      return { accepted: false, reason: 'duplicate_connection' };
    }
    if (this.live && this.next) {
      emit('queue_rejected', { level: 'warn', message: 'Presenter connection rejected (queue full)', presenterId: presenter.id, username: presenter.username, details: { reason: 'queue_full' } });
      return { accepted: false, reason: 'queue_full' };
    }

    const slot = {
      presenter,
      connectedAt: new Date().toISOString(),
      role: this.live ? 'next' : 'live',
      mountpoint: meta.mountpoint || null,
      contentType: meta.contentType || null,
      userAgent: meta.userAgent || null,
      close: meta.close || null, // function to force disconnect
      startForwarding: meta.startForwarding || null,
      stopForwarding: meta.stopForwarding || null,
      startDraining: meta.startDraining || null,
      promotedAt: null,
      disconnectReason: null,
    };

    if (!this.live) {
      this.live = slot;
      emit('queue_allocated', { message: 'Presenter connected as LIVE', presenterId: presenter.id, username: presenter.username, details: { role: 'live', mountpoint: slot.mountpoint } });
    } else {
      this.next = slot;
      emit('queue_allocated', { message: 'Presenter connected as NEXT', presenterId: presenter.id, username: presenter.username, details: { role: 'next', mountpoint: slot.mountpoint } });
    }
    this.emit('change', this.snapshot());
    return { accepted: true, role: slot.role, slot };
  }

  markForwardingStarted(slot) {
    // hook for metrics/state if needed later
  }

  release(slot, reason = 'disconnected') {
    if (!slot) return;
    if (this.live === slot) {
      this.live.disconnectReason = reason;
      this.live = null;
      emit('presenter_disconnected', { message: 'LIVE presenter disconnected', presenterId: slot.presenter.id, username: slot.presenter.username, details: { reason, role: 'live' } });
      this._promoteNext();
    } else if (this.next === slot) {
      this.next.disconnectReason = reason;
      this.next = null;
      emit('presenter_disconnected', { message: 'NEXT presenter disconnected', presenterId: slot.presenter.id, username: slot.presenter.username, details: { reason, role: 'next' } });
      this.emit('change', this.snapshot());
    }
  }

  _promoteNext() {
    if (this.next) {
      const promoted = this.next;
      this.next = null;
      promoted.role = 'live';
      promoted.promotedAt = new Date().toISOString();
      this.live = promoted;
      emit('presenter_promoted', { message: 'NEXT presenter promoted to LIVE', presenterId: promoted.presenter.id, username: promoted.presenter.username, details: { promotedAt: promoted.promotedAt } });
      try {
        if (typeof promoted.startForwarding === 'function') promoted.startForwarding();
      } catch (err) {
        emit('gateway_error', { level: 'error', message: 'Failed to start forwarding for promoted presenter', presenterId: promoted.presenter.id, username: promoted.presenter.username, details: { error: err.message } });
        try { if (typeof promoted.close === 'function') promoted.close('promotion_forward_failed'); } catch (_) {}
      }
    }
    this.emit('change', this.snapshot());
  }

  disconnectPresenter(presenterId, reason = 'disconnected') {
    const targets = [];
    if (this.live && this.live.presenter.id === presenterId) targets.push(this.live);
    if (this.next && this.next.presenter.id === presenterId) targets.push(this.next);
    for (const slot of targets) {
      try {
        if (typeof slot.close === 'function') slot.close(reason);
      } catch (_) {
        // close handler should trigger release; if not, force release safety net
        this.release(slot, reason);
      }
    }
    return targets.length > 0;
  }

  getStatus() {
    const s = this.snapshot();
    return {
      online: true,
      queue: {
        live: s.live,
        next: s.next,
        occupancy: s.occupancy,
        capacity: s.capacity,
      },
    };
  }
}

const queueManager = new QueueManager();
module.exports = queueManager;
