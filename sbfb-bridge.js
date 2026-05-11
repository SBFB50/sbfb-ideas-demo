// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SBFB Bridge SDK — client library for iframe apps.
 *
 * Sprint 13 Phase C. Include this file in your app to communicate
 * with the SBFB network through the host shell:
 *
 *   <script src="/sbfb-bridge.js"></script>
 *   <script>
 *     const bridge = new SBFBBridge();
 *     const result = await bridge.submitTask({ prompt: "Hello" });
 *   </script>
 *
 * All communication goes through window.postMessage. The host shell
 * validates each request, forwards it to the coordinator API, and
 * sends back a typed response with a correlation ID.
 *
 * Sprint 15 Phase A — adds `onEvent(name, callback)` for push events
 *   pushed by the host toward the iframe (fire-and-forget).
 * Sprint 21 Phase B — adds `piiRedact(text, policy)` that runs the
 *   host-side PII SDK (GLiNER edge / regex fallback) and returns a
 *   redacted string. Use before `submitTask({ prompt })` so workers
 *   never see personal data from the end user.
 */

class SBFBBridge {
  /**
   * @param {Object} [options]
   * @param {number} [options.timeout=10000] — ms before a request rejects
   * @param {number} [options.heartbeatInterval=1000] — ms between liveness pings (0 disables)
   */
  constructor(options) {
    this._timeout = (options && options.timeout) || 10000;
    this._pending = new Map();
    // Sprint 15 Phase A: subscribers for host push events, keyed by
    // event name. Each value is a Set<callback> so multiple consumers
    // of the same event can coexist.
    this._eventHandlers = new Map();
    // Sprint 15 Phase B: liveness heartbeat (0 = disabled for tests).
    this._heartbeatInterval =
      options && typeof options.heartbeatInterval === "number"
        ? options.heartbeatInterval
        : 1000;
    this._heartbeatTimer = null;

    this._onMessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === "sbfb-bridge-response") {
        const resolve = this._pending.get(msg.id);
        if (!resolve) return;
        this._pending.delete(msg.id);
        resolve(msg);
        return;
      }

      if (msg.type === "sbfb-bridge-event") {
        const handlers = this._eventHandlers.get(msg.name);
        if (!handlers) return;
        for (const cb of handlers) {
          try {
            cb(msg.payload);
          } catch (e) {
            // Swallow callback errors so one faulty handler doesn't
            // block the others or the bridge itself.
            if (typeof console !== "undefined") console.error("onEvent callback threw", e);
          }
        }
      }
    };

    window.addEventListener("message", this._onMessage);

    // Sprint 15 Phase B: auto-start heartbeat so the host watchdog
    // has a signal within the first second. Tests can disable by
    // passing heartbeatInterval: 0.
    if (this._heartbeatInterval > 0) {
      this._startHeartbeat();
    }
  }

  /** Stop listening. Call when the app unmounts. */
  destroy() {
    window.removeEventListener("message", this._onMessage);
    this._stopHeartbeat();
    // Reject all pending requests.
    for (const [id, resolve] of this._pending) {
      resolve({ type: "sbfb-bridge-response", id, success: false, error: "bridge destroyed" });
    }
    this._pending.clear();
    this._eventHandlers.clear();
  }

  /**
   * Start emitting heartbeat pings so the host watchdog can detect
   * a frozen iframe. Sprint 15 Phase B. Safe to call twice — a
   * running heartbeat is a no-op.
   *
   * @private
   */
  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    const ping = () => {
      try {
        parent.postMessage(
          { type: "sbfb-bridge-heartbeat", ts: Date.now() },
          "*",
        );
      } catch (e) {
        // Swallow — postMessage can throw if parent is gone.
      }
    };
    // Fire one immediately so the host sees a heartbeat without
    // waiting a full interval.
    ping();
    this._heartbeatTimer = setInterval(ping, this._heartbeatInterval);
  }

  /** Stop the heartbeat timer. Sprint 15 Phase B. @private */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Subscribe to a push event from the host. Sprint 15 Phase A.
   *
   * @param {string} name — event name to listen for
   * @param {(payload: unknown) => void} callback — called on each event
   * @returns {() => void} — unsubscribe function (idempotent)
   *
   * @example
   *   bridge.onEvent("task_result_ready", (payload) => {
   *     console.log("task done:", payload.task_id);
   *   });
   */
  onEvent(name, callback) {
    if (typeof name !== "string" || !name.length) {
      throw new Error("onEvent: name must be a non-empty string");
    }
    if (typeof callback !== "function") {
      throw new Error("onEvent: callback must be a function");
    }
    let handlers = this._eventHandlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this._eventHandlers.set(name, handlers);
    }
    handlers.add(callback);
    return () => {
      const current = this._eventHandlers.get(name);
      if (current) current.delete(callback);
    };
  }

  /**
   * Submit a compute task to the SBFB network.
   * @param {Object} payload — task parameters (prompt, task_type, etc.)
   * @returns {Promise<Object>} — coordinator response (task_id, etc.)
   */
  submitTask(payload) {
    return this._call("task_submit", payload || {});
  }

  /**
   * Read a value from the coordinator's typed storage.
   * @param {string} key — storage namespace key
   * @returns {Promise<*>} — stored value
   */
  getStorage(key) {
    return this._call("storage_get", { key: key });
  }

  /**
   * Write a value to the coordinator's typed storage.
   * @param {string} key — storage namespace key
   * @param {Object} value — data to persist
   * @returns {Promise<Object>} — {ok: true}
   */
  setStorage(key, value) {
    return this._call("storage_set", Object.assign({ key: key }, value || {}));
  }

  /**
   * Redact PII from a piece of text via the host-side SDK (Sprint
   * 21 Phase B). The host runs GLiNER ONNX when the model asset is
   * available and falls back to curated regex (email, phone, CC,
   * SSN, IBAN) otherwise. Apps should call this before
   * {@link submitTask} whenever the prompt may contain personal
   * data.
   *
   * @param {string} text — input text to scan (≤ 50000 chars)
   * @param {Object} [policy] — partial policy override (enabled,
   *   entities, replacement, confidence_threshold, use_model)
   * @returns {Promise<{ redacted_text: string, findings_count: number }>}
   */
  piiRedact(text, policy) {
    var payload = { text: text };
    if (policy) payload.policy = policy;
    return this._call("pii_redact", payload);
  }

  /**
   * List keys in the app's storage, optionally filtered by prefix.
   * Sprint 56 Phase C.
   * @param {string} [prefix] — key prefix filter (empty = all)
   * @returns {Promise<{ entries: Array<{key: string, value: *}>, count: number }>}
   */
  listStorage(prefix) {
    return this._call("storage_list", { prefix: prefix || "" });
  }

  /**
   * Delete a key from the app's storage. Sprint 56 Phase C.
   * @param {string} key — storage key to remove
   * @returns {Promise<{ ok: boolean }>}
   */
  deleteStorage(key) {
    return this._call("storage_delete", { key: key });
  }

  /**
   * Get the local node's Ed25519 public key. Sprint 56 Phase C.
   * @returns {Promise<{ pubkey: string }>}
   */
  getIdentityPubkey() {
    return this._call("identity_pubkey", {});
  }

  /**
   * Get the daemon's current status (peers, uptime, version).
   * Sprint 56 Phase C.
   * @returns {Promise<Object>}
   */
  getNodeStatus() {
    return this._call("node_status", {});
  }

  /**
   * List apps available on the network. Sprint 56 Phase C.
   * @returns {Promise<{ entries: Array<Object> }>}
   */
  getBrowseList() {
    return this._call("browse_list", {});
  }

  /**
   * Get the storage version counter for an app. Sprint 58 Phase D.
   * Incremented on each remote insert received via iroh-docs sync.
   * @param {string} appName — replicated app name
   * @returns {Promise<{ app: string, version: number }>}
   */
  getStorageVersion(appName) {
    return this._call("storage_version", { app: appName });
  }

  /**
   * Register a callback invoked when the storage version changes
   * (remote sync detected). Polls every 3s. Sprint 58 Phase D.
   * @param {string} appName — replicated app name
   * @param {() => void} callback — called on each version change
   * @returns {() => void} — stop polling (idempotent)
   */
  onStorageUpdate(appName, callback) {
    if (typeof appName !== "string" || !appName.length) {
      throw new Error("onStorageUpdate: appName must be a non-empty string");
    }
    if (typeof callback !== "function") {
      throw new Error("onStorageUpdate: callback must be a function");
    }
    var self = this;
    var lastVersion = -1;
    var stopped = false;
    var timer = setInterval(function () {
      if (stopped) return;
      self
        .getStorageVersion(appName)
        .then(function (data) {
          if (stopped) return;
          var v = typeof data.version === "number" ? data.version : -1;
          if (lastVersion === -1) {
            lastVersion = v;
            if (v > 0) {
              try {
                callback();
              } catch (e) {
                if (typeof console !== "undefined") console.error("onStorageUpdate callback threw", e);
              }
            }
            return;
          }
          if (v !== lastVersion) {
            lastVersion = v;
            try {
              callback();
            } catch (e) {
              if (typeof console !== "undefined") console.error("onStorageUpdate callback threw", e);
            }
          }
        })
        .catch(function () {
          // Swallow poll errors silently.
        });
    }, 3000);
    return function () {
      stopped = true;
      clearInterval(timer);
    };
  }

  /**
   * @private
   * @param {string} method
   * @param {Object} payload
   * @returns {Promise<*>}
   */
  _call(method, payload) {
    var self = this;
    var id = self._uuid();

    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        self._pending.delete(id);
        reject(new Error("bridge timeout after " + self._timeout + "ms"));
      }, self._timeout);

      self._pending.set(id, function (msg) {
        clearTimeout(timer);
        if (msg.success) {
          resolve(msg.data);
        } else {
          reject(new Error(msg.error || "bridge error"));
        }
      });

      parent.postMessage(
        {
          type: "sbfb-bridge-request",
          id: id,
          method: method,
          payload: payload,
        },
        "*",
      );
    });
  }

  /** @private */
  _uuid() {
    // crypto.randomUUID polyfill for older browsers.
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
