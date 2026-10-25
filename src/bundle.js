
// src/bundle.js
// IndiaMART BuyLead Assistant - v5.1.0
// ============================================================================
// CHANGELOG v5.1.0 - Production Reliability & Review Workflow Refactor
// ============================================================================
// Developed by Keyn Labs
// ============================================================================

console.log('🎯 IndiaMART BuyLead Assistant v5.1.0 (Reliable Lead-Monitoring & Review Assistant)');
console.log('📦 Developed by Keyn Labs');
console.log('🔗 https://keynlabs.vercel.app/');

(function () {
    'use strict';
    var Core = globalThis.LeadSyncCore;

    // ============================================================
    // SCAN LIMIT — maximum DOM lead cards processed per scan cycle.
    // Fair bounded scanning without starvation.
    // ============================================================
    var MAX_LEADS_PER_CYCLE = 5;
    var MAX_DOM_SCAN_LIMIT = 5;

    // ============================================================
    // RATE-LIMIT DETECTION — phrases from IndiaMART's account-restriction banner.
    // When any of these substrings appear in the visible page body the extension
    // halts all activity immediately via the persistent CircuitBreaker.
    // ============================================================
    var RATE_LIMIT_PHRASES = [
        'unusually high activity',
        'reached the request limit',
        'please wait 15 minutes',
        'session is reactivated',
        'you have reached the request limit'
    ];

    // ============================================================
    // CIRCUIT BREAKER STATES
    // ============================================================
    var CIRCUIT_BREAKER_STATES = {
        NORMAL: 'NORMAL',
        PAUSED_RESTRICTION: 'PAUSED_RESTRICTION',
        REQUIRES_USER_REVIEW: 'REQUIRES_USER_REVIEW'
    };

    function CircuitBreaker() {
        this._state = CIRCUIT_BREAKER_STATES.NORMAL;
        this._reason = '';
        this._trippedAt = 0;
        this._listeners = [];
        this.ready = this._loadState();
    }

    CircuitBreaker.prototype._loadState = function () {
        var self = this;
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(['bl_circuit_breaker_state', 'bl_circuit_breaker_reason', 'bl_circuit_breaker_tripped_at', 'bl_circuit_breaker'], function (res) {
                    var saved = res && res.bl_circuit_breaker;
                    self._state = saved && saved.state || res && res.bl_circuit_breaker_state || CIRCUIT_BREAKER_STATES.NORMAL;
                    self._reason = saved && saved.reason || res && res.bl_circuit_breaker_reason || '';
                    self._trippedAt = saved && saved.trippedAt || res && res.bl_circuit_breaker_tripped_at || 0;
                    self._notify(); resolve();
                });
            } catch (e) { self._state = CIRCUIT_BREAKER_STATES.REQUIRES_USER_REVIEW; resolve(); }
        });
    };

    CircuitBreaker.prototype._saveState = function () {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({
                    bl_circuit_breaker_state: this._state,
                    bl_circuit_breaker_reason: this._reason,
                    bl_circuit_breaker_tripped_at: this._trippedAt,
                    bl_circuit_breaker: {
                        state: this._state,
                        reason: this._reason,
                        trippedAt: this._trippedAt
                    }
                });
            }
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('bl_circuit_breaker_state', this._state);
                sessionStorage.setItem('bl_circuit_breaker_reason', this._reason);
                sessionStorage.setItem('bl_circuit_breaker_tripped_at', String(this._trippedAt));
            }
        } catch (e) { }
    };

    Object.defineProperty(CircuitBreaker.prototype, 'state', {
        get: function () { return this._state; }
    });
    CircuitBreaker.prototype.getState = function () { return this._state; };
    CircuitBreaker.prototype.getReason = function () { return this._reason; };
    CircuitBreaker.prototype.isNormal = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };
    CircuitBreaker.prototype.canExecute = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };
    CircuitBreaker.prototype.canProceed = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };

    CircuitBreaker.prototype.trip = function (reason, details) {
        this._state = CIRCUIT_BREAKER_STATES.PAUSED_RESTRICTION;
        this._reason = reason || 'Rate limit or restriction detected';
        this._trippedAt = Date.now();
        this._saveState();
        this._notify();
    };

    CircuitBreaker.prototype.requireUserReview = function (reason, details) {
        this._state = CIRCUIT_BREAKER_STATES.REQUIRES_USER_REVIEW;
        this._reason = reason || 'Requires explicit user review';
        this._trippedAt = Date.now();
        this._saveState();
        this._notify();
    };

    CircuitBreaker.prototype.reset = function (invokedBy) {
        // Only explicit user action can reset the circuit breaker
        if (invokedBy !== 'user_action' && invokedBy !== 'manual_resume') {
            console.warn('[CircuitBreaker] Ignored non-user reset attempt:', invokedBy);
            return false;
        }
        this._state = CIRCUIT_BREAKER_STATES.NORMAL;
        this._reason = '';
        this._trippedAt = 0;
        this._saveState();
        this._notify();
        return true;
    };

    CircuitBreaker.prototype.addListener = function (fn) {
        if (typeof fn === 'function') this._listeners.push(fn);
    };

    CircuitBreaker.prototype._notify = function () {
        for (var i = 0; i < this._listeners.length; i++) {
            try { this._listeners[i](this._state, this._reason); } catch (e) { }
        }
    };

    // ============================================================
    // DEFAULT CONFIG
    // ============================================================
    var DEFAULT_CONFIG = {
        // Workflow: Default to AUTOMATIC mode for fully automated lead acquisition & contact
        mode: 'AUTOMATIC',
        automationPaused: false,
        proactiveFeedPolling: false,
        supabaseClientId: '',
        minScore: 60,

        // ---- SAFETY LIMITS ----
        maxPerMinute: 60,
        maxPerHour: 400,
        maxPerDay: 2000,
        maxPerSession: 1000,
        cooldownMs: 0,

        strictCountryMode: false,
        allowedCountries: ['IN'],
        strictCountryRejectUnknown: true,

        scoreWeights: {
            base: 50,
            perProductKeyword: 10, maxProductBonus: 30,
            preferredState: 15, countryMatch: 15,
            hasMobile: 10, hasEmail: 8, hasPhone: 5,
            detailedRequirement: 5, requirementLengthThreshold: 100
        },
        scorePenalties: { wrongCountry: -20, wrongState: -10, noContact: -5 },
        preferredStates: ['maharashtra'],
        preferredCountries: ['IN'],

        // ---- NAVIGATOR ----
        loopIntervalMs: 100,
        loadMoreWaitMs: 900,
        maxStuckLoops: 3,
        maxReloadsPerSession: 0,
        autoReloadOnComplete: false,
        autoReloadDelayMs: 2500,
        reloadJitterMs:    400,

        // ---- POPUP ----
        autoMinimize: true,
        popupTimeoutMs: 15000,
        confirmationAnswer: 'yes',
        purchaseAction: 'close',

        supabaseEnabled: true,
        panelPosition: null,
        panelCollapsed: false,
        stopSold: true,
        skipSoldOut: true
    };

    // ============================================================
    // PRIVACY-SAFE LOG SANITIZER
    // ============================================================
    function _sanitizeLogValue(val, depth) {
        if (depth > 4) return '[MAX_DEPTH]';
        if (typeof val === 'string') {
            var s = val.replace(/\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, '[REDACTED_PHONE]');
            s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
            return s;
        }
        if (val && typeof val === 'object') {
            if (Array.isArray(val)) {
                return val.map(function (item) { return _sanitizeLogValue(item, depth + 1); });
            }
            var cleaned = {};
            for (var k in val) {
                if (!Object.prototype.hasOwnProperty.call(val, k)) continue;
                var lk = k.toLowerCase();
                if (lk.indexOf('token') !== -1 || lk.indexOf('auth') !== -1 || lk.indexOf('cookie') !== -1 ||
                    lk.indexOf('key') !== -1 || lk.indexOf('secret') !== -1 || lk.indexOf('password') !== -1) {
                    cleaned[k] = '[REDACTED_SECRET]';
                } else if (lk.indexOf('mobile') !== -1 || lk.indexOf('phone') !== -1) {
                    cleaned[k] = '[REDACTED_PHONE]';
                } else if (lk.indexOf('email') !== -1) {
                    cleaned[k] = '[REDACTED_EMAIL]';
                } else {
                    cleaned[k] = _sanitizeLogValue(val[k], depth + 1);
                }
            }
            return cleaned;
        }
        return val;
    }

    // ============================================================
    // ============================================================
    // STRUCTURED LOGGER & OBSERVABILITY ENGINE (Schema v1.0.0)
    // ============================================================
    var LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
    var LEVEL_NAMES = { 0: 'TRACE', 1: 'DEBUG', 2: 'INFO', 3: 'WARN', 4: 'ERROR' };
    var _logQueue = [];
    var _logFlushTimer = null;
    var _isFlushing = false;
    var _pendingFlush = false;
    var _droppedLogsCount = 0;
    var _persistenceErrorsCount = 0;
    var MAX_QUEUE_SIZE = 500;
    var MAX_LOGS_RETENTION = 1000;
    var UNCHANGED_AGGREGATION_WINDOW_MS = 5000;
    var _lastEmittedSignatures = new Map();
    var _initInfo = { instanceId: 'bl_pre_init', reason: 'unknown' };

    function generateTraceId(leadId) {
        if (leadId) {
            var str = String(leadId).trim();
            var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (var i = 0; i < str.length; i++) {
                var ch = str.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            var hex = ('00000000' + (h1 >>> 0).toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
            return 'tr_' + hex;
        }
        return 'tr_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    }

    function generateOperationId(prefix) {
        var p = prefix ? (prefix + '_') : 'op_';
        return p + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    }

    var _activeFlushPromise = null;

    function _shouldSuppress(event, component, reasonCode, contextSummary) {
        if (event !== 'filters.config.unchanged' && event !== 'scanner.card.duplicate' && reasonCode !== 'CONFIG_UNCHANGED' && reasonCode !== 'DUPLICATE_OBSERVATION') {
            return false;
        }
        var key = event + '|' + component + '|' + (reasonCode || '') + '|' + (contextSummary || '');
        var now = Date.now();
        var last = _lastEmittedSignatures.get(key);
        if (last && (now - last.timestamp < UNCHANGED_AGGREGATION_WINDOW_MS)) {
            last.count = (last.count || 1) + 1;
            return true;
        }
        _lastEmittedSignatures.set(key, { timestamp: now, count: 1 });
        if (_lastEmittedSignatures.size > 200) {
            _lastEmittedSignatures.clear();
        }
        return false;
    }

    function _flushLogsNow(callback) {
        if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
        if (_activeFlushPromise) {
            return _activeFlushPromise.then(function () {
                if (_logQueue.length > 0) {
                    return _flushLogsNow(callback);
                }
                if (typeof callback === 'function') {
                    try { callback(); } catch (e) { }
                }
            });
        }

        if (_logQueue.length === 0) {
            if (typeof callback === 'function') {
                try { callback(); } catch (e) { }
            }
            return Promise.resolve();
        }

        var flushFailed = false;
        _activeFlushPromise = new Promise(function (resolve) {
            function finish() {
                if (typeof callback === 'function') {
                    try { callback(); } catch (e) { }
                }
                resolve();
            }

            var batch = _logQueue.splice(0, _logQueue.length);
            function failed() {
                flushFailed = true;
                _persistenceErrorsCount++;
                var pending = batch.concat(_logQueue);
                _droppedLogsCount += Math.max(0, pending.length - MAX_QUEUE_SIZE);
                _logQueue = pending.slice(-MAX_QUEUE_SIZE);
                finish();
            }

            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
                finish();
                return;
            }

            try {
                chrome.storage.local.get('logs', function (result) {
                    if ((chrome.runtime && chrome.runtime.lastError) || (result instanceof Error)) {
                        failed();
                        return;
                    }

                    var existing = (result && Array.isArray(result.logs)) ? result.logs : [];
                    var seenKeys = new Set();
                    var merged = [];

                    for (var i = 0; i < existing.length; i++) {
                        var it = existing[i];
                        var key = it.id || (it.timestamp + ':' + (it.component || it.module) + ':' + it.event + ':' + (it.traceId || it.operationId || ''));
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            merged.push(it);
                        }
                    }

                    for (var j = 0; j < batch.length; j++) {
                        var bit = batch[j];
                        var bkey = bit.id || (bit.timestamp + ':' + (bit.component || bit.module) + ':' + bit.event + ':' + (bit.traceId || bit.operationId || ''));
                        if (!seenKeys.has(bkey)) {
                            seenKeys.add(bkey);
                            merged.push(bit);
                        }
                    }

                    merged.sort(function (a, b) {
                        return (a.timestamp || '').localeCompare(b.timestamp || '');
                    });

                    if (merged.length > MAX_LOGS_RETENTION) {
                        merged = merged.slice(-MAX_LOGS_RETENTION);
                    }

                    try {
                        chrome.storage.local.set({ logs: merged }, function (err) {
                            if ((chrome.runtime && chrome.runtime.lastError) || err) failed(); else finish();
                        });
                    } catch (e) { failed(); }
                });
            } catch (e) { failed(); }
        }).then(function () {
            _activeFlushPromise = null;
            if (_logQueue.length > 0 && !flushFailed) return _flushLogsNow();
            if (flushFailed && !_logFlushTimer) _logFlushTimer = setTimeout(_flushLogsNow, 5000);
        }, function () {
            _activeFlushPromise = null;
        });

        return _activeFlushPromise;
    }

    function _enqueueLog(entry) {
        _logQueue.push(entry);
        var maxQ = (Logger && Logger._maxQueueSize) || MAX_QUEUE_SIZE;
        if (_logQueue.length > maxQ) {
            var excess = _logQueue.length - maxQ;
            _logQueue.splice(0, excess);
            _droppedLogsCount += excess;
        }
        if (!_logFlushTimer) {
            _logFlushTimer = setTimeout(_flushLogsNow, 1200);
        }
    }

    function Logger(module) {
        this.module = module || 'App';
        this.minLevel = LEVELS.TRACE;
        this._correlationId = null;
        this._traceId = null;
        this._operationId = null;
    }

    Logger.prototype.getCorrelationId = function () {
        return this._correlationId || this._operationId || 'op_' + Date.now().toString(36);
    };

    Logger.prototype.setTraceId = function (traceId) {
        this._traceId = traceId;
    };

    Logger.prototype.setOperationId = function (opId) {
        this._operationId = opId;
    };

    Logger.prototype._deriveEventName = function (message, level) {
        if (!message || typeof message !== 'string') return this.module.toLowerCase() + '.' + (LEVEL_NAMES[level] || 'info').toLowerCase();
        var m = message.toLowerCase();
        if (m.indexOf('started') !== -1 && m.indexOf('scanner') !== -1) return 'scanner.started';
        if (m.indexOf('stopped') !== -1) return 'app.lifecycle.stopped';
        if (m.indexOf('scan error') !== -1) return 'scanner.error';
        if (m.indexOf('rate-limit') !== -1) return 'platform.restriction.detected';
        if (m.indexOf('card skipped') !== -1) return 'scanner.card.skipped';
        if (m.indexOf('reconciliation') !== -1) return 'scanner.reconciliation.completed';
        if (m.indexOf('duplicate') !== -1 || m.indexOf('already') !== -1) return 'scanner.card.duplicate';
        if (m.indexOf('filter') !== -1 && m.indexOf('cache') !== -1) return 'filters.cache.hit';
        if (m.indexOf('syncing') !== -1 || m.indexOf('loaded') !== -1) return 'filters.sync.completed';
        return this.module.toLowerCase() + '.' + (LEVEL_NAMES[level] || 'info').toLowerCase();
    };

    Logger.prototype.logEvent = function (levelOrOpts, event, component, data) {
        if (!levelOrOpts) return;
        var opts = {};
        if (typeof levelOrOpts === 'object' && levelOrOpts !== null) {
            opts = levelOrOpts;
        } else {
            opts = Object.assign({}, data || {});
            opts.level = levelOrOpts;
            opts.event = event;
            if (component) opts.component = component;
        }

        var levelName = (opts.level || 'INFO').toUpperCase();
        var lvl = LEVELS[levelName] != null ? LEVELS[levelName] : LEVELS.INFO;
        if (lvl < this.minLevel) return;

        var comp = opts.component || this.module;
        var nowIso = new Date().toISOString();
        var evtName = opts.event || this._deriveEventName(opts.message, lvl);
        var reasonCode = opts.reasonCode || null;
        var contextData = opts.context || opts.data || {};
        var contextSanitized = _sanitizeLogValue(contextData, 0);

        var contextSummary = '';
        try { contextSummary = JSON.stringify(contextSanitized); } catch (e) { }

        if (_shouldSuppress(evtName, comp, reasonCode, contextSummary)) {
            return;
        }

        var recordId = 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
        var entry = {
            schemaVersion: '1.0.0',
            id: recordId,
            timestamp: nowIso,
            level: levelName,
            event: evtName,
            component: comp,
            instanceId: _initInfo.instanceId,
            traceId: opts.traceId || this._traceId || null,
            operationId: opts.operationId || this._operationId || this.getCorrelationId(),
            context: contextSanitized,
            // Compatibility aliases for existing UI and tests
            module: comp,
            message: _sanitizeLogValue(opts.message || evtName, 0),
            data: contextSanitized,
            correlationId: opts.traceId || opts.operationId || this.getCorrelationId()
        };

        if (opts.durationMs != null && !isNaN(opts.durationMs)) {
            entry.durationMs = Math.round(Number(opts.durationMs));
        }
        if (opts.result != null) {
            entry.result = String(opts.result);
        }
        if (reasonCode != null) {
            entry.reasonCode = String(reasonCode);
        }
        if (opts.metrics && typeof opts.metrics === 'object') {
            entry.metrics = _sanitizeLogValue(opts.metrics, 0);
        }
        if (opts.error) {
            entry.error = typeof opts.error === 'string' ? _sanitizeLogValue(opts.error, 0) : {
                message: _sanitizeLogValue(opts.error.message || String(opts.error), 0),
                name: opts.error.name || 'Error',
                stack: opts.error.stack ? _sanitizeLogValue(opts.error.stack.split('\n').slice(0, 4).join('\n'), 0) : undefined
            };
        } else {
            entry.error = null;
        }

        var prefix = '[' + entry.timestamp + '] [' + entry.level + '] [' + comp + ']';
        if (typeof this.writer === 'function') {
            this.writer(prefix, levelName, entry.message, entry.context);
        } else {
            var msgPart = (entry.message && entry.message !== entry.event) ? (': ' + entry.message) : '';
            var summary = '[' + entry.event + ']' + (entry.reasonCode ? ' (' + entry.reasonCode + ')' : '') + (entry.durationMs != null ? ' ' + entry.durationMs + 'ms' : '') + msgPart;
            var contextStr = '';
            if (entry.context && typeof entry.context === 'object' && Object.keys(entry.context).length > 0) {
                try { contextStr = ' ' + JSON.stringify(entry.context); } catch (e) { contextStr = ''; }
            }
            if (lvl >= LEVELS.ERROR) console.error(prefix, summary + contextStr);
            else if (lvl >= LEVELS.WARN) console.warn(prefix, summary + contextStr);
            else if (lvl >= LEVELS.INFO) console.info(prefix, summary, entry.context);
            else console.log(prefix, summary, entry.context);
        }

        _enqueueLog(entry);
        return entry;
    };

    Logger.prototype.generateTraceId = generateTraceId;
    Logger.prototype.generateOperationId = generateOperationId;
    Logger.prototype.getDroppedLogsCount = function () { return _droppedLogsCount; };
    Logger.prototype.getPersistenceErrorsCount = function () { return _persistenceErrorsCount; };
    Logger.prototype.flushLogsNow = _flushLogsNow;
    Logger.prototype._flushLogsNow = _flushLogsNow;
    Object.defineProperty(Logger.prototype, '_memoryBuffer', {
        get: function () { return _logQueue; },
        configurable: true
    });

    Logger.prototype.logTransition = function (fromState, toState, reasonCode, operationId, traceId, context) {
        return this.logEvent({
            level: 'INFO',
            event: 'lead.state.changed',
            reasonCode: reasonCode || 'STATE_TRANSITION',
            operationId: operationId || this._operationId || this.getCorrelationId(),
            traceId: traceId || this._traceId || null,
            result: toState,
            context: Object.assign({ from: fromState, to: toState }, context || {}),
            message: 'State changed: ' + fromState + ' -> ' + toState
        });
    };

    Logger.prototype._log = function (level, messageOrEvent, dataOrOpts) {
        var isEvent = typeof messageOrEvent === 'string' && (messageOrEvent.indexOf('.') !== -1 || (dataOrOpts && dataOrOpts.event));
        var eventName = isEvent ? (dataOrOpts && dataOrOpts.event ? dataOrOpts.event : messageOrEvent) : null;
        var message = typeof messageOrEvent === 'string' ? messageOrEvent : (messageOrEvent && messageOrEvent.message) || '';

        var opts = {};
        if (dataOrOpts && typeof dataOrOpts === 'object' && (dataOrOpts.event || dataOrOpts.traceId || dataOrOpts.operationId || dataOrOpts.reasonCode || dataOrOpts.durationMs != null || dataOrOpts.context || dataOrOpts.result || dataOrOpts.metrics || dataOrOpts.error)) {
            opts = Object.assign({}, dataOrOpts);
        } else {
            opts.context = dataOrOpts || {};
        }

        opts.level = LEVEL_NAMES[level] || 'INFO';
        opts.message = message || eventName;
        if (eventName) opts.event = eventName;

        return this.logEvent(opts);
    };

    Logger.prototype.trace = function (m, d) { return this._log(LEVELS.TRACE, m, d); };
    Logger.prototype.debug = function (m, d) { return this._log(LEVELS.DEBUG, m, d); };
    Logger.prototype.info = function (m, d) { return this._log(LEVELS.INFO, m, d); };
    Logger.prototype.warn = function (m, d) { return this._log(LEVELS.WARN, m, d); };
    Logger.prototype.error = function (m, d) { return this._log(LEVELS.ERROR, m, d); };
    Logger.prototype.fatal = function (m, d) { return this._log(LEVELS.ERROR, m, d); };

    // ============================================================
    // LEAD ID GENERATOR
    // ============================================================
    function LeadIdGenerator() { }
    LeadIdGenerator.prototype.generateFromElement = function (element) {
        var inquiryId = Core.elementLeadId(element);
        if (inquiryId) return 'dm_' + inquiryId;
        // 1. Direct lead / enquiry ID attributes
        var dataId = element.getAttribute('data-lead-id')
            || element.getAttribute('data-query-id')
            || element.getAttribute('data-blid');
        if (dataId) return 'dm_' + dataId;

        var elemId = element.getAttribute('id') || '';
        var idMatch = elemId.match(/(?:BLCard|BLbp|card)[_\-]?(\d+)/i);
        // Real IndiaMART enquiry/lead IDs have 6+ digits; small numbers (e.g. id_BLCard1) are DOM indices, not lead IDs
        if (idMatch && idMatch[1].length >= 6) return 'cid_' + idMatch[1];

        // 2. Links with lead IDs
        var links = element.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            var match = href.match(/(?:leadid|blid|queryid)[=\/](\d+)/i);
            if (match) return 'lnk_' + match[1];
        }

        // 3. Button attributes (data-click-data, data-query-id, data-lead-id)
        var btn = element.querySelector('button, a, [role="button"]');
        if (btn) {
            var btnData = btn.getAttribute('data-click-data') || '';
            var btnMatch = btnData.match(/"(?:queryid|leadid)"\s*:\s*"?(\d+)"?/i)
                || btnData.match(/(?:queryid|leadid)=(\d+)/i);
            if (btnMatch) return 'btn_' + btnMatch[1];
            var btnDirectId = btn.getAttribute('data-query-id') || btn.getAttribute('data-lead-id');
            if (btnDirectId) return 'btn_' + btnDirectId;
        }

        // 4. Distinguish by Product + Location + Seller / Buyer + Quantity + Requirement
        var PRODUCT_SELECTORS = [
            '.BLbp_title', '[class*="BuyLdC"] span.SLC_f18', '[class*="BuyLdC"] .SLC_f18',
            'span.SLC_f18', '.SLC_f18', '[class*="BLbp_title" i]', '[class*="BLbp_head" i]',
            '[class*="prod_name" i], [class*="product_name" i]', '[class*="title" i]', 'h2, h3, h4'
        ];
        var productText = '';
        for (var psi = 0; psi < PRODUCT_SELECTORS.length && productText.length < 2; psi++) {
            var psNodes = element.querySelectorAll(PRODUCT_SELECTORS[psi]);
            for (var pni = 0; pni < psNodes.length; pni++) {
                var psTxt = (psNodes[pni].textContent || '').replace(/\s+/g, ' ').trim();
                if (psTxt.length >= 2) { productText = psTxt; break; }
            }
        }
        if (!productText || productText.length < 2) {
            var searchFallback = element.querySelector('.BLbp_desc em, [class*="BuyLdC_msg"] em');
            if (searchFallback && searchFallback.textContent.trim().length >= 2) {
                productText = searchFallback.textContent.trim();
            }
        }

        // If card DOM exists but product text has not yet hydrated, do NOT emit a blank hash (hash_29tds).
        // Returning null allows Scanner to wait 150ms for React hydration instead of skipping with "no product name".
        if (!productText || productText.length < 2) return null;

        var locEl = element.querySelector('.BLbp_hdrLeft strong.BuyLdC_tltpw')
            || element.querySelector('[class*="BuyLdC_time_loc"] strong');
        var locationText = locEl ? locEl.textContent.replace(/(?:click\s*here|view\s*contact|view\s*details|view\s*phone)[\s\S]*$/i, '').trim() : '';

        var sellerEl = element.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
        var sellerText = sellerEl ? sellerEl.textContent.trim() : '';

        var descEl = element.querySelector('.BLbp_desc, [class*="BuyLdC_msg"], [class*="desc"]');
        var descText = descEl ? descEl.textContent.trim() : '';

        var qtyEl = element.querySelector('.BLbp_qty, [class*="quantity"], [class*="qty"]');
        var qtyText = qtyEl ? qtyEl.textContent.trim() : '';

        var cleanProd = productText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 40);
        var cleanLoc = locationText ? locationText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 20) : '';
        var cleanSeller = sellerText ? sellerText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 20) : '';

        var idName = cleanProd || 'lead';
        if (cleanLoc) idName += '_' + cleanLoc;
        if (cleanSeller) idName += '_' + cleanSeller;

        var detailText = (qtyText + '|' + descText).replace(/\s+/g, ' ').trim().toLowerCase();
        if (detailText) {
            var detailHash = 2166136261;
            for (var di = 0; di < detailText.length; di++) {
                detailHash = Math.imul(detailHash ^ detailText.charCodeAt(di), 16777619);
            }
            idName += '_' + (detailHash >>> 0).toString(36);
        }

        return 'lead_' + idName;
    };

    // ============================================================
    // PAGE NAVIGATOR (SPEED-TUNED)
    // ============================================================
    function PageNavigator(orchestrator) {
        this.logger = new Logger('Navigator');
        this.orchestrator = orchestrator;
        this._running = false;
        this._loopTimer = null;
        this._startTimer = null;
        this._cooldownTimer = null;
        this._settleTimer = null;
        this._stepTimer = null;
        this._queueWaitTimer = null;
        this._reloadTimer = null;
        this._reloadInProgress = false;
        this._lastReloadTime = 0;
        this._loopInProgress = false;
        this._noMoreCount = 0;
        this._lastLeadCount = 0;
        this._stuckCount = 0;
        this._settings = {
            loopIntervalMs: 100, loadMoreWaitMs: 900, maxStuckLoops: 3,
            autoReloadOnComplete: true, autoReloadDelayMs: 2500, reloadJitterMs: 400, maxReloadsPerSession: 999999
        };
        this._lastFilterCheck = Date.now();
        this.RELOAD_STORAGE_KEY = 'bl_auto_reload_count';
    }

    PageNavigator.prototype.applySettings = function (config) {
        // Scroll-related settings (scrollSpeed, scrollDelayMs, bottomWaitMs) are ignored —
        // automatic scrolling has been removed.
        if (config.loopIntervalMs) this._settings.loopIntervalMs = config.loopIntervalMs;
        if (config.loadMoreWaitMs) this._settings.loadMoreWaitMs = config.loadMoreWaitMs;
        if (config.maxStuckLoops) this._settings.maxStuckLoops = config.maxStuckLoops;
        this._settings.autoReloadOnComplete = config.autoReloadOnComplete !== undefined ? !!config.autoReloadOnComplete : true;
        if (config.autoReloadDelayMs) this._settings.autoReloadDelayMs = config.autoReloadDelayMs;
        if (config.maxReloadsPerSession) this._settings.maxReloadsPerSession = config.maxReloadsPerSession;
        if (config.liveScanWaitMs !== undefined) {
            try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.remove('liveScanWaitMs'); } catch (e) { }
        }
    };

    PageNavigator.prototype.start = function () {
        if (this._running) return;
        this._running = true;
        var self = this;
        this.logger.info('▶ Bottom-loop navigator started');
        if (this._startTimer) { clearTimeout(this._startTimer); }
        // If cards already exist in the DOM (idle cards), start loop immediately in 50ms;
        // otherwise wait a minimal 300ms for initial DOM paint.
        var hasCards = (typeof document !== 'undefined' && document.querySelectorAll &&
            document.querySelectorAll('[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], div[id*="id_BLCard"], [class*="BLCard"]').length > 0);
        var initialDelay = hasCards ? 20 : 150;
        this._startTimer = setTimeout(function () { self._startLoop(); }, initialDelay);
    };

    PageNavigator.prototype.stop = function () {
        this._running = false;
        this._loopInProgress = false;
        this._reloadInProgress = false;
        this._stuckCount = 0;
        // Bug fix: _lastReloadTime was not reset on stop(), causing the storm guard
        // in _autoReloadPage to block the first reload of a new cycle if stop()+start()
        // happened within 1 second (common during filter refresh or emergency stop/resume).
        this._lastReloadTime = 0;
        if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
        if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
        if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
        if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
        if (this._stepTimer) { clearTimeout(this._stepTimer); this._stepTimer = null; }
        if (this._queueWaitTimer) { clearTimeout(this._queueWaitTimer); this._queueWaitTimer = null; }
        if (this._waitForCardsTimer) { clearTimeout(this._waitForCardsTimer); this._waitForCardsTimer = null; }
        if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
        this.logger.info('⏹ Bottom-loop navigator cleanly stopped (all timers cleared)');
    };

    PageNavigator.prototype.restart = function () {
        this.stop();
        this._running = true;
        this._loopInProgress = false;
        var self = this;
        this.logger.info('🔄 Bottom-loop navigator restarted cleanly');
        // No automatic scroll — scan starts from whatever is currently visible.
        this._startTimer = setTimeout(function () {
            self._startLoop();
        }, 200);
    };

    PageNavigator.prototype._startLoop = function () {
        var self = this;
        if (!this._running || this._loopInProgress) return;
        this._loopInProgress = true;

        try {
            // If all filters are already completed, stop loop and transition to IDLE
            if (self.orchestrator && self.orchestrator.keywordManager) {
                var activeCount = self.orchestrator.keywordManager.getActiveFilterCount();
                if (activeCount === 0 && self.orchestrator.supabase && self.orchestrator.supabase._filtersLoaded) {
                    self._loopInProgress = false;
                    self.orchestrator._updateScannerLifecycleState('all_filters_completed');
                    return;
                }
            }

            // FIX: this used to call startNewCycle() AND scanner.resetEmitted() on every pass,
            // re-emitting every card already evaluated moments earlier. Now a new cycle starts
            // only when the current one has actually scanned something or is stale, and the
            // emitted-cache (dedup state) is preserved. Deferred cards are re-emitted via
            // scanner.forget(); filter changes still call resetEmitted() explicitly.
            var orch = self.orchestrator;
            if (orch && orch.startNewCycle) {
                var cycleAge = Date.now() - (orch._cycleStartedAt || 0);
                if ((orch.stats && orch.stats.cycleScanned > 0) || cycleAge > 5000) {
                    orch.startNewCycle(null, false, 'navigator_pass');
                }
            }

            // Scan the first MAX_LEADS_PER_CYCLE visible lead cards — no scrolling.
            self._scanVisibleLeads(function () {
                if (!self._running) { self._loopInProgress = false; return; }

                self._loopInProgress = false;
                if (self.orchestrator && self.orchestrator.stats) {
                    self.orchestrator.stats.loopsCompleted++;
                    if (self.orchestrator.stats.cycleScanned > 0) {
                        self._stuckCount = 0;
                    }
                }

                // Wait for all queued acquisition/contact actions to finish,
                // then trigger reload or next loop.
                self._waitForQueueAndReload();
            });
        } catch (e) {
            self._loopInProgress = false;
            self._scheduleNextLoop();
        }
    };

    // Scan the first MAX_LEADS_PER_CYCLE visible lead cards without any scrolling.
    // Cards that are already in the DOM (rendered by the page's own AJAX feed) are
    // evaluated in the portal's natural display order.  No scrollIntoView, no
    // window.scrollTo, no load-more clicking.
    PageNavigator.prototype._scanVisibleLeads = function (done) {
        var self = this;
        if (!this._running) { done(); return; }

        var MAX_CONTENT_RETRIES = 3;
        var CONTENT_WAIT_MS = 25;

        function tryCards(attempt) {
            if (!self._running) { done(); return; }

            var allCards = (typeof document !== 'undefined') ? document.querySelectorAll(
                '[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], ' +
                'div[id*="id_BLCard"], [class*="BLCard"], [class*="bl_card"], div[id*="BLCard"], ' +
                'div[id*="BLbp"], [class*="bl-card"], [class*="listing_card"]'
            ) : [];

            if (allCards.length === 0) {
                if (attempt < MAX_CONTENT_RETRIES) {
                    self._waitForCardsTimer = setTimeout(function () {
                        self._waitForCardsTimer = null;
                        tryCards(attempt + 1);
                    }, CONTENT_WAIT_MS);
                    return;
                }
                // Cards never appeared — let cycle complete without scanning
                done(); return;
            }

            // Check that the first card has text content (product/location rendered).
            // After a hard reload the DOM shell appears before text nodes are populated.
            var firstCard = allCards[0];
            var firstCardText = firstCard ? (firstCard.textContent || '').trim() : '';
            if (firstCardText.length < 5 && attempt < MAX_CONTENT_RETRIES) {
                self._waitForCardsTimer = setTimeout(function () {
                    self._waitForCardsTimer = null;
                    tryCards(attempt + 1);
                }, CONTENT_WAIT_MS);
                return;
            }

            // Cards exist and have content — run scan.
            if (self.orchestrator && self.orchestrator.scanner) {
                self.orchestrator.scanner._scan();
            }
            done();
        }

        tryCards(0);
    };

    PageNavigator.prototype._refreshPortalForNewLeads = function () {
        // A native refresh can also replace lead cards/dialog nodes, so never run it
        // while an acquisition/contact action is processing or waiting in the queue.
        var q = this.orchestrator && this.orchestrator.queue;
        if (q && (q.processing > 0 || (q.queue && q.queue.length > 0))) {
            this.logger.debug('Native refresh deferred: acquisition/contact queue is busy');
            return false;
        }

        try {
            // Prefer IndiaMART's own "New Leads Available" banner. Do not click
            // a second refresh control in the same pass if that banner handled it.
            if (this.orchestrator && this.orchestrator.scanner && this.orchestrator.scanner._checkNewLeadsBanner) {
                if (this.orchestrator.scanner._checkNewLeadsBanner()) {
                    this.logger.info('Native in-page refresh triggered via new-leads banner');
                    return true;
                }
            }

            // Otherwise use IndiaMART's native refresh button/icon (AJAX/in-page).
            var refreshSelectors = [
                '#refreshBL', '#refresh_lead', '[id*="refresh_leads" i]',
                'button[class*="refresh" i]', 'a[class*="refresh" i]',
                '[class*="icon-refresh"]', '[class*="refresh_icon"]',
                '[title*="refresh" i]', '[aria-label*="refresh" i]',
                '[data-action*="refresh" i]'
            ];
            for (var r = 0; r < refreshSelectors.length; r++) {
                var refEl = document.querySelector(refreshSelectors[r]);
                if (refEl && refEl.id !== 'bl-refresh-btn' && (!refEl.id || refEl.id.indexOf('bl-') !== 0)) {
                    try {
                        refEl.click();
                        this.logger.info('Native in-page refresh clicked: ' + refreshSelectors[r]);
                        return true;
                    } catch (e) { }
                }
            }
        } catch (e) { }
        return false;
    };

    PageNavigator.prototype._scheduleNextLoop = function () {
        var self = this;
        if (!this._running) return;
        this._loopTimer = setTimeout(function () { self._startLoop(); }, this._settings.loopIntervalMs);
    };

    // _fastScrollToBottom removed — automatic scrolling is disabled.
    // The extension scans only the first MAX_LEADS_PER_CYCLE leads already visible
    // in the portal's AJAX feed without triggering additional feed loads.

    PageNavigator.prototype._findLoadMoreButton = function () {
        // Direct selectors first — no waiting.
        var direct = document.querySelectorAll('button.BuyLdC_Cta');
        for (var i = 0; i < direct.length; i++) {
            var t = (direct[i].textContent || '').trim().toLowerCase();
            if (t.indexOf('show more') !== -1 || t.indexOf('load more') !== -1 || t.indexOf('more buylead') !== -1) {
                return direct[i];
            }
        }
        var broad = document.querySelectorAll('button[class*="BuyLdC_Cta"], [class*="BuyLdC_Cta"]');
        for (var j = 0; j < broad.length; j++) {
            var el = broad[j];
            if (el.tagName !== 'BUTTON') continue;
            var t2 = (el.textContent || '').trim().toLowerCase();
            if (t2.indexOf('show more') !== -1 || t2.indexOf('load more') !== -1) return el;
        }
        // Last resort: scan all buttons once.
        var all = document.querySelectorAll('button');
        for (var k = 0; k < all.length; k++) {
            var t3 = (all[k].textContent || '').trim().toLowerCase();
            if (t3.indexOf('show more') !== -1 || t3.indexOf('load more') !== -1) return all[k];
        }
        return null;
    };

    PageNavigator.prototype._clickLoadMore = function () {
        var btn = this._findLoadMoreButton();
        if (!btn) return false;
        try {
            btn.click();
            this.logger.debug('✅ Load-more clicked');
            return true;
        } catch (e) {
            this.logger.warn('Load-more click failed: ' + e.message);
            return false;
        }
    };

    PageNavigator.prototype._countLeads = function () {
        try { return document.querySelectorAll('[class*="BuyLdC_cont"]').length; } catch (e) { return 0; }
    };

    PageNavigator.prototype._waitForQueueAndReload = function () {
        var self = this;

        // Minimal settle — allows toasts/metrics to paint before idle-check.
        // Bug fix: was anonymous setTimeout (uncancellable). Now stored as _settleTimer
        // so stop() can cancel it and prevent ghost reloads after stop() is called.
        var SETTLE_MS = 50;

        if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
        this._settleTimer = setTimeout(function () {
            self._settleTimer = null;
            checkQueue();
        }, SETTLE_MS);

        function checkQueue() {
            if (!self._running) return;

            // If the orchestrator paused (e.g. lead acquired), never reload.
            if (self.orchestrator && self.orchestrator._isPaused) return;

            // If there are no unfinished filters, stop without reloading.
            var activeCount = (self.orchestrator && self.orchestrator.keywordManager)
                ? self.orchestrator.keywordManager.getActiveFilterCount()
                : 0;
            if (self.orchestrator && self.orchestrator._supabaseEnabled && self.orchestrator.supabase && self.orchestrator.supabase._filtersLoaded && activeCount === 0) {
                self.logger.info('All filters completed; no reload needed');
                if (self.orchestrator._updateScannerLifecycleState) {
                    self.orchestrator._updateScannerLifecycleState('all_filters_completed');
                }
                return;
            }

            // Wait until acquisition / contact / popup work is fully idle.
            var q = self.orchestrator && self.orchestrator.queue;
            var isQueueBusy = q && (q.processing > 0 || (q.queue && q.queue.length > 0));
            var isPopupActive = self.orchestrator && self.orchestrator.popupManager && self.orchestrator.popupManager._active;
            var isScannerBusy = self.orchestrator && self.orchestrator.scanner && (self.orchestrator.scanner._scanning || self.orchestrator.scanner._scanPending);
            var isLifecycleInFlight = self.orchestrator && self.orchestrator.lifecycle && self.orchestrator.lifecycle._inFlight && self.orchestrator.lifecycle._inFlight.size > 0;
            var isLeadProcessing = self.orchestrator && self.orchestrator.stateMachine && (function () {
                var smStats = self.orchestrator.stateMachine.getStats();
                return (smStats.PROCESSING || 0) > 0 || (smStats.ACQUISITION_PENDING || 0) > 0 || (smStats.CONTACT_PENDING || 0) > 0;
            })();

            if (isQueueBusy || isPopupActive || isScannerBusy || isLifecycleInFlight || isLeadProcessing) {
                self._queueWaitTimer = setTimeout(function () {
                    self._queueWaitTimer = null;
                    checkQueue();
                }, 100);
                return;
            }

            // Re-check: orchestrator may have paused while queue was draining.
            if (self.orchestrator && self.orchestrator._isPaused) return;

            // If this cycle acquired anything, check operating mode
            if (self.orchestrator && self.orchestrator._cycleAcquiredThisScan) {
                if (self.orchestrator.config && self.orchestrator.config.mode === 'AUTOMATIC') {
                    self.orchestrator._cycleAcquiredThisScan = false;
                } else {
                    self.logger.info('⏸ Cycle acquired a lead — reload skipped, waiting for user resume');
                    return;
                }
            }

            self._loopTimer = setTimeout(function () { if (self._running) self._startLoop(); }, 2000);
        }
    };

    // Alias for backward compatibility
    PageNavigator.prototype._waitForQueueAndNativeRefresh = function () {
        return this._waitForQueueAndReload();
    };

    // Legacy reload entry point is intentionally disabled in every runtime.
    PageNavigator.prototype._autoReloadPage = function () { return false; };

    PageNavigator.prototype._showReloadOverlay = function (n) {
        // Overlay removed — silent reload
    };

    PageNavigator.prototype._showFinalBanner = function () {
        try {
            var existing = document.getElementById('bl-final-banner');
            if (existing) existing.remove();
            var banner = document.createElement('div');
            banner.id = 'bl-final-banner';
            banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fff8e8;border:2px solid #f5a623;border-radius:8px;padding:14px 20px;z-index:2147483646;font-family:-apple-system,Arial,sans-serif;font-size:13px;color:#1a1a2e;max-width:400px;';
            banner.innerHTML = '<div style="font-weight:700;color:#f5a623;margin-bottom:4px;">🛑 Session Limit Reached</div>' +
                '<div style="font-size:11px;color:#666;">Auto-reloaded ' + this._settings.maxReloadsPerSession + ' times. Please refresh manually.</div>';
            document.body.appendChild(banner);
        } catch (e) { }
    };

    PageNavigator.prototype._isInDOM = function (el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PageNavigator.prototype.getStatus = function () {
        return {
            running: this._running, loopInProgress: this._loopInProgress,
            noMoreCount: this._noMoreCount, stuckCount: this._stuckCount,
            currentLeads: this._countLeads(), lastLeadCount: this._lastLeadCount
        };
    };

    // ============================================================
    // POPUP MANAGER (SPEED-TUNED)
    // ============================================================
    function PopupManager() {
        this.logger = new Logger('PopupManager');
        this._active = false;
        this._onHandled = null;
        this._watchInterval = null;
        this._observer = null;
        this._watchTimeout = 5000;
        this._handledCount = 0;
        this._confirmationAnswer = 'yes';
        this._purchaseAction = 'close';
        this._mutationSeen = false;
    }

    PopupManager.prototype._classifyPopup = function (el) {
        var text = (el.textContent || '').toLowerCase();

        // Count visible Yes/No buttons
        var buttons = el.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"]');
        var hasYes = false, hasNo = false;
        for (var i = 0; i < buttons.length; i++) {
            var bt = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase();
            if (bt === 'yes' || bt === 'ok' || bt === 'confirm' || bt === 'proceed') hasYes = true;
            if (bt === 'no' || bt === 'cancel' || bt === 'dismiss') hasNo = true;
        }

        // Confirmation takes priority — never auto-close a modal that needs an answer.
        if (hasYes && hasNo) return 'CONFIRMATION';
        if (text.indexOf('do you want') !== -1 || text.indexOf('are you sure') !== -1 ||
            text.indexOf('would you like') !== -1 || text.indexOf('days old') !== -1 ||
            text.indexOf('day old') !== -1) return 'CONFIRMATION';

        // Purchase: require 'purchase' OR ('buy' AND '₹'), and never when Yes/No present
        var isPurchase = text.indexOf('purchase buylead') !== -1 ||
            text.indexOf("to view buyer's contact details") !== -1 ||
            text.indexOf('single india buylead') !== -1 ||
            text.indexOf('mdc pro') !== -1 ||
            (text.indexOf('per buylead') !== -1 && text.indexOf('₹') !== -1) ||
            (text.indexOf('buy') !== -1 && text.indexOf('₹') !== -1);
        if (isPurchase) return 'PURCHASE';

        if ((hasYes || hasNo) && buttons.length >= 2 && text.length > 20) return 'CONFIRMATION';
        if (el.querySelectorAll('ul li, nav a, [role="menuitem"]').length > 2) return 'NAVIGATION';
        return 'UNKNOWN';
    };

    PopupManager.prototype.watchForPopup = function (callback, options) {
        var self = this;
        options = options || {};
        this._onHandled = callback;
        this._active = true;
        this._watchTimeout = options.timeout || 5000;
        this._confirmationAnswer = options.confirmationAnswer || 'yes';
        this._purchaseAction = options.purchaseAction || 'close';

        var existingPopups = this._findAllPopups();
        var existingSet = new Set(existingPopups);
        var startTime = Date.now();
        this._mutationSeen = false;

        // MutationObserver gate — only re-scan when DOM actually changed
        if (this._observer) { try { this._observer.disconnect(); } catch (e) { } }
        try {
            this._observer = new MutationObserver(function () { self._mutationSeen = true; });
            this._observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) { }

        if (this._watchInterval) clearInterval(this._watchInterval);

        this._watchInterval = setInterval(function () {
            if (!self._active) { self._cleanup(); return; }

            // Skip DOM scan if nothing mutated since last check
            if (!self._mutationSeen && Date.now() - startTime > 400) {
                if (Date.now() - startTime > self._watchTimeout) {
                    self._finish({ success: false, reason: 'timeout', action: 'timeout' });
                }
                return;
            }
            self._mutationSeen = false;

            var popups = self._findAllPopups();
            var targetPopup = null;
            for (var i = 0; i < popups.length; i++) {
                if (!existingSet.has(popups[i])) { targetPopup = popups[i]; break; }
            }
            if (!targetPopup) {
                for (var j = 0; j < popups.length; j++) {
                    var cls = self._classifyPopup(popups[j]);
                    if (cls === 'CONFIRMATION' || cls === 'PURCHASE') { targetPopup = popups[j]; break; }
                }
            }

            if (targetPopup) {
                var type = self._classifyPopup(targetPopup);
                self.logger.info('Popup detected: ' + type + ' (' + (Date.now() - startTime) + 'ms)');
                self._handlePopup(targetPopup, type);
                return;
            }

            if (Date.now() - startTime > self._watchTimeout) {
                self._finish({ success: false, reason: 'timeout', action: 'timeout' });
            }
        }, 60);
    };

    PopupManager.prototype._cleanup = function () {
        this._active = false;
        if (this._watchInterval) { clearInterval(this._watchInterval); this._watchInterval = null; }
        if (this._observer) { try { this._observer.disconnect(); } catch (e) { } this._observer = null; }
    };

    PopupManager.prototype._finish = function (result) {
        var cb = this._onHandled;
        this._cleanup();
        if (cb) cb(result);
    };

    PopupManager.prototype._findAllPopups = function () {
        var found = [];
        var seen = new Set();
        var vw = window.innerWidth, vh = window.innerHeight;

        // 1) IndiaMART-specific selectors
        try {
            var imEls = document.querySelectorAll('.SLC_PopCntr, [class*="SLC_PopCntr"], [class*="Cnt_blpack"]');
            for (var a = 0; a < imEls.length; a++) {
                var el = imEls[a];
                if (seen.has(el) || (el.id && el.id.indexOf('bl-') === 0)) continue;
                if (!this._isVisible(el)) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 100 || r.height < 60) continue;
                seen.add(el); found.push(el);
            }
        } catch (e) { }

        // 2) Generic selectors
        var selectors = ['[role="dialog"]', '[role="alertdialog"]', '[class*="modal"]', '[class*="Modal"]',
            '[class*="popup"]', '[class*="Popup"]', '[class*="overlay"]', '[class*="Overlay"]',
            '[class*="dialog"]', '[class*="Dialog"]', '[class*="blp_"]', '[class*="purchase"]', '[class*="Purchase"]'];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                    var e2 = els[j];
                    if (seen.has(e2) || (e2.id && e2.id.indexOf('bl-') === 0)) continue;
                    if (!this._isVisible(e2)) continue;
                    var r2 = e2.getBoundingClientRect();
                    if (r2.width < 100 || r2.height < 60) continue;
                    if (r2.width > vw * 0.99 && r2.height > vh * 0.99) continue;
                    seen.add(e2); found.push(e2);
                }
            } catch (e) { }
        }

        return found;
    };

    PopupManager.prototype._handlePopup = function (popup, type) {
        this.logger.info('Handling ' + type + ' popup');
        if (type === 'PURCHASE') this._handlePurchase(popup);
        else if (type === 'CONFIRMATION') this._handleConfirmation(popup);
        else if (type === 'NAVIGATION') this._handleNavigation(popup);
        else this._handleUnknown(popup);
    };

    PopupManager.prototype._handlePurchase = function (popup) {
        this.logger.warn('💳 Purchase modal detected');
        if (this._purchaseAction === 'stop') {
            this._finish({ success: false, action: 'stopped', type: 'PURCHASE', reason: 'purchase_required', stopAcquiring: true });
            return;
        }
        var closeBtn = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
        if (!closeBtn) {
            var spans = popup.querySelectorAll('span[style*="right"]');
            for (var i = 0; i < spans.length; i++) { if (spans[i].querySelector('svg')) { closeBtn = spans[i]; break; } }
        }
        if (!closeBtn) closeBtn = this._findCloseButton(popup);
        if (closeBtn) {
            try {
                closeBtn.click();
                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (e) { }
                document.body.style.overflow = '';
                this._handledCount++;
                this._finish({ success: true, action: 'purchase_closed', type: 'PURCHASE' });
                return;
            } catch (err) { }
        }
        // Hard hide fallback
        try {
            popup.style.display = 'none';
            var parent = popup.parentElement;
            if (parent && (parent.className || '').toString().indexOf('fixed') !== -1) parent.style.display = 'none';
            document.body.style.overflow = '';
            this._finish({ success: true, action: 'purchase_hidden', type: 'PURCHASE' });
        } catch (err) {
            this._finish({ success: false, reason: 'cannot_close', action: 'purchase_failed', type: 'PURCHASE' });
        }
    };

    PopupManager.prototype._handleConfirmation = function (popup) {
        var answer = this._confirmationAnswer || 'yes';
        this.logger.info('Confirmation - answer: ' + answer);
        var buttons = popup.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"], span[class*="btn"], div[class*="btn"]');
        var target = null;
        var keywords = answer === 'yes'
            ? ['yes', 'ok', 'confirm', 'proceed', 'continue', 'accept', 'sure']
            : ['no', 'cancel', 'dismiss', 'skip', 'later'];
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (!this._isVisible(btn)) continue;
            var t = (btn.textContent || btn.value || '').trim().toLowerCase();
            for (var k = 0; k < keywords.length; k++) {
                if (t === keywords[k]) { target = btn; break; }
            }
            if (target) break;
        }
        if (!target) {
            for (var i2 = 0; i2 < buttons.length; i2++) {
                var btn2 = buttons[i2];
                if (!this._isVisible(btn2)) continue;
                var t2 = (btn2.textContent || btn2.value || '').trim().toLowerCase();
                for (var k2 = 0; k2 < keywords.length; k2++) {
                    if (t2.indexOf(keywords[k2]) !== -1 && t2.length < 30) { target = btn2; break; }
                }
                if (target) break;
            }
        }
        if (!target && buttons.length > 0) target = answer === 'yes' ? buttons[buttons.length - 1] : buttons[0];
        if (target) {
            try {
                target.click();
                this._handledCount++;
                this._finish({ success: true, action: 'confirm_' + answer, type: 'CONFIRMATION' });
                return;
            } catch (err) { }
        }
        this._finish({ success: false, reason: 'no_button', action: 'confirm_failed', type: 'CONFIRMATION' });
    };

    PopupManager.prototype._handleNavigation = function (popup) {
        var btn = this._findCloseButton(popup);
        if (btn) { try { btn.click(); } catch (e) { } }
        else {
            try {
                document.body.click();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            } catch (e) { }
        }
        this._finish({ success: true, action: 'nav_closed', type: 'NAVIGATION' });
    };

    PopupManager.prototype._handleUnknown = function (popup) {
        var btn = this._findCloseButton(popup);
        if (btn) {
            try { btn.click(); } catch (e) { }
            this._finish({ success: true, action: 'closed', type: 'UNKNOWN' });
            return;
        }
        this._finish({ success: false, reason: 'unknown', action: 'unknown', type: 'UNKNOWN' });
    };

    PopupManager.prototype._findCloseButton = function (popup) {
        var slc = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
        if (slc && this._isVisible(slc)) return slc;
        var sels = ['[class*="close"]', '[aria-label*="close" i]', '[title*="close" i]', '[class*="cross"]'];
        for (var i = 0; i < sels.length; i++) {
            try { var el = popup.querySelector(sels[i]); if (el && this._isVisible(el)) return el; } catch (e) { }
        }
        var btns = popup.querySelectorAll('button, span[class*="close"], span[class*="SLC"]');
        for (var j = 0; j < btns.length; j++) {
            var b = btns[j];
            if (!this._isVisible(b)) continue;
            var t = (b.textContent || '').trim();
            if (t === '×' || t === '✕' || t === 'X' || t === 'x') return b;
        }
        return null;
    };

    PopupManager.prototype._isVisible = function (el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PopupManager.prototype.cancel = function () { this._cleanup(); };
    PopupManager.prototype.getCount = function () { return this._handledCount; };

    // ============================================================
    // MATCHING ENGINE & KEYWORD NORMALIZATION (v6.3 - GRAVITAS)
    // ============================================================
    function normalizeText(text) {
        if (!text) return '';
        return String(text)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')          // strip diacritics (creme == crème)
            .toLowerCase()
            .replace(/(\d+)\s*(g|gm|gms|gram|grams|kg|kgs|ml|ltr|l|mg|mcg|oz|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|pc|pcs|piece|pieces|box|boxes|strip|strips|vial|vials|bottle|bottles|pack|packs)\b/gi, '$1$2')
            .replace(/(\d+(?:\.\d+)?)\s*(?:gm|gms|gram|grams)\b/gi, '$1g')
            .replace(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|litres|liter|liters)\b/gi, '$1l')
            .replace(/\bspf\s*(\d+)\b/gi, 'spf$1')
            .replace(/[\u2010-\u2015\u2212\-]/g, ' ')   // all dash variants == space (a-ret == a ret)
            .replace(/[^\p{L}\p{N}_\s\.%]/gu, ' ')       // Unicode-aware: keep non-Latin letters
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokenize(normalizedText) {
        if (!normalizedText) return [];
        return normalizedText.split(/\s+/).filter(function (t) { return t.length > 0; });
    }

    var COMMON_FORMS = [
        'gel', 'cream', 'lotion', 'ointment', 'serum', 'oil', 'soap', 'facewash', 'face wash',
        'tablet', 'capsule', 'syrup', 'injection', 'powder', 'drops', 'spray', 'solution', 'shampoo',
        'sunscreen', 'cleanser', 'scrub', 'moisturizer', 'balm'
    ];

    var COMMON_FORM_REGEXES = COMMON_FORMS.map(function (f) {
        return { form: f, rx: new RegExp('\\b' + f + '\\b', 'i') };
    });

    var SYNONYM_MAP = {
        'sunscreen': ['sun screen', 'sunblock', 'sun block', 'sun protection'],
        'facewash': ['face wash', 'facial cleanser', 'cleanser'],
        'moisturizer': ['moisturiser', 'moisturizing cream', 'cold cream'],
        'tab': ['tablet', 'tablets'],
        'cap': ['capsule', 'capsules'],
        'inj': ['injection', 'injections'],
        'syr': ['syrup']
    };

    var QUALIFIER_WORDS = {
        'usp': 1, 'bp': 1, 'ip': 1, 'ep': 1, 'jp': 1, 'cp': 1,
        'grade': 1, 'api': 1,
        'personal': 1, 'use': 1, 'commercial': 1, 'industrial': 1,
        'for': 1, 'in': 1, 'and': 1, 'with': 1, 'of': 1, 'the': 1, 'a': 1, 'an': 1,
        'pharma': 1, 'pharmaceutical': 1, 'standard': 1, 'pure': 1, 'bulk': 1
    };

    function extractAttributes(normText) {
        var attrs = { spf: null, strengths: [], sizes: [], forms: [] };
        if (!normText) return attrs;

        var spfMatch = normText.match(/\bspf(\d+)\b/);
        if (spfMatch) attrs.spf = 'spf' + spfMatch[1];

        var strengthMatches = normText.match(/\b\d+(?:\.\d+)?(?:mg|mcg|iu|%)(?![a-z0-9])/g);
        if (strengthMatches) attrs.strengths = strengthMatches;

        var sizeMatches = normText.match(/\b\d+(?:\.\d+)?(?:g|gm|kg|ml|l|ltr|oz)\b/g);
        if (sizeMatches) attrs.sizes = sizeMatches;

        for (var i = 0; i < COMMON_FORM_REGEXES.length; i++) {
            if (COMMON_FORM_REGEXES[i].rx.test(normText)) attrs.forms.push(COMMON_FORM_REGEXES[i].form);
        }
        return attrs;
    }

    function tokensEquivalent(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        // Legacy medicine labels sometimes omit the percent sign (e.g. 0.025 cream).
        if (/^\d+\.\d+%?$/.test(a) && /^\d+\.\d+%?$/.test(b) && a.replace('%', '') === b.replace('%', '')) return true;
        // Symmetric singular/plural matching (e.g. glove/gloves, box/boxes).
        if (Math.min(a.length, b.length) > 2 && (a === b + 's' || a === b + 'es' || a + 's' === b || a + 'es' === b)) return true;
        // Common consonant + y / ies inflection (e.g. battery/batteries).
        if (a.length > 4 && a.slice(-3) === 'ies' && a.slice(0, -3) + 'y' === b) return true;
        if (b.length > 4 && b.slice(-3) === 'ies' && b.slice(0, -3) + 'y' === a) return true;
        return false;
    }

    function wordBoundaryMatch(haystackNorm, needleNorm) {
        if (!haystackNorm || !needleNorm) return false;
        var needleTokens = tokenize(needleNorm);
        var haystackTokens = tokenize(haystackNorm);
        if (needleTokens.length === 0 || haystackTokens.length === 0) return false;

        // Every token in the CRM keyword must occur as a whole token in the lead
        // title. Order may differ, but partial prefixes such as "cotton" matching
        // "cottonseed" are deliberately not accepted.
        for (var k = 0; k < needleTokens.length; k++) {
            var found = false;
            for (var j = 0; j < haystackTokens.length; j++) {
                if (tokensEquivalent(haystackTokens[j], needleTokens[k])) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    // Whole-keyword synonym matching. Only treat a keyword as a synonym when the
    // complete configured term is one of the known aliases; this avoids matching a
    // long product keyword merely because it contains a generic word such as "cream".
    function keywordMatchesText(text, keyword) {
        var normText = normalizeText(text);
        var normKeyword = normalizeText(keyword);
        if (!normText || !normKeyword) return false;
        if (wordBoundaryMatch(normText, normKeyword)) return true;
        for (var key in SYNONYM_MAP) {
            var forms = [key].concat(SYNONYM_MAP[key] || []);
            var keywordIsAlias = false;
            for (var i = 0; i < forms.length; i++) {
                if (normalizeText(forms[i]) === normKeyword) { keywordIsAlias = true; break; }
            }
            if (!keywordIsAlias) continue;
            for (var j = 0; j < forms.length; j++) {
                if (wordBoundaryMatch(normText, normalizeText(forms[j]))) return true;
            }
        }
        return false;
    }

    var COUNTRY_CODE_MAP = {
        'IN': ['india', 'in', 'ind', 'bharat'],
        'US': ['usa', 'us', 'united states', 'united states of america', 'america', 'usa.'],
        'GB': ['uk', 'united kingdom', 'great britain', 'england', 'britain', 'gb', 'gbr'],
        'UK': ['uk', 'united kingdom', 'great britain', 'england', 'britain', 'gb', 'gbr'],
        'AE': ['uae', 'united arab emirates', 'dubai', 'sharjah', 'abu dhabi', 'ae', 'are'],
        'BD': ['bangladesh', 'bd', 'bgd'],
        'CA': ['canada', 'ca', 'can'],
        'DE': ['germany', 'deutschland', 'de', 'deu'],
        'FR': ['france', 'fr', 'fra'],
        'AU': ['australia', 'au', 'aus'],
        'JP': ['japan'],
        'CN': ['china'],
        'RU': ['russia'],
        'SA': ['saudi arabia', 'saudi'],
        'SG': ['singapore'],
        'MY': ['malaysia'],
        'NP': ['nepal'],
        'LK': ['sri lanka'],
        'PK': ['pakistan'],
        'ID': ['indonesia'],
        'TH': ['thailand'],
        'VN': ['vietnam'],
        'PH': ['philippines'],
        'TR': ['turkey'],
        'EG': ['egypt'],
        'IT': ['italy'],
        'ES': ['spain'],
        'NL': ['netherlands', 'holland'],
        'CH': ['switzerland'],
        'ZA': ['south africa'],
        'NZ': ['new zealand'],
        'BR': ['brazil'],
        'MX': ['mexico'],
        'KR': ['south korea', 'korea'],
        'KW': ['kuwait'],
        'QA': ['qatar'],
        'OM': ['oman'],
        'BH': ['bahrain'],
        'SE': ['sweden'],
        'PL': ['poland'],
        'NO': ['norway'],
        'DK': ['denmark'],
        'FI': ['finland'],
        'IE': ['ireland'],
        'BE': ['belgium'],
        'AT': ['austria'],
        'PT': ['portugal'],
        'IL': ['israel']
    };

    var COUNTRY_NAME_TO_ISO = {};
    for (var isoCode in COUNTRY_CODE_MAP) {
        var cNames = COUNTRY_CODE_MAP[isoCode];
        for (var cn = 0; cn < cNames.length; cn++) {
            COUNTRY_NAME_TO_ISO[cNames[cn]] = (isoCode === 'UK' ? 'GB' : isoCode);
        }
    }
    COUNTRY_NAME_TO_ISO['bangladesh'] = 'BD';
    COUNTRY_NAME_TO_ISO['bd'] = 'BD';
    COUNTRY_NAME_TO_ISO['canada'] = 'CA';
    COUNTRY_NAME_TO_ISO['ca'] = 'CA';
    COUNTRY_NAME_TO_ISO['uk'] = 'GB';
    COUNTRY_NAME_TO_ISO['united kingdom'] = 'GB';
    COUNTRY_NAME_TO_ISO['gb'] = 'GB';

    function LeadMatcher() {
        this.minConfidenceScore = 50;
    }

    // Stage A: Hard Eligibility Constraints
    LeadMatcher.prototype.checkEligibility = function (lead, filter, leadContext) {
        var rawProd = lead.productName || '';
        var rawMcat = lead.mcatName || lead.queryMcatName || lead.category || '';
        var normProd = (leadContext && leadContext.normProd != null) ? leadContext.normProd : normalizeText(rawProd);
        var normMcat = (leadContext && leadContext.normMcat != null) ? leadContext.normMcat : normalizeText(rawMcat);
        var normMessage = (leadContext && leadContext.normMsg != null) ? leadContext.normMsg : normalizeText(lead.messageText || lead.queryMessage || lead.description || '');

        var leadAttrs = (leadContext && leadContext.leadAttrs != null) ? leadContext.leadAttrs : extractAttributes(normProd);

        // 1. Negative keywords rejection (checked against product name & requirement message)
        var negKws = filter.negativeKeywords || filter.negative_keywords || (filter.filter_config && filter.filter_config.negative_keywords) || [];
        for (var i = 0; i < negKws.length; i++) {
            var negNorm = (filter._compiledNegatives && filter._compiledNegatives[i]) || normalizeText(negKws[i]);
            if (negNorm && (keywordMatchesText(normProd, negNorm) || keywordMatchesText(normMessage, negNorm))) {
                return { eligible: false, reason: 'negative_keyword_match', detail: 'Matched negative: ' + negKws[i] };
            }
        }

        // 1.1 Required keywords check
        var reqKws = filter.requiredKeywords || filter.required_keywords || (filter.filter_config && (filter.filter_config.required_keywords || filter.filter_config.requiredKeywords || filter.filter_config.must_have_keywords)) || [];
        if (typeof reqKws === 'string') reqKws = [reqKws];
        var normMessage = normalizeText(lead.messageText || lead.queryMessage || '');
        var matchedRequiredKeyword = reqKws.length === 0;
        for (var rk = 0; rk < reqKws.length; rk++) {
            var reqNorm = normalizeText(reqKws[rk]);
            if (reqNorm && (keywordMatchesText(normProd, reqNorm) || keywordMatchesText(normMessage, reqNorm))) {
                matchedRequiredKeyword = true;
                break;
            }
        }
        if (!matchedRequiredKeyword) {
            return { eligible: false, reason: 'missing_required_keyword', detail: 'No required keyword matched product or buyer requirement text' };
        }

        // 1.2 Match Mode 'all' (AND) constraint
        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        var matchMode = filter.matchMode || (filter.filter_config && filter.filter_config.match_mode) || filter.match_mode || 'any';
        if (matchMode === 'all' && prodKws.length > 1) {
            for (var m = 0; m < prodKws.length; m++) {
                var singleKwNorm = normalizeText(prodKws[m]);
                if (singleKwNorm && !(keywordMatchesText(normProd, singleKwNorm) || keywordMatchesText(normMessage, singleKwNorm))) {
                    return { eligible: false, reason: 'missing_mandatory_keyword', detail: 'Match mode "all" requires: ' + prodKws[m] };
                }
            }
        }

        // Product identity is a hard gate. Scoring/attributes cannot compensate for a missing medicine.
        var productText = normalizeText(rawProd + ' ' + (lead.messageText || lead.queryMessage || ''));
        function productMatches(keyword) {
            var norm = normalizeText(keyword);
            var substantive = tokenize(norm).filter(function (t) { return !QUALIFIER_WORDS[t]; }).join(' ');
            return keywordMatchesText(productText, norm) || (substantive && wordBoundaryMatch(productText, substantive));
        }
        if (prodKws.length && !(matchMode === 'all' ? prodKws.every(productMatches) : prodKws.some(productMatches))) {
            return { eligible: false, reason: 'product_identity_mismatch', detail: 'Configured product tokens are missing from the product/requirement' };
        }
        // 2. Hard attribute conflicts
        if (prodKws.length > 0) {
            var conflictingForms = [
                ['gel', 'lotion'],
                ['gel', 'cream'],
                ['tablet', 'syrup'],
                ['capsule', 'syrup']
            ];

            var compiledList = filter._compiledKeywords || null;
            function checkKwConflict(kwNorm, kwAttrsOpt) {
                var kwAttrs = kwAttrsOpt || extractAttributes(kwNorm);
                // SPF conflict
                if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf !== leadAttrs.spf) {
                    return { hasConflict: true, reason: 'attribute_conflict_spf', detail: 'Filter requires ' + kwAttrs.spf + ' but lead specifies ' + leadAttrs.spf };
                }
                if (kwAttrs.strengths.length && leadAttrs.strengths.length && !kwAttrs.strengths.some(function (v) { return leadAttrs.strengths.indexOf(v) !== -1; })) {
                    return { hasConflict: true, reason: 'attribute_conflict_strength', detail: 'Medicine strengths differ' };
                }
                // Size conflict
                if (kwAttrs.sizes.length > 0 && leadAttrs.sizes.length > 0) {
                    var sizeConflict = true;
                    for (var s1 = 0; s1 < kwAttrs.sizes.length; s1++) {
                        if (leadAttrs.sizes.indexOf(kwAttrs.sizes[s1]) !== -1) {
                            sizeConflict = false;
                            break;
                        }
                    }
                    if (sizeConflict) {
                        return { hasConflict: true, reason: 'attribute_conflict_size', detail: 'Filter requires ' + kwAttrs.sizes.join('/') + ' but lead specifies ' + leadAttrs.sizes.join('/') };
                    }
                }
                // Form conflict
                for (var c = 0; c < conflictingForms.length; c++) {
                    var pair = conflictingForms[c];
                    if (kwAttrs.forms.indexOf(pair[0]) !== -1 && leadAttrs.forms.indexOf(pair[1]) !== -1) {
                        return { hasConflict: true, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[0] + ' but lead specifies conflicting form ' + pair[1] };
                    }
                    if (kwAttrs.forms.indexOf(pair[1]) !== -1 && leadAttrs.forms.indexOf(pair[0]) !== -1) {
                        return { hasConflict: true, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[1] + ' but lead specifies conflicting form ' + pair[0] };
                    }
                }
                return { hasConflict: false };
            }

            if (matchMode === 'all') {
                for (var j = 0; j < prodKws.length; j++) {
                    var ckItem = compiledList ? compiledList[j] : null;
                    var kwNorm = ckItem ? ckItem.normKw : normalizeText(prodKws[j]);
                    var kwAttrs = ckItem ? ckItem.kwAttrs : null;
                    var conf = checkKwConflict(kwNorm, kwAttrs);
                    if (conf.hasConflict) {
                        return { eligible: false, reason: conf.reason, detail: conf.detail };
                    }
                }
            } else {
                var hasCompatible = false;
                var lastConf = null;
                for (var k = 0; k < prodKws.length; k++) {
                    if (!productMatches(prodKws[k])) continue;
                    var ckItem2 = compiledList ? compiledList[k] : null;
                    var kwNorm2 = ckItem2 ? ckItem2.normKw : normalizeText(prodKws[k]);
                    var kwAttrs2 = ckItem2 ? ckItem2.kwAttrs : null;
                    var c = checkKwConflict(kwNorm2, kwAttrs2);
                    if (!c.hasConflict) {
                        hasCompatible = true;
                        break;
                    } else {
                        lastConf = c;
                    }
                }
                if (!hasCompatible && lastConf) {
                    return { eligible: false, reason: lastConf.reason, detail: lastConf.detail };
                }
            }
        }

        return { eligible: true, reason: null };
    };

    // Stage B: Relevance Scoring (0 - 100)
    LeadMatcher.prototype.computeScore = function (lead, filter, leadContext) {
        var rawProd = lead.productName || '';
        var rawMsg = lead.messageText || lead.queryMessage || lead.description || '';
        var normLead = (leadContext && leadContext.normProd != null) ? leadContext.normProd : normalizeText(rawProd);
        var normCombined = (leadContext && leadContext.normCombined != null) ? leadContext.normCombined : normalizeText((rawProd + ' ' + rawMsg).trim());
        var leadTokens = (leadContext && leadContext.leadTokens != null) ? leadContext.leadTokens : tokenize(normCombined);
        var leadAttrs = (leadContext && leadContext.leadAttrs != null) ? leadContext.leadAttrs : extractAttributes(normCombined);
        var leadTokenSet = (leadContext && leadContext.leadTokenSet != null) ? leadContext.leadTokenSet : null;

        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        if (typeof prodKws === 'string') prodKws = [prodKws];
        if (prodKws.length === 0) {
            // Location-only and other non-product CRM filters are explicitly considered
            // valid by the filter loader. Their other hard constraints have already passed
            // before computeScore() is called, so don't reject them for having no keywords.
            var hasNonProductConstraint = !!(
                (filter.locations && filter.locations.length) ||
                (filter.requiredKeywords && filter.requiredKeywords.length) ||
                (filter.restrictedCountries && filter.restrictedCountries.length) ||
                filter.requireMobile || filter.requireWhatsapp || filter.requireEmail ||
                (filter.minQuantity > 0)
            );
            return {
                score: hasNonProductConstraint ? 60 : 0,
                matchedKeyword: null,
                confidence: hasNonProductConstraint ? 0.6 : 0,
                accepted: hasNonProductConstraint,
                reasons: [hasNonProductConstraint ? 'Non-product CRM constraints matched (+60)' : 'No usable filter criteria']
            };
        }

        var filterAllSizes = filter._allSizes || [];
        if (!filter._allSizes) {
            for (var fIdx = 0; fIdx < prodKws.length; fIdx++) {
                var fAttrs = extractAttributes(normalizeText(prodKws[fIdx]));
                for (var si = 0; si < fAttrs.sizes.length; si++) {
                    if (filterAllSizes.indexOf(fAttrs.sizes[si]) === -1) filterAllSizes.push(fAttrs.sizes[si]);
                }
            }
        }

        var bestScore = 0;
        var bestKw = null;
        var bestReasons = [];
        var totalKeywordsMatched = 0;
        var compiledList = filter._compiledKeywords || null;

        for (var i = 0; i < prodKws.length; i++) {
            var compiled = compiledList ? compiledList[i] : null;
            var rawKw = compiled ? compiled.raw : prodKws[i];
            var normKw = compiled ? compiled.normKw : normalizeText(rawKw);
            var kwTokens = compiled ? compiled.kwTokens : tokenize(normKw);
            var kwAttrs = compiled ? compiled.kwAttrs : extractAttributes(normKw);

            if (kwTokens.length === 0) continue;

            var score = 0;
            var reasons = [];

            // Factor 1: Exact phrase match (+35 points, +15 bonus for full exact match)
            if (wordBoundaryMatch(normLead, normKw) || wordBoundaryMatch(normCombined, normKw)) {
                score += 35;
                reasons.push('exact_phrase_match (+35)');
                if (normLead === normKw) {
                    score += 15;
                    reasons.push('full_exact_match (+15)');
                }
            } else if (wordBoundaryMatch(normLead, normKw) || wordBoundaryMatch(normCombined, normKw)) {
                score += 35;
                reasons.push('word_boundary_match (+35)');
            }

            // Factor 2: Token coverage (+25 max)
            var QUALIFIER_WORDS = {
                'usp': 1, 'bp': 1, 'ip': 1, 'ep': 1, 'jp': 1, 'cp': 1,
                'grade': 1, 'api': 1,
                'personal': 1, 'use': 1, 'commercial': 1, 'industrial': 1,
                'for': 1, 'in': 1, 'and': 1, 'with': 1, 'of': 1, 'the': 1, 'a': 1, 'an': 1,
                'pharma': 1, 'pharmaceutical': 1, 'standard': 1, 'pure': 1, 'bulk': 1
            };
            var substantiveKwTokens = kwTokens.filter(function (t) { return !QUALIFIER_WORDS[t]; });
            var denom = substantiveKwTokens.length > 0 ? substantiveKwTokens : kwTokens;

            var matchedTokensCount = 0;
            for (var t = 0; t < kwTokens.length; t++) {
                var tok = kwTokens[t];
                if (leadTokenSet && leadTokenSet.has(tok)) {
                    matchedTokensCount++;
                } else {
                    var matchedTok = false;
                    for (var lt = 0; lt < leadTokens.length; lt++) {
                        if (tokensEquivalent(leadTokens[lt], tok)) {
                            matchedTok = true;
                            break;
                        }
                    }
                    if (matchedTok) matchedTokensCount++;
                }
            }

            var matchedSubstantiveCount = 0;
            for (var stIdx = 0; stIdx < denom.length; stIdx++) {
                var sTok = denom[stIdx];
                if (leadTokenSet && leadTokenSet.has(sTok)) {
                    matchedSubstantiveCount++;
                } else {
                    for (var lt2 = 0; lt2 < leadTokens.length; lt2++) {
                        if (tokensEquivalent(leadTokens[lt2], sTok)) {
                            matchedSubstantiveCount++;
                            break;
                        }
                    }
                }
            }

            var coverage = matchedTokensCount / kwTokens.length;
            var substantiveCoverage = matchedSubstantiveCount / denom.length;
            var effectiveCoverage = Math.max(coverage, substantiveCoverage);
            var coveragePoints = Math.round(effectiveCoverage * 25);
            score += coveragePoints;
            reasons.push('token_coverage (' + Math.round(effectiveCoverage * 100) + '%: +' + coveragePoints + ')');

            // If all substantive keyword tokens are present or keyword matches text, guarantee acceptance
            if (effectiveCoverage >= 1.0 || (keywordMatchesText(normCombined, normKw) && normCombined.indexOf(normKw) === -1)) {
                score = Math.max(score, 60);
                reasons.push('complete_token_or_substantive_match (+60 minimum)');
            }

            if (effectiveCoverage >= 0.7) totalKeywordsMatched++;

            // Factor 3: Attribute agreement (+15 SPF, +15 strength, +15 size, +10 form)
            if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf === leadAttrs.spf) {
                score += 15;
                reasons.push('spf_agreement (+15)');
            }
            if (kwAttrs.strengths && leadAttrs.strengths && kwAttrs.strengths.length > 0 && leadAttrs.strengths.length > 0) {
                for (var st = 0; st < kwAttrs.strengths.length; st++) {
                    if (leadAttrs.strengths.indexOf(kwAttrs.strengths[st]) !== -1) {
                        score += 15;
                        reasons.push('strength_agreement (+15)');
                        break;
                    }
                }
            }
            if (kwAttrs.sizes.length > 0 && leadAttrs.sizes.length > 0) {
                for (var s = 0; s < kwAttrs.sizes.length; s++) {
                    if (leadAttrs.sizes.indexOf(kwAttrs.sizes[s]) !== -1) {
                        score += 15;
                        reasons.push('size_agreement (+15)');
                        break;
                    }
                }
            }
            if (kwAttrs.forms.length > 0 && leadAttrs.forms.length > 0) {
                for (var f = 0; f < kwAttrs.forms.length; f++) {
                    if (leadAttrs.forms.indexOf(kwAttrs.forms[f]) !== -1) {
                        score += 10;
                        reasons.push('form_agreement (+10)');
                        break;
                    }
                }
            }

            // Factor 4: Synonyms match (+5)
            for (var synKey in SYNONYM_MAP) {
                if (normKw.indexOf(synKey) !== -1) {
                    var syns = SYNONYM_MAP[synKey];
                    for (var synIdx = 0; synIdx < syns.length; synIdx++) {
                        if (normCombined.indexOf(syns[synIdx]) !== -1) {
                            score += 5;
                            reasons.push('synonym_match (' + syns[synIdx] + ': +5)');
                            break;
                        }
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestKw = rawKw;
                bestReasons = reasons;
            }
        }

        // Multi-keyword bonus (+15)
        if (totalKeywordsMatched > 1) {
            bestScore += 15;
            bestReasons.push('multi_keyword_coverage (+15)');
        }

        // Missing size penalty (-15) if filter requires specific size but lead omits it
        if (filterAllSizes.length > 0 && leadAttrs.sizes.length === 0) {
            bestScore -= 15;
            bestReasons.push('missing_filter_size_penalty (-15)');
        }

        bestScore = Math.max(0, Math.min(100, bestScore));

        return {
            score: bestScore,
            matchedKeyword: bestKw,
            confidence: bestScore / 100,
            accepted: bestScore >= this.minConfidenceScore,
            reasons: bestReasons
        };
    };

    LeadMatcher.prototype.evaluate = function (lead, filter, leadContext) {
        var elig = this.checkEligibility(lead, filter, leadContext);
        if (!elig.eligible) {
            return { passed: false, stage: 'A_ELIGIBILITY', reason: elig.reason, detail: elig.detail, score: 0 };
        }
        var scoring = this.computeScore(lead, filter, leadContext);
        if (!scoring.accepted) {
            return { passed: false, stage: 'B_SCORING', reason: 'low_confidence_score', score: scoring.score, confidence: scoring.confidence, reasons: scoring.reasons };
        }
        return {
            passed: true,
            stage: 'ACCEPTED',
            reason: null,
            score: scoring.score,
            confidence: scoring.confidence,
            matchedKeyword: scoring.matchedKeyword,
            reasons: scoring.reasons,
            filterId: filter.id,
            filterName: filter.filter_name || filter.name
        };
    };

    LeadMatcher.prototype.rankCandidates = function (candidates) {
        return candidates.slice().sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            return String(a.filter ? a.filter.id : '').localeCompare(String(b.filter ? b.filter.id : ''));
        });
    };

    // ============================================================
    // KEYWORD MANAGER (v6.3 - GRAVITAS MATCHING & ACTIVE FILTER COUNT)
    // ============================================================
    function KeywordManager() {
        this.logger = new Logger('KeywordManager');
        this.keywords = { product: [], negative: [], location: [], required: [] };
        this._localKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseEnabled = true;
        this.matcher = new LeadMatcher();
        this._activeFilters = [];
        this._filterCompletedBuyers = new Map(); // filterId -> Set of distinct buyerIds
        this._filterInFlight = new Map();        // filterId -> Set of in-flight leadIds
        this._deactivatedFilterIds = new Set();  // filterId -> Set of auto-deactivated filter IDs
        this._reactivationTimers = new Map();    // filterId -> setTimeout timer
        this._deactivationPromises = new Map();
        this._observedInactiveFilters = new Set();
        this._deactivatedMeta = {};              // filterId -> { deactivatedAt, durationMs, filterName }
        this._invertedTokenIndex = Object.create(null); // token -> Array of rule references
        this._wildcardRules = [];                       // rules with no product keywords (location-only)
    }

    KeywordManager.prototype.getBuyerId = function (lead) {
        if (!lead) return null;
        var mobile = (lead.senderMobile || (lead.contact && lead.contact.mobile) || lead.senderPhone || (lead.contact && lead.contact.phone) || '').replace(/\D+/g, '');
        if (mobile && mobile.length >= 7) return 'tel_' + mobile.slice(-10);
        var email = (lead.senderEmail || (lead.contact && lead.contact.email) || '').toLowerCase().trim();
        if (email && email.indexOf('@') !== -1) return 'email_' + email;
        var name = (lead.senderName || (lead.contact && lead.contact.name) || lead.sellerName || '').toLowerCase().trim();
        var loc = (lead.city || lead.state || lead.location || '').toLowerCase().trim();
        if (name) return 'name_' + name + (loc ? '_' + loc : '');
        if (lead.leadId || lead.id || lead.queryId || lead.uniqueId) return 'lead_' + (lead.leadId || lead.id || lead.queryId || lead.uniqueId);
        return null;
    };

    KeywordManager.prototype.getActiveFilterCount = function () {
        var self = this;
        if (this._supabaseEnabled) {
            if (!this._activeFilters || this._activeFilters.length === 0) {
                return 0;
            }
            return this._activeFilters.filter(function (f) {
                if (f.isActive === false || f.is_active === false || f.deleted_at || f.is_deleted) return false;
                if (self._deactivatedFilterIds && self._deactivatedFilterIds.has(String(f.id))) return false;
                var buyers = self._filterCompletedBuyers.get(f.id) || self._filterCompletedBuyers.get(String(f.id));
                var count = buyers ? buyers.size : 0;
                var target = 10;
                if (typeof f.targetQuantity === 'number' && f.targetQuantity > 0) {
                    target = f.targetQuantity;
                } else if (typeof f.target_lead_count === 'number' && f.target_lead_count > 0) {
                    target = f.target_lead_count;
                } else if (f.filter_config && typeof f.filter_config.target_quantity === 'number' && f.filter_config.target_quantity > 0) {
                    target = f.filter_config.target_quantity;
                } else if (f.filter_config && typeof f.filter_config.target_lead_count === 'number' && f.filter_config.target_lead_count > 0) {
                    target = f.filter_config.target_lead_count;
                }
                return count < target;
            }).length;
        }
        if (this._localKeywords && this._localKeywords.product && this._localKeywords.product.length > 0) {
            return this._localKeywords.product.length;
        }
        return this._localKeywords && this._localKeywords.required && this._localKeywords.required.length ? 1 : 0;
    };

    KeywordManager.prototype.isFilterEligible = function (filterId) {
        if (!filterId) return false;
        var self = this;
        if (this._deactivatedFilterIds && this._deactivatedFilterIds.has(String(filterId))) return false;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                var f = this._activeFilters[i];
                if (String(f.id) === String(filterId)) {
                    if (f.isActive === false || f.is_active === false || f.deleted_at || f.is_deleted) return false;
                    var buyers = self._filterCompletedBuyers.get(f.id) || self._filterCompletedBuyers.get(String(f.id));
                    var count = buyers ? buyers.size : 0;
                    var target = 10;
                    if (typeof f.targetQuantity === 'number' && f.targetQuantity > 0) {
                        target = f.targetQuantity;
                    } else if (typeof f.target_lead_count === 'number' && f.target_lead_count > 0) {
                        target = f.target_lead_count;
                    } else if (f.filter_config && typeof f.filter_config.target_quantity === 'number' && f.filter_config.target_quantity > 0) {
                        target = f.filter_config.target_quantity;
                    } else if (f.filter_config && typeof f.filter_config.target_lead_count === 'number' && f.filter_config.target_lead_count > 0) {
                        target = f.filter_config.target_lead_count;
                    }
                    return count < target;
                }
            }
        }
        return false;
    };

    KeywordManager.prototype.reserveSlot = function (filterId, leadId) {
        if (!filterId || !leadId) return;
        var fKey = String(filterId);
        if (!this._filterInFlight.has(fKey)) {
            this._filterInFlight.set(fKey, new Set());
        }
        this._filterInFlight.get(fKey).add(leadId);
    };

    KeywordManager.prototype.releaseReservation = function (filterId, leadId) {
        if (!filterId || !leadId) return;
        var fKey = String(filterId);
        if (this._filterInFlight.has(fKey)) {
            this._filterInFlight.get(fKey).delete(leadId);
        }
    };

    KeywordManager.prototype.recordFilterSuccess = function (filterId, lead) {
        if (!filterId) return;
        var buyerId = this.getBuyerId(lead);
        var fKey = String(filterId);
        if (!this._filterCompletedBuyers.has(fKey)) {
            this._filterCompletedBuyers.set(fKey, new Set());
        }
        if (buyerId) {
            this._filterCompletedBuyers.get(fKey).add(buyerId);
        }
        this.releaseReservation(filterId, lead ? (lead.leadId || lead.id) : null);

        // Check if unique sellers quota (10 leads) has been reached
        var target = 10;
        var targetRule = null;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                if (String(this._activeFilters[i].id) === fKey) {
                    targetRule = this._activeFilters[i];
                    break;
                }
            }
        }
        if (targetRule) {
            if (typeof targetRule.targetQuantity === 'number' && targetRule.targetQuantity > 0) {
                target = targetRule.targetQuantity;
            } else if (typeof targetRule.target_lead_count === 'number' && targetRule.target_lead_count > 0) {
                target = targetRule.target_lead_count;
            } else if (targetRule.filter_config && typeof targetRule.filter_config.target_quantity === 'number' && targetRule.filter_config.target_quantity > 0) {
                target = targetRule.filter_config.target_quantity;
            } else if (targetRule.filter_config && typeof targetRule.filter_config.target_lead_count === 'number' && targetRule.filter_config.target_lead_count > 0) {
                target = targetRule.filter_config.target_lead_count;
            }
        }

        var completedBuyers = this._filterCompletedBuyers.get(fKey);
        var count = completedBuyers ? completedBuyers.size : 0;
        if (count >= target) {
            if (!this._deactivatedFilterIds) this._deactivatedFilterIds = new Set();
            this._deactivatedFilterIds.add(fKey);
            this._observedInactiveFilters.delete(fKey);
            if (targetRule) {
                targetRule.isActive = false;
                targetRule.is_active = false;
                if (targetRule.rawFilter) {
                    targetRule.rawFilter.is_active = false;
                }
            }

            var filterName = (targetRule && (targetRule.name || targetRule.filter_name)) || ('Filter #' + fKey);

            // 1. Structured Logging
            this.logger.info('filter.limit.reached', {
                filterId: fKey,
                filterName: filterName,
                count: count,
                target: target,
                message: 'Limit reached for filter "' + filterName + '" (' + count + '/' + target + ' unique seller leads).'
            });
            this.logger.info('filter.deactivated', {
                filterId: fKey,
                filterName: filterName,
                durationSeconds: 15,
                message: 'Filter "' + filterName + '" deactivated for 15 seconds.'
            });

            // 2. Toast Prompts: Limit Reached & Filter Deactivated
            if (this.orchestrator && typeof this.orchestrator.showTopToast === 'function') {
                this.orchestrator.showTopToast('warning', 'Limit Reached', 'Filter "' + filterName + '" reached ' + target + ' leads limit', 3500);
                var orch = this.orchestrator;
                setTimeout(function () {
                    orch.showTopToast('failed', 'Filter Deactivated', 'Filter "' + filterName + '" deactivated for 15s', 4000);
                }, 400);
            }

            // Preserve the existing 15-second quota cooldown, but never undo a CRM edit.
            this._scheduleAutoReactivation(fKey, filterName, 15000);
            if (this.orchestrator && this.orchestrator.supabase && typeof this.orchestrator.supabase.deactivateFilter === 'function') {
                var self = this, quotaMeta = this._deactivatedMeta[fKey];
                var pending = Promise.resolve(this.orchestrator.supabase.deactivateFilter(filterId)).then(function (result) {
                    if (result && result.updatedAt && self._deactivatedMeta[fKey] === quotaMeta) {
                        self._deactivatedMeta[fKey].deactivationVersion = result.updatedAt;
                        self._persistCompletedBuyers();
                    }
                }).catch(function (err) { self.logger.warn('Filter deactivation pending', { error: err.message }); }).finally(function () { if (self._deactivationPromises.get(fKey) === pending) self._deactivationPromises.delete(fKey); });
                this._deactivationPromises.set(fKey, pending);
            }
        }

        this._persistCompletedBuyers();
        if (this.orchestrator && typeof this.orchestrator._updateScannerLifecycleState === 'function') {
            this.orchestrator._updateScannerLifecycleState('filter_completed');
        }
    };

    KeywordManager.prototype._scheduleAutoReactivation = function (filterId, filterName, delayMs) {
        var self = this;
        var fKey = String(filterId);
        var delay = (typeof delayMs === 'number' && delayMs > 0) ? delayMs : 15000;

        if (!this._reactivationTimers) this._reactivationTimers = new Map();
        if (this._reactivationTimers.has(fKey)) {
            clearTimeout(this._reactivationTimers.get(fKey));
        }

        if (!this._deactivatedMeta) this._deactivatedMeta = {};
        this._deactivatedMeta[fKey] = Object.assign({}, this._deactivatedMeta[fKey], {
            deactivatedAt: Date.now(),
            durationMs: delay,
            filterName: filterName || ('Filter #' + fKey)
        });
        this._persistCompletedBuyers();

        var timer = setTimeout(function () {
            self.reactivateFilter(fKey, '15s_timer_elapsed');
        }, delay);

        this._reactivationTimers.set(fKey, timer);
    };

    KeywordManager.prototype.reactivateFilter = function (filterId, reason) {
        if (!filterId) return Promise.resolve(false);
        var self = this;
        var fKey = String(filterId);
        if (reason === 'manual_user_reactivation') {
            this._finishFilterReactivation(fKey, reason);
            return Promise.resolve(true);
        }
        var meta = this._deactivatedMeta[fKey] || {};
        var supabase = this.orchestrator && this.orchestrator.supabase;
        return Promise.resolve(this._deactivationPromises.get(fKey)).then(function () {
            if (!supabase) return false;
            return supabase.reactivateFilter(filterId, meta.deactivationVersion);
        }).then(function (acknowledged) {
            if (!self._deactivatedFilterIds.has(fKey) || self._deactivatedMeta[fKey] !== meta) return false;
            if (!acknowledged) {
                self._observedInactiveFilters.add(fKey);
                self.logger.warn('Filter remains inactive; CRM change or unacknowledged write', { filterId: fKey });
                return false;
            }
            self._finishFilterReactivation(fKey, reason);
            if (self.orchestrator) self.orchestrator._checkDynamicFilterChanges(true);
            return true;
        }).catch(function (err) { self.logger.warn('Filter reactivation failed', { error: err.message }); return false; });
    };

    KeywordManager.prototype._finishFilterReactivation = function (filterId, reason) {
        var fKey = String(filterId);
        // Clear any pending timer
        if (this._reactivationTimers && this._reactivationTimers.has(fKey)) {
            clearTimeout(this._reactivationTimers.get(fKey));
            this._reactivationTimers.delete(fKey);
        }

        // Remove from deactivated tracking
        if (this._deactivatedFilterIds) {
            this._deactivatedFilterIds.delete(fKey);
        }
        var metaName = null;
        if (this._deactivatedMeta && this._deactivatedMeta[fKey]) {
            metaName = this._deactivatedMeta[fKey].filterName;
            delete this._deactivatedMeta[fKey];
        }

        // Reset completed buyers quota so it can acquire 10 new unique leads!
        this._filterCompletedBuyers.delete(fKey);

        // Find the rule and mark isActive = true
        var targetRule = null;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                if (String(this._activeFilters[i].id) === fKey) {
                    targetRule = this._activeFilters[i];
                    break;
                }
            }
        }
        if (targetRule) {
            targetRule.isActive = true;
            targetRule.is_active = true;
            if (targetRule.rawFilter) {
                targetRule.rawFilter.is_active = true;
            }
        }

        var filterName = metaName || (targetRule && (targetRule.name || targetRule.filter_name)) || ('Filter #' + fKey);

        // Structured logging
        this.logger.info('filter.reactivated', {
            filterId: fKey,
            filterName: filterName,
            reason: reason || 'auto_reactivation',
            message: 'Filter "' + filterName + '" reactivated. Quota reset for next 10 unique sellers.'
        });

        // Toast prompt: Filter Reactivated
        if (this.orchestrator && typeof this.orchestrator.showTopToast === 'function') {
            this.orchestrator.showTopToast('reactivated', 'Filter Reactivated', 'Filter "' + filterName + '" reactivated', 4000);
        }

        this._observedInactiveFilters.delete(fKey);

        this._persistCompletedBuyers();

        // Update scanner state so scanning resumes if it was paused/idle
        if (this.orchestrator && typeof this.orchestrator._updateScannerLifecycleState === 'function') {
            this.orchestrator._updateScannerLifecycleState('filter_reactivated');
        }
    };

    KeywordManager.prototype._persistCompletedBuyers = function () {
        var out = {};
        this._filterCompletedBuyers.forEach(function (buyerSet, fId) {
            out[fId] = Array.from(buyerSet);
        });
        var deact = this._deactivatedFilterIds ? Array.from(this._deactivatedFilterIds) : [];
        var meta = this._deactivatedMeta || {};
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ 
                    filterCompletedBuyers: out,
                    deactivatedFilterIds: deact,
                    deactivatedFilterMeta: meta
                });
            }
        } catch (e) { }
    };

    KeywordManager.prototype.setSupabaseEnabled = function (enabled) {
        this._supabaseEnabled = enabled;
        this._rebuildKeywords();
    };

    KeywordManager.prototype._normalize = function (text) {
        return normalizeText(text);
    };

    KeywordManager.prototype._textMatches = function (text, keyword) {
        return wordBoundaryMatch(normalizeText(text), normalizeText(keyword));
    };

    KeywordManager.prototype.loadKeywords = function () {
        var self = this;
        return new Promise(function (resolve) {
            chrome.storage.local.get(['keywords', 'supabaseEnabled', 'filterCompletedBuyers', 'deactivatedFilterIds', 'deactivatedFilterMeta', 'cached_filters_v1', 'supabase_filters_cache'], function (result) {
                if (result && result.filterCompletedBuyers) {
                    try {
                        for (var fId in result.filterCompletedBuyers) {
                            if (Array.isArray(result.filterCompletedBuyers[fId])) {
                                self._filterCompletedBuyers.set(fId, new Set(result.filterCompletedBuyers[fId]));
                            }
                        }
                    } catch (e) { }
                }
                if (result && Array.isArray(result.deactivatedFilterIds)) {
                    self._deactivatedFilterIds = new Set(result.deactivatedFilterIds.map(String));
                }
                if (result && result.deactivatedFilterMeta && typeof result.deactivatedFilterMeta === 'object') {
                    self._deactivatedMeta = result.deactivatedFilterMeta;
                    var now = Date.now();
                    for (var dId in self._deactivatedMeta) {
                        var m = self._deactivatedMeta[dId];
                        var elapsed = now - (m.deactivatedAt || 0);
                        var remaining = (m.durationMs || 15000) - elapsed;
                        if (remaining <= 0) {
                            self.reactivateFilter(dId, '15s_timer_elapsed_post_reload');
                        } else {
                            self._scheduleAutoReactivation(dId, m.filterName, remaining);
                        }
                    }
                }
                self._localKeywords = {
                    product: (result.keywords && result.keywords.product) || [],
                    negative: (result.keywords && result.keywords.negative) || [],
                    location: (result.keywords && result.keywords.location) || [],
                    required: (result.keywords && result.keywords.required) || []
                };
                self._supabaseEnabled = result.supabaseEnabled !== false;

                self._rebuildKeywords();

                self.logger.info('Local keywords loaded', {
                    product: self._localKeywords.product.length,
                    activeFilters: self.getActiveFilterCount(),
                    supabaseEnabled: self._supabaseEnabled
                });
                resolve(self.keywords);
            });
        });
    };

    KeywordManager.prototype.extractFromSupabaseFilters = function (filters) {
        this._activeFilters = [];
        if (!filters || filters.length === 0) {
            this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
            this._rebuildKeywords();
            this.logger.info('📥 No active filters');
            return;
        }

        var INDIAN_STATES = {
            'andhra pradesh': 1, 'arunachal pradesh': 1, 'assam': 1, 'bihar': 1, 'chhattisgarh': 1,
            'goa': 1, 'gujarat': 1, 'haryana': 1, 'himachal pradesh': 1, 'jharkhand': 1, 'karnataka': 1,
            'kerala': 1, 'madhya pradesh': 1, 'maharashtra': 1, 'manipur': 1, 'meghalaya': 1,
            'mizoram': 1, 'nagaland': 1, 'odisha': 1, 'orissa': 1, 'punjab': 1, 'rajasthan': 1,
            'sikkim': 1, 'tamil nadu': 1, 'telangana': 1, 'tripura': 1, 'uttar pradesh': 1,
            'uttarakhand': 1, 'uttaranchal': 1, 'west bengal': 1, 'delhi': 1, 'new delhi': 1,
            'jammu and kashmir': 1, 'jammu kashmir': 1, 'ladakh': 1, 'chandigarh': 1,
            'puducherry': 1, 'pondicherry': 1, 'andaman and nicobar islands': 1, 'lakshadweep': 1,
            'dadra and nagar haveli': 1, 'daman and diu': 1
        };

        function normForMatch(t) {
            return normalizeText(t);
        }

        var rules = [];
        for (var i = 0; i < filters.length; i++) {
            var f = filters[i];
            var fIdStr = String(f.id);

            // Manual reactivation detection:
            // If this filter was previously auto-deactivated upon reaching quota (10 unique sellers),
            // and has now been manually turned back on (is_active !== false in Supabase/CRM),
            // unblock it by resetting its completed buyers set and removing from deactivated IDs.
            if (this._deactivatedFilterIds && this._deactivatedFilterIds.has(fIdStr)) {
                if (f.is_active === true && this._observedInactiveFilters && this._observedInactiveFilters.has(fIdStr) && !f.deleted_at && !f.is_deleted) {
                    this.reactivateFilter(fIdStr, 'manual_user_reactivation');
                }
            }

            var cfg = f.filter_config || {};
            var uniqNorm = function (arr) {
                var seen = {}, out = [];
                if (!Array.isArray(arr)) return out;
                for (var x = 0; x < arr.length; x++) {
                    if (typeof arr[x] !== 'string') continue;
                    var pieces = arr[x].replace(/,\s*(?=\d+(?:\.\d+)?\s*(?:g|gm|gms|grams?|kg|ml|l|mg|mcg|tabs?|tablets?|caps?|capsules?|pcs?|pieces?|boxes?|strips?|vials?|bottles?|packs?)\b)/gi, ' ').split(/[,;\n\r]+/);
                    for (var pi = 0; pi < pieces.length; pi++) {
                        var v = normForMatch(pieces[pi]);
                        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
                    }
                }
                return out;
            };

            function collectFields(objects, names) {
                var out = [];
                for (var oi = 0; oi < objects.length; oi++) {
                    var obj = objects[oi] || {};
                    for (var ni = 0; ni < names.length; ni++) {
                        var value = obj[names[ni]];
                        if (Array.isArray(value)) {
                            for (var ai = 0; ai < value.length; ai++) {
                                if (typeof value[ai] === 'string') {
                                    var splits = value[ai].replace(/,\s*(?=\d+(?:\.\d+)?\s*(?:g|gm|gms|grams?|kg|ml|l|mg|mcg|tabs?|tablets?|caps?|capsules?|pcs?|pieces?|boxes?|strips?|vials?|bottles?|packs?)\b)/gi, ' ').split(/[,;\n\r]+/);
                                    for (var spi = 0; spi < splits.length; spi++) {
                                        var spTrim = splits[spi].trim();
                                        if (spTrim) out.push(spTrim);
                                    }
                                } else if (value[ai] != null) {
                                    out.push(String(value[ai]));
                                }
                            }
                        } else if (typeof value === 'string' && value.trim()) {
                            var splitsStr = value.replace(/,\s*(?=\d+(?:\.\d+)?\s*(?:g|gm|gms|grams?|kg|ml|l|mg|mcg|tabs?|tablets?|caps?|capsules?|pcs?|pieces?|boxes?|strips?|vials?|bottles?|packs?)\b)/gi, ' ').split(/[,;\n\r]+/);
                            for (var si = 0; si < splitsStr.length; si++) {
                                var sTrim = splitsStr[si].trim();
                                if (sTrim) out.push(sTrim);
                            }
                        }
                    }
                }
                return out;
            }
            function ruleValue(names, fallback) {
                for (var oi = 0; oi < 2; oi++) {
                    var obj = oi === 0 ? f : cfg;
                    for (var ni = 0; ni < names.length; ni++) if (Object.prototype.hasOwnProperty.call(obj, names[ni]) && obj[names[ni]] != null) return obj[names[ni]];
                }
                return fallback;
            }
            function ruleFields(names) {
                var useModern = names.some(function (name) { return Object.prototype.hasOwnProperty.call(f, name) && f[name] != null; });
                return collectFields(useModern ? [f] : [cfg], names);
            }
            function ruleFlag(names, fallback) { return Core.available(ruleValue(names, fallback)); }
            var prodNames = collectFields(f.product_keywords != null ? [f] : [cfg, f], [
                'product_names', 'productNames', 'product_keywords', 'productKeywords', 'keywords',
                'product_name', 'productName', 'products'
            ]);
            var negNames = collectFields(f.negative_keywords != null ? [f] : [cfg, f], ['negative_keywords', 'negativeKeywords', 'excluded_keywords', 'exclude_keywords', 'excludedKeywords']);
            var reqNames = collectFields(f.required_keywords != null ? [f] : [cfg, f], ['required_keywords', 'requiredKeywords', 'must_have_keywords', 'mustHaveKeywords']);
            var locNames = ruleFields(['locations', 'location', 'sender_locations', 'senderLocations', 'location_keywords', 'regions', 'region'])
                .concat(ruleFields(['countries', 'country', 'country_name', 'allowed_countries', 'allowedCountries']))
                .concat(ruleFields(['states', 'state', 'state_name']))
                .concat(ruleFields(['cities', 'city', 'city_name']));
            var restCountries = ruleFields(['restricted_countries', 'restrictedCountries']);

            var normKeywords = uniqNorm(prodNames);
            var isFilterValid = normKeywords.length > 0 || locNames.length > 0 || reqNames.length > 0;
            var isDeleted = !!f.deleted_at || f.is_deleted === true;

            var compiledKeywords = [];
            var compiledSizes = [];
            for (var cki = 0; cki < normKeywords.length; cki++) {
                var cNorm = normKeywords[cki];
                var cToks = tokenize(cNorm);
                var cAttrs = extractAttributes(cNorm);
                var cSub = cToks.filter(function (t) { return !QUALIFIER_WORDS[t]; });
                compiledKeywords.push({
                    raw: prodNames[cki] || cNorm,
                    normKw: cNorm,
                    kwTokens: cToks,
                    kwAttrs: cAttrs,
                    substantiveKwTokens: cSub.length > 0 ? cSub : cToks
                });
                for (var csi = 0; csi < cAttrs.sizes.length; csi++) {
                    if (compiledSizes.indexOf(cAttrs.sizes[csi]) === -1) compiledSizes.push(cAttrs.sizes[csi]);
                }
            }
            var rawNegNames = uniqNorm(negNames);
            var compiledNegatives = [];
            for (var cni = 0; cni < rawNegNames.length; cni++) {
                compiledNegatives.push(normalizeText(rawNegNames[cni]));
            }

            // Extract contact requirements from all schema variations (boolean flags, arrays, strings)
            var contactFields = ruleFields([
                'contact_details', 'contactDetails', 'contact_types', 'contactTypes',
                'contact_channels', 'contactChannels', 'required_contacts', 'requiredContacts',
                'allowed_contacts', 'allowedContacts', 'contacts', 'contact'
            ]);
            var cDetailStr = contactFields.join(' ').toLowerCase();
            var hasContactPhone = cDetailStr.indexOf('phone') !== -1 || cDetailStr.indexOf('mobile') !== -1 || cDetailStr.indexOf('call') !== -1;
            var hasContactWhatsapp = cDetailStr.indexOf('whatsapp') !== -1;
            var hasContactEmail = cDetailStr.indexOf('email') !== -1 || cDetailStr.indexOf('mail') !== -1;
            var hasContactAny = cDetailStr.indexOf('any') !== -1;

            var countryNames = ruleFields([
                'countries', 'country', 'allowed_countries', 'allowedCountries',
                'sender_countries', 'senderCountries'
            ]);

            isFilterValid = isFilterValid || contactFields.length > 0 || cfg.require_contact === true || f.require_contact === true || cfg.require_email === true || f.require_email === true || cfg.require_mobile === true || f.require_mobile === true || cfg.require_whatsapp === true || f.require_whatsapp === true;
            rules.push({
                id: f.id,
                name: f.filter_name || f.name || ('filter_' + f.id),
                keywords: normKeywords,
                _compiledKeywords: compiledKeywords,
                _compiledNegatives: compiledNegatives,
                _allSizes: compiledSizes,
                matchMode: (String(ruleValue(['match_mode', 'matchMode'], 'any')).toLowerCase() === 'all') ? 'all' : 'any',
                negativeKeywords: uniqNorm(negNames),
                requiredKeywords: uniqNorm(reqNames),
                locations: uniqNorm(locNames),
                countries: uniqNorm(countryNames),
                restrictedCountries: uniqNorm(restCountries),
                rejectUnknownCountry: ruleFlag(['reject_unknown_country', 'rejectUnknownCountry'], false),
                requireMobile: ruleFlag(['require_mobile', 'require_phone', 'requireMobile', 'requirePhone'], hasContactPhone),
                requireWhatsapp: ruleFlag(['require_whatsapp', 'requireWhatsapp'], hasContactWhatsapp),
                requireEmail: ruleFlag(['require_email', 'requireEmail'], hasContactEmail),
                requireContact: ruleFlag(['require_contact', 'requireContact'], hasContactAny),
                quantityUnit: String(ruleValue(['quantity_unit', 'quantityUnit'], '')).toLowerCase().trim(),
                minQuantity: Math.max(0, Number(ruleValue(['min_quantity', 'minQuantity'], 0)) || 0),
                targetQuantity: Math.max(1, Number(ruleValue(['target_lead_count', 'target_quantity', 'targetQuantity'], 10)) || 10),
                isActive: f.is_active !== false && !isDeleted && isFilterValid && !(this._deactivatedFilterIds && this._deactivatedFilterIds.has(fIdStr)),
                rawFilter: f,
                _indianStates: INDIAN_STATES
            });
        }
        this._activeFilters = rules;

        // Keep flat lists for backward compatibility and status text
        var product = [], negative = [], location = [], required = [];
        var addUnique = function (arr, item) {
            if (!item || typeof item !== 'string') return;
            var pieces = item.split(/[,;\n\r]+/);
            for (var pi = 0; pi < pieces.length; pi++) {
                var lower = pieces[pi].toLowerCase().trim();
                if (lower && arr.indexOf(lower) === -1) arr.push(lower);
            }
        };
        rules.forEach(function (rule) {
            rule.keywords.forEach(function (v) { addUnique(product, v); });
            rule.negativeKeywords.forEach(function (v) { addUnique(negative, v); });
            rule.requiredKeywords.forEach(function (v) { addUnique(required, v); });
            rule.locations.forEach(function (v) { addUnique(location, v); });
        });
        this._supabaseKeywords = { product: product, negative: negative, location: location, required: required };
        this._rebuildKeywords();
        this._compileInvertedIndex();
        this.logger.info('📥 Supabase filters built', { rules: rules.length, product: product.length, activeCount: this.getActiveFilterCount() });
    };

    // Aho-Corasick Multi-Pattern Inverted Index Compilation (O(M) Fast Token Lookup)
    KeywordManager.prototype._compileInvertedIndex = function () {
        var index = Object.create(null);
        var wildcards = [];
        var rules = this._activeFilters || [];

        function addToken(tok, rule) {
            if (!tok || typeof tok !== 'string') return;
            var t = tok.toLowerCase().trim();
            if (!t || t.length === 0) return;
            if (!index[t]) index[t] = [];
            if (index[t].indexOf(rule) === -1) index[t].push(rule);

            // Morphological variations & plurals (s, es, ies <-> y)
            if (t.length > 3) {
                if (t.slice(-3) === 'ies') {
                    var yStem = t.slice(0, -3) + 'y';
                    if (!index[yStem]) index[yStem] = [];
                    if (index[yStem].indexOf(rule) === -1) index[yStem].push(rule);
                } else if (t.slice(-1) === 'y') {
                    var iesPlur = t.slice(0, -1) + 'ies';
                    if (!index[iesPlur]) index[iesPlur] = [];
                    if (index[iesPlur].indexOf(rule) === -1) index[iesPlur].push(rule);
                }
                if (t.slice(-2) === 'es') {
                    var baseEs = t.slice(0, -2);
                    if (!index[baseEs]) index[baseEs] = [];
                    if (index[baseEs].indexOf(rule) === -1) index[baseEs].push(rule);
                }
                if (t.slice(-1) === 's') {
                    var sing = t.slice(0, -1);
                    if (!index[sing]) index[sing] = [];
                    if (index[sing].indexOf(rule) === -1) index[sing].push(rule);
                } else {
                    var plur = t + 's';
                    if (!index[plur]) index[plur] = [];
                    if (index[plur].indexOf(rule) === -1) index[plur].push(rule);
                }
            }
        }

        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            var rawKws = r.keywords || r.product_keywords || r.productKeywords || (r.filter_config && (r.filter_config.product_names || r.filter_config.product_keywords)) || [];
            if (typeof rawKws === 'string') rawKws = [rawKws];
            var kws = rawKws.slice();
            var reqKws = r.requiredKeywords || r.required_keywords || (r.filter_config && (r.filter_config.required_keywords || r.filter_config.requiredKeywords)) || [];
            if (typeof reqKws === 'string') reqKws = [reqKws];
            // Required terms cannot replace the product hard gate. Index them only for
            // required-only rules; a common word such as 'bulk' must not fan out to every drug.
            if (!kws.length) kws = reqKws.slice();
            if (!kws || kws.length === 0) {
                wildcards.push(r);
                continue;
            }
            for (var k = 0; k < kws.length; k++) {
                var normKw = normalizeText(kws[k]);
                var tokens = tokenize(normKw).filter(function (token) {
                    return !QUALIFIER_WORDS[token] && !/^(?:\d|spf\d)/.test(token) && !/^(?:tabs?|tablets?|caps?|capsules?|injs?|injections?|syrs?|syrups?|creams?|gels?|lotions?|powders?|liquids?|solutions?|ointments?|bottles?|vials?|strips?|packs?|pieces?|pcs?)$/.test(token);
                });
                // An intentionally generic keyword remains a wildcard candidate, so this
                // optimization changes candidate cost, never matching semantics.
                if (!tokens.length) { if (wildcards.indexOf(r) === -1) wildcards.push(r); continue; }
                for (var ti = 0; ti < tokens.length; ti++) {
                    var tk = tokens[ti];
                    addToken(tk, r);
                    if (typeof SYNONYM_MAP !== 'undefined' && SYNONYM_MAP && SYNONYM_MAP[tk]) {
                        var synList = SYNONYM_MAP[tk];
                        for (var si = 0; si < synList.length; si++) {
                            var synToks = tokenize(normalizeText(synList[si]));
                            for (var st = 0; st < synToks.length; st++) {
                                addToken(synToks[st], r);
                            }
                        }
                    }
                }
            }
        }
        this._invertedTokenIndex = index;
        this._wildcardRules = wildcards;
        this._invertedRulesCount = rules.length;
        this._hasIndexedTokens = Object.keys(index).length > 0;
    };

    KeywordManager.prototype._rebuildKeywords = function () {
        if (this._supabaseEnabled && (
            this._supabaseKeywords.product.length > 0 ||
            this._supabaseKeywords.negative.length > 0 ||
            this._supabaseKeywords.required.length > 0)) {
            this.keywords = {
                product: this._supabaseKeywords.product.slice(),
                negative: this._supabaseKeywords.negative.slice(),
                location: this._supabaseKeywords.location.slice(),
                required: this._supabaseKeywords.required.slice()
            };
        } else {
            this.keywords = {
                product: this._localKeywords.product.slice(),
                negative: this._localKeywords.negative.slice(),
                location: this._localKeywords.location.slice(),
                required: this._localKeywords.required.slice()
            };
        }
    };

    KeywordManager.prototype.updateKeywords = function (newKeywords) {
        var self = this;
        return new Promise(function (resolve) {
            for (var k in newKeywords) {
                if (newKeywords.hasOwnProperty(k) && self._localKeywords.hasOwnProperty(k)) {
                    self._localKeywords[k] = newKeywords[k];
                }
            }
            chrome.storage.local.set({ keywords: self._localKeywords }, function () {
                self._rebuildKeywords();
                resolve(true);
            });
        });
    };

    // Evaluates a candidate lead against all active filters with Stage A eligibility & Stage B candidate ranking
    KeywordManager.prototype.evaluateFilters = function (lead) {
        var self = this;
        var rules = this._activeFilters || [];
        var activeRules = rules.filter(function (r) { return r.isActive !== false; });
        if (activeRules.length === 0) {
            return { passed: false, reason: 'no_active_filter', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
        }

        var contact = lead.contact || {};
        // Robust lead Country ISO extraction: resolves from countryIso, senderCountryIso, lead.country, and lead.location
        var leadCountryIso = Core.countryFromLead(lead);

        var locParts = [];
        if (lead.city) locParts.push(normalizeText(lead.city));
        if (lead.state) locParts.push(normalizeText(lead.state));
        if (lead.location) locParts.push(normalizeText(lead.location));
        if (leadCountryIso) {
            locParts.push(leadCountryIso.toLowerCase());
            if (leadCountryIso === 'IN') {
                locParts.push('india');
            } else {
                locParts.push('foreign', 'international', 'export', 'overseas');
            }
        }
        if (lead.country) locParts.push(normalizeText(lead.country));

        // Location & Countries Filter: Evaluates on strict OR logic.
        // If multiple countries are specified (e.g. USA, UK, Australia), a lead from ANY
        // of these countries matches and qualifies.
        function locationMatches(rule) {
            var rawLocs = rule.locations || (rule.filter_config && (rule.filter_config.locations || rule.filter_config.sender_locations || rule.filter_config.countries)) || rule.sender_locations || [];
            var countries = rule.countries || (rule.filter_config && rule.filter_config.countries) || [];
            if (typeof countries === 'string') countries = [countries];
            if (typeof rawLocs === 'string') rawLocs = [rawLocs];
            if (rule.rejectUnknownCountry && !leadCountryIso) return false;
            // An explicit country constraint cannot be bypassed by a matching city/state.
            if (countries.length && !countries.some(function (c) { return Core.country(String(c)) === leadCountryIso && !!leadCountryIso; })) return false;
            if (!rawLocs.length) return true;
            var geographic = countries.length ? rawLocs.filter(function (l) { return !Core.country(String(l)); }) : rawLocs;
            if (!geographic.length) return true;
            return geographic.some(function (entry) {
                entry = String(entry).toLowerCase().trim();
                var iso = Core.country(entry);
                if (iso) return !!leadCountryIso && iso === leadCountryIso;
                if (/^(foreign|international|export|overseas)$/.test(entry)) return !!leadCountryIso && leadCountryIso !== 'IN';
                return locParts.some(function (part) { return part === entry || wordBoundaryMatch(part, normalizeText(entry)); });
            });
        }

        var candidateMatches = [];
        var buyerId = self.getBuyerId(lead);
        // Diagnostics: how many filters were rejected at each stage (no keywords/PII logged).
        var stageCounts = {};
        var nearMiss = null;
        function reject(stage) { stageCounts[stage] = (stageCounts[stage] || 0) + 1; }

        // Fast O(M) Candidate Pre-Filtering via Inverted Token Index
        var firstId = rules[0] ? rules[0].id : null;
        if (!this._invertedTokenIndex || this._lastActiveFiltersRef !== rules || this._invertedRulesCount !== rules.length || this._firstRuleId !== firstId) {
            this._compileInvertedIndex();
            this._lastActiveFiltersRef = rules;
            this._firstRuleId = firstId;
        }
        var normProd = normalizeText(lead.productName || '');
        var normMcat = normalizeText(lead.mcatName || lead.queryMcatName || lead.category || '');
        var normMsg = normalizeText(lead.messageText || lead.queryMessage || lead.description || '');
        var normCombined = (normProd + (normMsg ? ' ' + normMsg : '')).trim();
        var leadTokens = tokenize(normCombined);
        var leadAttrs = extractAttributes(normCombined);
        var leadTokenSet = new Set(leadTokens);
        var leadContext = {
            normProd: normProd,
            normMcat: normMcat,
            normMsg: normMsg,
            normCombined: normCombined,
            leadTokens: leadTokens,
            leadAttrs: leadAttrs,
            leadTokenSet: leadTokenSet
        };

        var candidateRules = [];
        if (this._invertedTokenIndex && this._hasIndexedTokens) {
            var seenRuleIds = Object.create(null);

            // 1. Wildcard / non-keyword rules (location-only, etc.) are always candidates
            var wildcards = this._wildcardRules || [];
            for (var w = 0; w < wildcards.length; w++) {
                var wr = wildcards[w];
                if (wr && wr.isActive !== false && !seenRuleIds[wr.id]) {
                    seenRuleIds[wr.id] = true;
                    candidateRules.push(wr);
                }
            }

            // 2. O(M) inverted index dictionary lookup for words and stems in lead
            for (var m = 0; m < leadTokens.length; m++) {
                var lTok = leadTokens[m];
                var matched = this._invertedTokenIndex[lTok];
                if (matched) {
                    for (var rIdx = 0; rIdx < matched.length; rIdx++) {
                        var cRule = matched[rIdx];
                        if (cRule && cRule.isActive !== false && !seenRuleIds[cRule.id]) {
                            seenRuleIds[cRule.id] = true;
                            candidateRules.push(cRule);
                        }
                    }
                }
                if (lTok.length > 3) {
                    var sTok = null;
                    if (lTok.slice(-3) === 'ies') sTok = lTok.slice(0, -3) + 'y';
                    else if (lTok.slice(-2) === 'es') sTok = lTok.slice(0, -2);
                    else if (lTok.slice(-1) === 's') sTok = lTok.slice(0, -1);
                    if (sTok && this._invertedTokenIndex[sTok]) {
                        var sMatched = this._invertedTokenIndex[sTok];
                        for (var srIdx = 0; srIdx < sMatched.length; srIdx++) {
                            var scRule = sMatched[srIdx];
                            if (scRule && scRule.isActive !== false && !seenRuleIds[scRule.id]) {
                                seenRuleIds[scRule.id] = true;
                                candidateRules.push(scRule);
                            }
                        }
                    }
                }
            }
        } else {
            candidateRules = activeRules;
        }

        if (candidateRules.length === 0) {
            return {
                passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [],
                diagnostics: { activeRules: activeRules.length, candidateRules: 0, rejectedByStage: { token_index_miss: activeRules.length }, nearMiss: null }
            };
        }

        for (var i = 0; i < candidateRules.length; i++) {
            var r = candidateRules[i];

            // 0. Filter Quota & Distinct Buyer check: deduct fulfilled filters
            if (self._deactivatedFilterIds && self._deactivatedFilterIds.has(String(r.id))) { reject('filter_deactivated_quota'); continue; }
            var completedBuyers = self._filterCompletedBuyers.get(r.id) || self._filterCompletedBuyers.get(String(r.id));
            var completedCount = completedBuyers ? completedBuyers.size : 0;
            var target = 10;
            if (typeof r.targetQuantity === 'number' && r.targetQuantity > 0) {
                target = r.targetQuantity;
            } else if (typeof r.target_lead_count === 'number' && r.target_lead_count > 0) {
                target = r.target_lead_count;
            } else if (r.filter_config && typeof r.filter_config.target_quantity === 'number' && r.filter_config.target_quantity > 0) {
                target = r.filter_config.target_quantity;
            } else if (r.filter_config && typeof r.filter_config.target_lead_count === 'number' && r.filter_config.target_lead_count > 0) {
                target = r.filter_config.target_lead_count;
            }
            if (completedCount >= target) { reject('quota_reached'); continue; }

            var inFlight = self._filterInFlight.get(r.id) || self._filterInFlight.get(String(r.id));
            var inFlightCount = inFlight ? inFlight.size - (inFlight.has(lead.leadId) ? 1 : 0) : 0;
            if (completedCount + inFlightCount >= target) { reject('quota_in_flight'); continue; }

            if (buyerId && completedBuyers && completedBuyers.has(buyerId)) { reject('buyer_already_completed'); continue; }

            // 1. Restricted countries check
            if (r.restrictedCountries && r.restrictedCountries.length > 0) {
                var restricted = false;
                for (var ri = 0; ri < r.restrictedCountries.length; ri++) {
                    var rEntry = r.restrictedCountries[ri];
                    var rIso = COUNTRY_NAME_TO_ISO[rEntry.toLowerCase()] || (rEntry.length === 2 ? rEntry.toUpperCase() : null);
                    if (rIso && leadCountryIso && rIso === leadCountryIso) { restricted = true; break; }
                    if (leadCountryIso && COUNTRY_CODE_MAP[leadCountryIso] && COUNTRY_CODE_MAP[leadCountryIso].indexOf(rEntry.toLowerCase()) !== -1) {
                        restricted = true; break;
                    }
                    for (var lp = 0; lp < locParts.length; lp++) {
                        if (rEntry.toLowerCase() === locParts[lp]) { restricted = true; break; }
                    }
                    if (restricted) break;
                }
                if (restricted) { reject('restricted_country'); continue; }
            }

            // 2. Location include check
            if (!locationMatches(r)) { reject('location_mismatch'); continue; }

            // 3. Contact requirements: Strict OR logic across selected channels.
            // If multiple contact channels are required (e.g. Phone OR Email), a lead with
            // EITHER of these contact details qualifies (does NOT require both).
            var reqMobile = !!(
                r.requireMobile || r.require_mobile || r.requirePhone || r.require_phone ||
                (r.filter_config && (r.filter_config.require_mobile || r.filter_config.requireMobile || r.filter_config.require_phone || r.filter_config.requirePhone))
            );
            var reqWhatsapp = !!(
                r.requireWhatsapp || r.require_whatsapp ||
                (r.filter_config && (r.filter_config.require_whatsapp || r.filter_config.requireWhatsapp))
            );
            var reqEmail = !!(
                r.requireEmail || r.require_email ||
                (r.filter_config && (r.filter_config.require_email || r.filter_config.requireEmail))
            );
            var reqAnyContact = !!(
                r.requireContact || r.require_contact ||
                (r.filter_config && (r.filter_config.require_contact || r.filter_config.requireContact))
            );

            if (reqMobile || reqWhatsapp || reqEmail || reqAnyContact) {
                // Check all possible contact properties across DOM parser & network interceptor
                var hasMobile = [contact.mobile, contact.phone, lead.senderMobile, lead.senderPhone, lead.mobile, lead.phone, lead.senderMobileAlt, lead.senderPhoneAlt, lead.hasMobileVerified, lead.hasMobile, lead.hasPhone].some(Core.available);
                var hasWhatsapp = [contact.whatsapp, lead.hasWhatsapp].some(Core.available);
                var hasEmail = [contact.email, lead.senderEmail, lead.email, lead.senderEmailAlt, lead.hasEmailVerified, lead.hasEmail].some(Core.available);

                // OR LOGIC: Any selected contact detail qualifies the lead
                var satisfiesAny = (reqMobile && hasMobile) ||
                                   (reqWhatsapp && hasWhatsapp) ||
                                   (reqEmail && hasEmail) ||
                                   (reqAnyContact && (hasMobile || hasWhatsapp || hasEmail));
                if (!satisfiesAny) { reject('contact_requirement'); continue; }
            }

            // 4. Quantity filter
            if (r.minQuantity > 0) {
                var q = lead.quantity;
                if (typeof q === 'number') q = { max: q };
                if (!q || (r.quantityUnit && normalizeUnit(q.unit) !== normalizeUnit(r.quantityUnit)) || !(Number(q.max) >= r.minQuantity)) { reject('quantity_requirement'); continue; }
            }

            // 5. Stage A Eligibility + Stage B Relevance Scoring
            var evaluation = self.matcher.evaluate(lead, r, leadContext);
            if (evaluation.passed) {
                candidateMatches.push({
                    filter: r,
                    filterId: r.id,
                    filterName: r.name,
                    score: evaluation.score,
                    confidence: evaluation.confidence,
                    matchedKeyword: evaluation.matchedKeyword,
                    reasons: evaluation.reasons
                });
            } else {
                reject((evaluation.stage || 'matcher') + ':' + (evaluation.reason || 'unknown'));
                if (evaluation.score > 0 && (!nearMiss || evaluation.score > nearMiss.score)) {
                    nearMiss = { filterId: r.id, score: evaluation.score, reason: evaluation.reason };
                }
            }
        }

        if (candidateMatches.length === 0) {
            return {
                passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [],
                diagnostics: { activeRules: activeRules.length, rejectedByStage: stageCounts, nearMiss: nearMiss }
            };
        }

        // Rank candidates deterministically by relevance score and confidence
        var ranked = self.matcher.rankCandidates(candidateMatches);
        var best = ranked[0];

        return {
            passed: true,
            reason: null,
            filterId: best.filterId,
            filterName: best.filterName,
            score: best.score,
            confidence: best.confidence,
            reasons: best.reasons || [],
            pointsDistribution: best.reasons || [],
            matchedProducts: best.matchedKeyword ? [best.matchedKeyword] : [normalizeText(lead.productName)],
            matchedRequired: [],
            matchedNegative: []
        };
    };

    KeywordManager.prototype.getKeywords = function (type) { return this.keywords[type] || []; };
    KeywordManager.prototype.getAllKeywords = function () { return this.keywords; };

    // ============================================================
    // CHECK KEYWORDS — v6.3 SIGNATURE
    // ------------------------------------------------------------
    // checkKeywords(productName, messageText)
    //   • product keyword  → must match productName OR messageText (description)
    //                        Fixes: medicine name in contents/description missed.
    //   • negative keyword → reject if matches productName OR messageText (dynamic exclusion)
    //   • required keyword → at least one must match productName OR messageText
    // ============================================================
    KeywordManager.prototype.checkKeywords = function (productName, messageText, lead) {
        productName = productName || '';
        messageText = messageText || '';

        var req = this.keywords.required || [];
        var neg = this.keywords.negative || [];
        var prod = this.keywords.product || [];

        // --- NEGATIVE GATE (primary product and buyer requirement, never related products/category) ---
        var negMatched = [];
        for (var j = 0; j < neg.length; j++) {
            if (this._textMatches(productName, neg[j]) || this._textMatches(messageText, neg[j])) negMatched.push(neg[j]);
        }
        if (negMatched.length > 0) {
            return { passed: false, reason: 'negative_keyword_found', matchedProducts: [], matchedRequired: [], matchedNegative: negMatched };
        }

        // --- REQUIRED GATE (OR across productName + messageText) ---
        var reqMatched = [];
        if (req.length > 0) {
            for (var i = 0; i < req.length; i++) {
                if (this._textMatches(productName, req[i]) || this._textMatches(messageText, req[i])) {
                    reqMatched.push(req[i]);
                }
            }
            if (reqMatched.length === 0) {
                return { passed: false, reason: 'no_required_keyword', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
            }
        }

        // --- PRODUCT GATE (productName OR messageText) ---
        // Key fix: if the medicine/product name is in the description (messageText)
        // rather than the card title, we still match it correctly.
        var prodMatched = [];
        if (prod.length > 0) {
            for (var k = 0; k < prod.length; k++) {
                if (this._textMatches(productName, prod[k]) || this._textMatches(messageText, prod[k])) {
                    prodMatched.push(prod[k]);
                }
            }
            if (prodMatched.length === 0) {
                return { passed: false, reason: 'no_product_keyword', matchedProducts: [], matchedRequired: reqMatched, matchedNegative: [] };
            }
        } else if (req.length === 0) {
            return { passed: false, reason: 'no_keywords_configured', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
        }

        var locations = this.keywords.location || [];
        if (locations.length && lead) {
            var country = Core.countryFromLead(lead);
            var countries = locations.map(Core.country).filter(Boolean);
            var regions = locations.filter(function (value) { return !Core.country(value); });
            var locationText = [lead.city, lead.state, lead.location].filter(Boolean).join(' ');
            if ((countries.length && countries.indexOf(country) === -1) || (regions.length && !regions.some(function (value) { return wordBoundaryMatch(normalizeText(locationText), normalizeText(value)); }))) {
                return { passed: false, reason: 'location_mismatch', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
            }
        }
        return { passed: true, reason: null, matchedProducts: prodMatched, matchedRequired: reqMatched, matchedNegative: [] };
    };

    // ============================================================
    // SAFETY CONTROLLER
    // ============================================================
    function SafetyController(circuitBreaker) {
        this.mode = 'AUTOMATIC';
        this.circuitBreaker = circuitBreaker || null;
        this._emergencyStop = false;
        this.counters = { minute: 0, hour: 0, day: 0, session: 0 };
        this.pendingReservations = 0;
        this.limits = { perMinute: 60, perHour: 400, perDay: 2000, perSession: 1000 };
        this._lastMin = Date.now();
        this._lastHour = Date.now();
        this._lastDay = Date.now();
        this._reservationTokens = {};
        this.cooldownMs = 0;
        this._lastAcquisitionAt = 0;
        this.ready = this._loadCounters();
    }
    SafetyController.prototype._loadCounters = function () {
        var self = this;
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(['bl_safety_counters', 'bl_safety_timestamps'], function (res) {
                    var counters = res && res.bl_safety_counters || {};
                    var times = res && res.bl_safety_timestamps || {};
                    ['minute', 'hour', 'day', 'session'].forEach(function (k) { self.counters[k] = Number(counters[k]) || 0; });
                    self._lastAcquisitionAt = Math.min(Date.now(), Number(times.lastAcquisitionAt) || 0);
                    self._lastMin = times.lastMin || Date.now(); self._lastHour = times.lastHour || Date.now(); self._lastDay = times.lastDay || Date.now();
                    self._reset(); resolve();
                });
            } catch (e) { self._emergencyStop = true; resolve(); }
        });
    };
    SafetyController.prototype._saveCounters = function () {
        try {
            var c = {
                minute: this.counters.minute,
                hour: this.counters.hour,
                day: this.counters.day,
                session: this.counters.session
            };
            var t = {
                lastMin: this._lastMin,
                lastHour: this._lastHour,
                lastDay: this._lastDay,
                lastAcquisitionAt: this._lastAcquisitionAt
            };
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ bl_safety_counters: c, bl_safety_timestamps: t });
            }
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('bl_safety_counters', JSON.stringify(c));
            }
        } catch (e) { }
    };
    SafetyController.prototype._reset = function () {
        var now = Date.now();
        var changed = false;
        if (now - this._lastMin > 60000) { this.counters.minute = 0; this._lastMin = now; changed = true; }
        if (now - this._lastHour > 3600000) { this.counters.hour = 0; this._lastHour = now; changed = true; }
        if (now - this._lastDay > 86400000) { this.counters.day = 0; this._lastDay = now; changed = true; }
        if (changed) this._saveCounters();
    };
    SafetyController.prototype.setMode = function (m) { this.mode = m; };
    SafetyController.prototype.setLimits = function (l) {
        for (var k in l) if (l.hasOwnProperty(k) && this.limits.hasOwnProperty(k)) this.limits[k] = l[k];
    };
    SafetyController.prototype.setCooldown = function (ms) { this.cooldownMs = Math.min(86400000, Math.max(0, Number(ms) || 0)); };
    SafetyController.prototype.canAcquire = function (ownedToken) {
        this._reset();
        if (this.circuitBreaker && !this.circuitBreaker.canExecute()) return { allowed: false, reason: 'PLATFORM_RESTRICTION' };
        if (this._emergencyStop) return { allowed: false, reason: 'EMERGENCY_STOP' };
        if (this.mode === 'MONITOR') return { allowed: false, reason: 'MONITOR_MODE' };
        if (this.mode === 'DRY_RUN') return { allowed: false, reason: 'DRY_RUN', dryRun: true };
        
        var remaining = Math.max(0, this.cooldownMs - (Date.now() - this._lastAcquisitionAt));
        if (remaining) return { allowed: false, reason: 'COOLDOWN', remainingMs: remaining };
        if (ownedToken && !this._reservationTokens[ownedToken]) return { allowed: false, reason: 'STALE_RESERVATION' };
        var pending = Math.max(0, this.pendingReservations - (ownedToken ? 1 : 0));
        var effectiveMin = this.counters.minute + pending;
        if (effectiveMin >= this.limits.perMinute) {
            return { allowed: false, reason: 'MINUTE_LIMIT', details: { used: effectiveMin, limit: this.limits.perMinute } };
        }
        if ((this.counters.hour + pending) >= this.limits.perHour) {
            return { allowed: false, reason: 'HOUR_LIMIT', details: { used: this.counters.hour, limit: this.limits.perHour } };
        }
        if ((this.counters.day + pending) >= this.limits.perDay) {
            return { allowed: false, reason: 'DAY_LIMIT', details: { used: this.counters.day, limit: this.limits.perDay } };
        }
        if ((this.counters.session + pending) >= this.limits.perSession) {
            return { allowed: false, reason: 'SESSION_LIMIT', details: { used: this.counters.session, limit: this.limits.perSession } };
        }
        return { allowed: true };
    };
    SafetyController.prototype.reserveCapacity = function (leadId) {
        var check = this.canAcquire();
        if (!check.allowed) return { allowed: false, reason: check.reason, details: check.details };
        var token = 'res_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
        this.pendingReservations++;
        this._reservationTokens[token] = { leadId: leadId, timestamp: Date.now() };
        return { allowed: true, token: token };
    };
    SafetyController.prototype.releaseReservation = function (token) {
        if (token && this._reservationTokens[token]) {
            delete this._reservationTokens[token];
            this.pendingReservations = Math.max(0, this.pendingReservations - 1);
        }
    };
    SafetyController.prototype.commitReservation = function (token) {
        if (token && this._reservationTokens[token]) {
            delete this._reservationTokens[token];
            this.pendingReservations = Math.max(0, this.pendingReservations - 1);
        }
        this.recordAcquisition();
    };
    SafetyController.prototype.recordAcquisition = function () {
        this._reset();
        this.counters.minute++;
        this.counters.hour++;
        this.counters.day++;
        this.counters.session++;
        this._lastAcquisitionAt = Date.now();
        this._saveCounters();
    };
    SafetyController.prototype.emergencyStopFn = function () { this._emergencyStop = true; };
    SafetyController.prototype.resume = function () { this._emergencyStop = false; };
    SafetyController.prototype.getStatus = function () {
        return {
            mode: this.mode,
            emergencyStop: this._emergencyStop,
            circuitBreaker: this.circuitBreaker ? this.circuitBreaker.getState() : 'NORMAL',
            counters: this.counters,
            pendingReservations: this.pendingReservations,
            limits: this.limits,
            cooldown: Date.now() - this._lastAcquisitionAt < this.cooldownMs,
            cooldownMs: Math.max(0, this.cooldownMs - (Date.now() - this._lastAcquisitionAt))
        };
    };

    // ============================================================
    // DUPLICATE MANAGER
    // ============================================================
    function DuplicateManager(supabase) {
        this.supabase = supabase;
        this._seen = new Set();
        this._loadedFromDb = false;
    }
    DuplicateManager.prototype.loadFromDb = function () {
        var self = this;
        if (this._loadedFromDb) return Promise.resolve();
        // Only load contacted / acquired leads — un-acquired leads are NEVER duplicates
        return this.supabase.getRecentLeads(500).then(function (leads) {
            var loaded = 0;
            for (var i = 0; i < leads.length; i++) {
                if (leads[i].is_contacted || leads[i].status === 'contacted' || leads[i].status === 'acquired') {
                    if (leads[i].unique_query_id) self._seen.add(leads[i].unique_query_id);
                    loaded++;
                }
            }
            self._loadedFromDb = true;
            console.log('[Dup] Loaded ' + loaded + ' contacted leads from DB');
            return loaded;
        }).catch(function () {
            self._loadedFromDb = true;
            return 0;
        });
    };
    DuplicateManager.prototype.isDuplicate = function (leadId) { return this._seen.has(leadId); };
    DuplicateManager.prototype.markSeen = function (leadId) { this._seen.add(leadId); };
    DuplicateManager.prototype.clear = function () { this._seen = new Set(); };
    DuplicateManager.prototype.cleanup = function () {
        if (this._seen.size > 5000) {
            var arr = Array.from(this._seen);
            this._seen = new Set(arr.slice(-3000));
        }
    };

    // ============================================================
    // STATE MACHINE
    // ============================================================
    function LeadStateMachine() { this._states = {}; }
    LeadStateMachine.prototype.setState = function (id, state) {
        this._states[id] = state;
        return Promise.resolve(state);
    };
    LeadStateMachine.prototype.getState = function (id) {
        return this._states[id];
    };
    LeadStateMachine.prototype.getStats = function () {
        var s = {};
        for (var k in this._states) { var v = this._states[k]; s[v] = (s[v] || 0) + 1; }
        return s;
    };

    // ============================================================
    // LEAD QUEUE (FAST DRAIN)
    // ============================================================
    function LeadQueue() {
        this.logger = new Logger('LeadQueue');
        this.queue = [];
        this.processing = 0;
        this.processor = null;
        this._running = true;
        this._currentId = null;
        this._currentUqid = null;
        this._activeIds = new Set();
        this._activeUqids = new Set();
    }
    LeadQueue.prototype.setProcessor = function (p) {
        this.processor = p;
        this.logger.info('Processor set');
        this._process();
    };
    LeadQueue.prototype.enqueue = function (lead) {
        if (!lead || !lead.leadId) return false;
        // Strict in-flight deduplication using Sets
        if (this._activeIds.has(lead.leadId)) return false;
        if (this._currentId === lead.leadId) return false;
        for (var i = 0; i < this.queue.length; i++) {
            if (this.queue[i].leadId === lead.leadId) return false;
        }
        // Also dedup by uniqueQueryId — catches same physical lead arriving via
        // both the network-intercept path (api_12345) and the DOM path (hash_abc).
        if (lead.uniqueQueryId) {
            if (this._activeUqids.has(lead.uniqueQueryId)) return false;
            if (this._currentUqid === lead.uniqueQueryId) return false;
            for (var j = 0; j < this.queue.length; j++) {
                if (this.queue[j].uniqueQueryId === lead.uniqueQueryId) return false;
            }
        }
        this.queue.push(lead);
        this._process();
        return true;
    };
    LeadQueue.prototype._process = function () {
        var self = this;
        if (!this._running || !this.processor || this.queue.length === 0) return;
        // Strict sequential acquisition pipeline (MAX_PARALLEL = 1)
        // Prevents DOM modal collisions (.SLC_PopCntr), crosstalk, and callback overwrites
        var MAX_PARALLEL = 1;
        while (this._running && this.queue.length > 0 && this.processing < MAX_PARALLEL) {
            (function () {
                var lead = self.queue.shift();
                self.processing++;
                self._activeIds.add(lead.leadId);
                if (lead.uniqueQueryId) self._activeUqids.add(lead.uniqueQueryId);
                self._currentId = lead.leadId;
                self._currentUqid = lead.uniqueQueryId || null;

                function cleanup() {
                    self.processing--;
                    self._activeIds.delete(lead.leadId);
                    if (lead.uniqueQueryId) self._activeUqids.delete(lead.uniqueQueryId);
                    if (self.processing === 0) {
                        self._currentId = null;
                        self._currentUqid = null;
                    }
                    if (self.queue.length > 0) self._process();
                }

                try {
                    Promise.resolve(self.processor(lead)).then(function () {
                        cleanup();
                    }).catch(function (err) {
                        self.logger.error('Processor error', { leadId: lead.leadId, error: err && err.message ? err.message : String(err) });
                        cleanup();
                    });
                } catch (syncErr) {
                    self.logger.error('Processor sync error', { leadId: lead.leadId, error: syncErr && syncErr.message ? syncErr.message : String(syncErr) });
                    cleanup();
                }
            })();
        }
    };
    LeadQueue.prototype.getStatus = function () { return { size: this.queue.length, processing: this.processing, running: this._running }; };
    LeadQueue.prototype.pause = function () { this._running = false; };
    LeadQueue.prototype.resume = function () { this._running = true; this._process(); };

    // ============================================================
    // SCANNER (FASTER DEBOUNCE)
    // ============================================================
    function Scanner() {
        this.logger = new Logger('Scanner');
        this._running = false;
        this._callback = null;
        this._observer = null;
        this._targetNode = null;
        this._topSentinel = null;
        this._scanTimer = null;
        this._knownLeads = {};
        this._deferredUntil = {};
        this._elementSignatures = new WeakMap();
        this._debounceMs = 3; // Briefly coalesce mutation bursts before scanning
        this._reconciliationFallbackMs = 1000; // Secondary reconciliation check when DOM mutations are missed
        this._idGen = new LeadIdGenerator();
        this._scanning = false;
        this._scanPending = false;
    }
    Scanner.prototype.resetEmitted = function () {
        this._knownLeads = {};
    };
    Scanner.prototype._attachTopSentinel = function () {
        if (this._topSentinel) return;
        var s = document.createElement('div');
        s.id = 'bl-top-sentinel';
        s.style.cssText = 'height:1px;width:100%;pointer-events:none;opacity:0;';
        if (document.body) document.body.insertBefore(s, document.body.firstChild);
        this._topSentinel = s;
    };
    
    // ═══════════════════════════════════════════════════════════════
    // Session warnings belong to the portal and are never auto-dismissed.
    // ═══════════════════════════════════════════════════════════════
    Scanner.prototype._checkInactivityPopup = function () { return false; };

    Scanner.prototype._checkNewLeadsBanner = function () {
        var queue = this.orchestrator && this.orchestrator.queue;
        if (queue && (queue.processing || queue.queue.length)) return false;
        if (!this._clickedBanners) this._clickedBanners = new WeakMap();
        try {
            var now = Date.now();
            if (this._lastBannerCheck && (now - this._lastBannerCheck < 250)) return false;
            this._lastBannerCheck = now;

            var banners = document.querySelectorAll(
                '.bl_new_toast, [class*="new_buylead" i], [class*="newBuyLead" i], [class*="newLead" i], [class*="alert_new" i]'
            );
            for (var i = 0; i < banners.length; i++) {
                var b = banners[i];
                if (b.id && b.id.indexOf('bl-') === 0) continue; // Skip extension panel UI
                var t = (b.textContent || '').trim().toLowerCase();
                if ((t.indexOf('new buylead') !== -1 || t.indexOf('new lead') !== -1 || t.indexOf('new enquiry') !== -1 || t.indexOf('latest lead') !== -1)
                    && (t.indexOf('click') !== -1 || t.indexOf('refresh') !== -1 || t.indexOf('available') !== -1 || t.indexOf('view') !== -1 || t.indexOf('load') !== -1 || t.indexOf('show') !== -1)) {
                    if (this._clickedBanners.get(b) === t) continue;
                    this._clickedBanners.set(b, t);
                    b.click();
                    this.logger.info('⚡ Clicked IndiaMART New Leads banner: "' + t.substring(0, 40) + '"');
                    return true;
                }
            }
        } catch (e) { }
        return false;
    };
    Scanner.prototype._setupObserver = function () {
        if (this._observer) {
            try { this._observer.disconnect(); } catch (e) { }
            this._observer = null;
        }
        var feedContainer = null;
        if (typeof document !== 'undefined') {
            feedContainer = document.querySelector(
                '#bl_feed_list, #bl_listing, [class*="feed_list" i], [class*="bl_listing" i], ' +
                '[class*="BLbp_cnt" i], #id_bl_cnt, [id*="feed_list" i], #listing, .BLbp_cnt'
            );
            if (!feedContainer) {
                var sampleCard = document.querySelector('.BLbp_card, [class*="BuyLdC_cont"], [class*="BuyLdC_Card"], div[id*="id_BLCard"]');
                if (sampleCard && sampleCard.parentElement) {
                    feedContainer = sampleCard.parentElement;
                }
            }
        }
        var targetNode = feedContainer || (typeof document !== 'undefined' && (document.body || document.documentElement)) || null;
        this._targetNode = targetNode;

        var self2 = this;
        try {
            if (typeof MutationObserver !== 'undefined' && targetNode) {
                this._observer = new MutationObserver(function () {
                    if (self2._scanPending) return;
                    self2._scanPending = true;
                    setTimeout(function () {
                        self2._scanPending = false;
                        self2._scan();
                    }, self2._debounceMs);
                });
                this._observer.observe(targetNode, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ['data-sold', 'data-lead-id', 'data-query-id', 'data-blid', 'data-uqid', 'data-click-data', 'onclick', 'href', 'alt', 'src', 'data-country', 'class', 'style', 'hidden']
                });
            }
        } catch (e) { }
    };
    Scanner.prototype.startWatching = function (cb) {
        if (this._running) return;
        this._callback = cb;
        this._running = true;
        var self2 = this;

        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'scanner.started', 'Scanner', {
                operationId: this.logger.generateOperationId ? this.logger.generateOperationId('scan') : undefined,
                reasonCode: 'USER_STARTED',
                result: 'RUNNING'
            });
        }

        this._setupObserver();

        // Low-frequency reconciliation when portal updates escape the feed observer.
        this._scanTimer = setInterval(function () {
            if (self2._targetNode === document.body || self2._targetNode === document.documentElement) {
                var feed = document.querySelector('#bl_feed_list, #bl_listing, [class*="feed_list" i], [class*="bl_listing" i], [class*="BLbp_cnt" i], #id_bl_cnt, [id*="feed_list" i], #listing, .BLbp_cnt');
                if (!feed) {
                    var sc = document.querySelector('.BLbp_card, [class*="BuyLdC_cont"], [class*="BuyLdC_Card"], div[id*="id_BLCard"]');
                    if (sc && sc.parentElement) feed = sc.parentElement;
                }
                if (feed && feed !== self2._targetNode) {
                    self2.logger.info('🎯 Narrowed MutationObserver to active lead feed container');
                    self2._setupObserver();
                }
            } else if (self2._targetNode && typeof document.contains === 'function' && !document.contains(self2._targetNode)) {
                self2.logger.info('🔄 Target node replaced — reattaching observer');
                self2._setupObserver();
            }
            self2._scan();
        }, this._reconciliationFallbackMs);

        this.logger.info('Event-driven scanner started (first five visible cards, 1s reconciliation)');
        // Remove the 50ms initial scan — _startLoop fires _scan() via tryCards()
        // at 0-100ms already. The immediate duplicate here is the source of
        // the triple-scan problem.
        // setTimeout(function() { self2._scan(); }, 50);  <-- REMOVED
    };
    Scanner.prototype.stopWatching = function () {
        this._running = false;
        if (this._observer) {
            try { this._observer.disconnect(); } catch (e) { }
            this._observer = null;
        }
        if (this._scanTimer) {
            clearInterval(this._scanTimer);
            this._scanTimer = null;
        }
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'scanner.paused', 'Scanner', {
                reasonCode: 'USER_PAUSED',
                result: 'STOPPED'
            });
        }
    };
    Scanner.prototype._scan = function () {
        if (this._scanning || !this._running) return false;

        // Safety Guard: Never scan or attempt acquisition on Past Leads / Consumed tabs
        var pageHref = (typeof window !== 'undefined' && window.location && window.location.href) ? window.location.href.toLowerCase() : '';
        if (pageHref.indexOf('pastleads') !== -1 || pageHref.indexOf('pref=past') !== -1 || pageHref.indexOf('tab=past') !== -1 || pageHref.indexOf('consumed') !== -1) {
            return false;
        }
        if (this.orchestrator && this.orchestrator.keywordManager && this.orchestrator.keywordManager.getActiveFilterCount() === 0) {
            return false;
        }
        // Abort scan immediately if IndiaMART rate-limit warning is visible on the page.
        if (this._checkRateLimitWarning()) return false;

        this._scanning = true;
        var scanOpId = this.logger && this.logger.generateOperationId ? this.logger.generateOperationId('scan_cyc') : ('sc_' + Date.now());
        var scanStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('DEBUG', 'scanner.cycle.started', 'Scanner', {
                operationId: scanOpId,
                reasonCode: 'TIMER_OR_OBSERVER_TRIGGER',
                result: 'STARTED'
            });
        }
        try {
            // Auto-detect and click any "New Leads Available" banner to bring dynamic leads into portal DOM
            this._checkNewLeadsBanner();


            var cards = Core.priorityCards(document, MAX_DOM_SCAN_LIMIT);
            var currentIds = {};
            var newCards = [];
            var idGen = this._idGen;
            var known = this._knownLeads;
            if (!this._elementIds) this._elementIds = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
            var scanLimit = (typeof MAX_DOM_SCAN_LIMIT !== 'undefined' ? MAX_DOM_SCAN_LIMIT : 5);
            for (var i = 0; i < cards.length && newCards.length < scanLimit; i++) {
                var el = cards[i];
                // The orchestrator deduplicates by inquiry ID. Do not suppress contact
                // enrichment or mistake words in a buyer's requirement for portal status.
                var id = idGen.generateFromElement(el);
                if (!id) {
                    // Card DOM exists but text content not yet rendered.
                    // Schedule a quick re-scan so we don't permanently skip this card.
                    if (!this._emptyCardRescanScheduled) {
                        this._emptyCardRescanScheduled = true;
                        var self3 = this;
                        setTimeout(function () {
                            self3._emptyCardRescanScheduled = false;
                            if (self3._running) self3._scan();
                        }, 150);
                    }
                    continue;
                }
                currentIds[id] = 1;
                if (this._deferredUntil[id]) {
                    if (Date.now() < this._deferredUntil[id]) continue;
                    delete known[id]; delete this._deferredUntil[id];
                }
                var signature = (el.textContent || '') + '|' + Core.elementLeadId(el) + '|' + (el.className || '');
                el.querySelectorAll('a[href^="tel:"], a[href^="mailto:"], img[src*="flag"], [data-country]').forEach(function (node) {
                    signature += '|' + (node.getAttribute('href') || node.getAttribute('src') || node.getAttribute('data-country') || '') + '|' + (node.getAttribute('alt') || '') + '|' + Core.visible(node);
                });
                var changed = this._elementSignatures.get(el) !== signature;
                this._elementSignatures.set(el, signature);
                if (!known[id] || changed) {
                    known[id] = Date.now();
                    // Same DOM node, new content hash == the card finished hydrating (updated card).
                    // Re-evaluate it, but tell the orchestrator which ID it replaces so counters
                    // and in-flight locks are not double counted.
                    var prevId = this._elementIds ? this._elementIds.get(el) : null;
                    if (prevId && prevId !== id) delete known[prevId];
                    newCards.push({ element: el, id: id, replacesId: (prevId && prevId !== id) ? prevId : null });
                } else { known[id] = Date.now(); }
                if (this._elementIds) this._elementIds.set(el, id);
            }
            var now = Date.now();
            for (var key in known) {
                var age = now - known[key];
                if (age > 1800000) delete known[key];
            }
            var scanDuration = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - scanStart);
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('DEBUG', 'scanner.cycle.completed', 'Scanner', {
                    operationId: scanOpId,
                    durationMs: scanDuration,
                    reasonCode: 'CYCLE_FINISHED',
                    result: 'COMPLETED',
                    metrics: { totalCards: cards.length, newCards: newCards.length }
                });
            }
            if (newCards.length > 0) this._callback(newCards);
        } catch (e) {
            var scanDurationErr = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - scanStart);
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('ERROR', 'scanner.error', 'Scanner', {
                    operationId: scanOpId,
                    durationMs: scanDurationErr,
                    reasonCode: 'SCAN_EXCEPTION',
                    result: 'FAILED',
                    error: e && e.message
                });
            }
            this.logger.error('Scan error: ' + (e && e.message));
        }
        this._scanning = false;
    };

    // Detect IndiaMART's account rate-limit warning.
    // Scoped to a known container (not full body) for performance.
    // Debounced: checked at most once every 5 seconds.
    Scanner.prototype._checkRateLimitWarning = function () {
        try {
            var now = Date.now();
            if (this._lastRateLimitCheck && (now - this._lastRateLimitCheck) < 5000) return false;
            this._lastRateLimitCheck = now;

            // Check only the main content area, not entire body (performance)
            var container = document.querySelector(
                '#bltxn_main, .BuyLdC_main, [class*="BuyLd_main"], [class*="bltxn"], main, #main-content'
            ) || document.body;
            if (!container) return false;
            var text = (container.textContent || '').toLowerCase();
            if (!text) return false;

            for (var p = 0; p < RATE_LIMIT_PHRASES.length; p++) {
                if (text.indexOf(RATE_LIMIT_PHRASES[p]) !== -1) {
                    this.logger.warn('🚫 IndiaMART rate-limit warning detected — stopping all automated activity');
                    if (this.orchestrator && typeof this.orchestrator._onRateLimitDetected === 'function') {
                        this.orchestrator._onRateLimitDetected();
                    }
                    return true;
                }
            }
        } catch (e) { }
        return false;
    };
    // Let a deferred card (safety limit, enqueue refused, filters not loaded) be emitted again.
    Scanner.prototype.forget = function (id, delayMs) {
        if (!id) return;
        if (!this._deferredUntil) this._deferredUntil = {};
        if (delayMs > 0) this._deferredUntil[id] = Date.now() + delayMs;
        else { delete this._knownLeads[id]; delete this._deferredUntil[id]; }
    };
    Scanner.prototype.resetEmitted = function () {
        this._knownLeads = {};
        this._deferredUntil = {};
        this.logger.info('🔄 Scanner emitted-cache cleared — next scan will re-emit all DOM cards');
    };
    Scanner.prototype.getStatus = function () { return { running: this._running, knownLeads: Object.keys(this._knownLeads).length }; };

    // ============================================================
    // PARSER — v6.2: SEPARATE FIELDS, NO CONCATENATION
    // ============================================================
    function cleanRawLocation(raw) {
        if (!raw) return null;
        return raw
            .replace(/(?:click\s*here|view\s*contact|view\s*details|view\s*phone)[\s\S]*$/i, '')
            .replace(/\s+/g, ' ')
            .trim() || null;
    }

    function normalizeUnit(u) {
        if (!u) return null;
        u = String(u).toLowerCase().trim();
        if (u === 'box' || u === 'boxes') return 'box';
        if (u === 'strip' || u === 'strips' || u === 'stripe' || u === 'stripes') return 'strip';
        if (u === 'tube' || u === 'tubes') return 'tube';
        if (u === 'piece' || u === 'pieces' || u === 'pc' || u === 'pcs') return 'piece';
        if (u === 'vial' || u === 'vials') return 'vial';
        if (u === 'bottle' || u === 'bottles') return 'bottle';
        if (u === 'pack' || u === 'packs' || u === 'package') return 'pack';
        return null;
    }

    function parseQuantityString(str) {
        if (!str) return null;
        str = String(str).trim();
        // Match: "5 Piece", "10 Boxes", "5-10 Box", "50 Vial", "Pack of 6 Box"
        var m = str.match(/(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*([a-zA-Z]+)/);
        if (!m) return null;
        var min = parseInt(m[1], 10);
        var max = m[2] ? parseInt(m[2], 10) : min;
        var unit = normalizeUnit(m[3]);
        if (!unit) return null;
        return { min: min, max: max, unit: unit };
    }

    function extractQuantityFromCard(el) {
        try {
            var items = el.querySelectorAll('[class*="BuyLdC_isqdet"]');
            for (var i = 0; i < items.length; i++) {
                var label = items[i].querySelector('span.SLC_c0');
                if (!label) continue;
                var labelText = (label.textContent || '').trim().toLowerCase();
                if (labelText === 'quantity' || labelText === 'qty' || labelText === 'buyer filled details') {
                    var strong = items[i].querySelector('strong');
                    if (strong) {
                        var parsed = parseQuantityString(strong.textContent);
                        if (parsed) return parsed;
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    function extractQuantityFromTitle(title) {
        if (!title) return null;
        var m = title.match(/\bqty\s*[:\-]\s*([^\|]+)/i);
        if (!m) return null;
        return parseQuantityString(m[1]);
    }

    function Parser() { this.logger = new Logger('Parser'); }

    Parser.prototype.parseCard = function (el, leadId) {
        try {
            // --- PRODUCT NAME (robust selector chain) ---
            // FIX: the old `a || b || c` chain stopped at the first selector that matched
            // ANY element, even an empty one, so later selectors were never tried.
            // Now each selector is tried in order and the first element with real text wins.
            var PRODUCT_SELECTORS = [
                '.BLbp_title', '[class*="BuyLdC"] span.SLC_f18', '[class*="BuyLdC"] .SLC_f18',
                'span.SLC_f18', '.SLC_f18', '[class*="BLbp_title" i]', '[class*="BLbp_head" i]',
                '[class*="prod_name" i], [class*="product_name" i]', '[class*="title" i]', 'h2, h3, h4'
            ];
            var productName = '';
            for (var psi = 0; psi < PRODUCT_SELECTORS.length && productName.length < 2; psi++) {
                var psNodes = el.querySelectorAll(PRODUCT_SELECTORS[psi]);
                for (var pni = 0; pni < psNodes.length; pni++) {
                    var psTxt = (psNodes[pni].textContent || '').replace(/\s+/g, ' ').trim();
                    if (psTxt.length >= 2) { productName = psTxt; break; }
                }
            }
            if (!productName || productName.length < 2) {
                var searchFallback = el.querySelector('.BLbp_desc em, [class*="BuyLdC_msg"] em');
                if (searchFallback && searchFallback.textContent.trim().length >= 2) {
                    productName = searchFallback.textContent.trim();
                }
            }
            // --- QUANTITY ---
            var quantity = extractQuantityFromCard(el);
            if (!quantity) {
                quantity = extractQuantityFromTitle(productName);
            }

            // --- LOCATION EXTRACTION (DOMESTIC + FOREIGN) ---
            var isTimeText = function (txt) {
                if (!txt) return false;
                var t = txt.trim().toLowerCase();
                return /\b(?:\d+\s*(?:sec|second|min|minute|hr|hour|day|wk|week|month|yr|year)s?\s*ago|today|yesterday|just\s*now|\d+\s*(?:am|pm))\b/i.test(t) || t.indexOf('ago') !== -1;
            };

            var locEls = el.querySelectorAll(
                '.BLbp_hdrLeft strong.BuyLdC_tltpw, .BLbp_hdrLeft strong, ' +
                '[class*="BuyLdC_time_loc"] strong, [class*="BuyLdC_time_loc"] span, ' +
                '.BLbp_hdrLeft span[class*="loc"], [class*="country_name"], [class*="location"], ' +
                '[class*="city_name"], [class*="state_name"], [class*="foreign"], .BLbp_loc, ' +
                '[class*="byr_loc"], [class*="byrLoc"]'
            );

            var locParts = [];
            for (var li = 0; li < locEls.length; li++) {
                var node = locEls[li];
                var rawText = (node.textContent || '').trim();
                if (!rawText) continue;
                // Exclude time strings
                if (isTimeText(rawText)) continue;
                var cleaned = cleanRawLocation(rawText);
                if (cleaned && cleaned.length > 1 && !isTimeText(cleaned)) {
                    if (locParts.indexOf(cleaned) === -1) {
                        locParts.push(cleaned);
                    }
                }
            }
            var location = locParts.length > 0 ? locParts.join(', ') : null;

            // --- COUNTRY EXTRACTION (DOMESTIC + FOREIGN LEADS) ---
            var countryIso = null;
            var isForeignLead = false;

            // 1) Flag image (alt, title, data-country, src)
            try {
                var flagImg = el.querySelector('img[src*="country-flags"], img[src*="flags"], img[src*="flag"], [class*="flag"] img');
                if (flagImg) {
                    var flagAlt = (flagImg.alt || flagImg.title || flagImg.getAttribute('data-country') || '').trim().toUpperCase();
                    if (/^[A-Z]{2}$/.test(flagAlt)) {
                        countryIso = flagAlt;
                    }
                    if (!countryIso && flagImg.src) {
                        var srcMatch = flagImg.src.match(/\/([a-z]{2})_flag[_s]*\.png/i) ||
                            flagImg.src.match(/\/flags?\/([a-z]{2})\./i) ||
                            flagImg.src.match(/\/flags?[_-]([a-z]{2})\./i);
                        if (srcMatch) countryIso = srcMatch[1].toUpperCase();
                    }
                }
            } catch (e) { }

            // 2) CSS Flag elements (e.g. <span class="flags flags_us">, <i class="flag flag-ae">)
            if (!countryIso) {
                try {
                    var cssFlags = el.querySelectorAll('[class*="flag"], [class*="country"]');
                    for (var cf = 0; cf < cssFlags.length; cf++) {
                        var cls = cssFlags[cf].className || '';
                        var m = cls.match(/\bflag[s]?[_-]([a-z]{2})\b/i);
                        if (m) { countryIso = m[1].toUpperCase(); break; }
                    }
                } catch (e) { }
            }

            // 3) Comprehensive Country Name Mapping
            var countryMap = {
                'india': 'IN', 'in': 'IN',
                'usa': 'US', 'united states': 'US', 'united states of america': 'US', 'america': 'US',
                'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'great britain': 'GB', 'england': 'GB',
                'uae': 'AE', 'united arab emirates': 'AE', 'dubai': 'AE', 'sharjah': 'AE', 'abu dhabi': 'AE',
                'saudi arabia': 'SA', 'saudi': 'SA', 'russia': 'RU', 'china': 'CN', 'australia': 'AU', 'canada': 'CA',
                'germany': 'DE', 'france': 'FR', 'japan': 'JP', 'brazil': 'BR', 'mexico': 'MX', 'italy': 'IT',
                'spain': 'ES', 'south korea': 'KR', 'korea': 'KR', 'netherlands': 'NL', 'south africa': 'ZA',
                'singapore': 'SG', 'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID', 'malaysia': 'MY',
                'philippines': 'PH', 'turkey': 'TR', 'egypt': 'EG', 'israel': 'IL', 'pakistan': 'PK',
                'bangladesh': 'BD', 'sri lanka': 'LK', 'nepal': 'NP', 'kuwait': 'KW', 'qatar': 'QA', 'oman': 'OM',
                'bahrain': 'BH', 'sweden': 'SE', 'switzerland': 'CH', 'poland': 'PL', 'norway': 'NO', 'denmark': 'DK',
                'finland': 'FI', 'ireland': 'IE', 'new zealand': 'NZ', 'belgium': 'BE', 'austria': 'AT', 'portugal': 'PT'
            };

            if (!countryIso && location) {
                var segments = location.toLowerCase().split(',').map(function (s) { return s.trim(); });
                for (var s = 0; s < segments.length; s++) {
                    for (var name in countryMap) {
                        if (segments[s] === name) { countryIso = countryMap[name]; break; }
                    }
                    if (countryIso) break;
                }
            }

            // 4) Check for IndiaMART Foreign Lead Badges / Text
            var cardFullText = (el.textContent || '');
            if (/\b(?:foreign\s*buylead|foreign\s*lead|export\s*buylead|international\s*buylead|overseas)\b/i.test(cardFullText) ||
                el.querySelector('[class*="foreign"], [class*="export"], [class*="international"]')) {
                isForeignLead = true;
                if (!countryIso) countryIso = 'FOREIGN';
                if (!location) location = 'Foreign';
            }

            if (!countryIso && !isForeignLead) {
                countryIso = 'UNKNOWN';
            }

            if (countryIso && countryIso !== 'IN' && countryIso !== 'UNKNOWN') {
                isForeignLead = true;
            }

            // --- CONTACT AVAILABILITY ---
            var contact = { mobile: null, email: null, phone: null };
            function availableContactNode(node) {
                if (!Core.visible(node) || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-available') === 'false') return false;
                return !/(?:unavailable|not[ _-]?available|not[ _-]?verified|missing|not provided|no[ _-]?(?:email|e-mail|phone|mobile|whatsapp)|disabled|cross)/i.test((node.textContent || '') + ' ' + (node.className || '') + ' ' + (node.title || '') + ' ' + (node.getAttribute('aria-label') || ''));
            }
            function hasContactNode(selector) { return Array.prototype.some.call(el.querySelectorAll(selector), availableContactNode); }
            var chips = el.querySelectorAll('.BLbp_chip, [class*="BLbp_chip"], [class*="chip"], [class*="tag"], [class*="badge"], [class*="Available"], [class*="SLC_aifs"], [class*="contact_channel"], [class*="byr_contact"]');
            for (var ci = 0; ci < chips.length; ci++) {
                if (!availableContactNode(chips[ci])) continue;
                var chipText = (chips[ci].textContent || chips[ci].title || chips[ci].getAttribute('aria-label') || '').toLowerCase();
                var chipClass = (chips[ci].className || '').toString().toLowerCase();
                if (chipText.indexOf('phone') !== -1 || chipText.indexOf('mobile') !== -1 || chipClass.indexOf('phone') !== -1 || chipClass.indexOf('mobile') !== -1 || chipClass.indexOf('call') !== -1) contact.mobile = 'available';
                if (chipText.indexOf('email') !== -1 || chipClass.indexOf('email') !== -1 || chipClass.indexOf('mail') !== -1) contact.email = 'available';
                if (chipText.indexOf('whatsapp') !== -1 || chipClass.indexOf('whatsapp') !== -1) contact.whatsapp = 'available';
            }
            if (!contact.whatsapp && hasContactNode('[class*="whatsapp" i], [title*="whatsapp" i], svg[class*="whatsapp" i]')) contact.whatsapp = 'available';
            // Strict contact check (random "call" class ko ignore karne ke liye)
            if (!contact.mobile && hasContactNode('.buyer_contact_no, [class*="contact_no"], [class*="phone_no"], [class*="mobile_no"], [class*="buyer_phone"], [class*="byr_contact"], [class*="contact_detail"]')) contact.mobile = 'available';
            if (!contact.email && hasContactNode('[class*="email" i], [class*="mail" i], [title*="email" i]')) contact.email = 'available';

            // Keep the buyer's explicit requirement separate from category/recommendation metadata.
            var msgEl = el.querySelector('.BLbp_desc, [class*="BuyLdC_msg"], [class*="requirement"], [class*="description"]');
            var messageText = msgEl ? (msgEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
            var mcatEl = el.querySelector('#breadcrum_pmcat_div, [id*="breadcrum"], [class*="mcat" i]');
            var mcatName = mcatEl ? (mcatEl.textContent || '').trim() : '';

            // Optional contact detail extraction (mobile numbers, emails)
            var senderMobile = null, senderEmail = null;
            try {
                var mobileEl = el.querySelector('[class*="mobile" i], [class*="phone" i], [class*="contact_no" i]');
                if (mobileEl && availableContactNode(mobileEl)) {
                    var textNodes = mobileEl.textContent.match(/\+?\d[\d\s\-]{8,}\d/g);
                    if (textNodes && textNodes.length) senderMobile = textNodes[0].replace(/\s+/g, '');
                }
                var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), textNode, visited = 0;
                while ((textNode = walker.nextNode()) && visited++ < 200 && !senderEmail) {
                    if (!availableContactNode(textNode.parentElement)) continue;
                    var emails = textNode.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                    if (emails && emails.length) senderEmail = emails[0];
                }
            } catch (e) { }
            el.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').forEach(function (link) {
                if (!availableContactNode(link)) return;
                var href = link.getAttribute('href') || '';
                if (/^tel:\+?[\d ()-]{7,30}$/.test(href)) senderMobile = senderMobile || href.slice(4);
                if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href)) senderEmail = senderEmail || href.slice(7);
            });
            if (senderMobile && !contact.mobile) contact.mobile = 'available';
            if (senderEmail && !contact.email) contact.email = 'available';

            if (!productName && !messageText && !location && !senderMobile && !senderEmail) {
                this.logger.debug('Card skipped — no searchable lead details', { leadId: leadId });
                return null;
            }

            // --- SENDER / SELLER / BUYER DETAILS ---
            var senderEl = el.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
            var senderName = senderEl ? senderEl.textContent.trim() : '';
            var buyBtn = null;

            // --- COMPOSE LEAD ---
            var subject = productName + (location ? ' - ' + location : '');

            // Build unique lead ID distinguishing seller, product, location, quantity & requirement
            // Ensures multiple leads for the exact same product from different sellers are NOT treated as duplicates
            var queryIdPart = (leadId && leadId.indexOf('hash_') === -1 && leadId.indexOf('lead_') === -1) ? leadId : '';
            var sellerPart = (senderName || senderMobile || senderEmail || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
            var prodPart = (productName || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 40);
            var locPart = (location || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
            var qtyStr = '';
            if (quantity && typeof quantity === 'object') {
                qtyStr = String(quantity.min || '') + (quantity.unit ? '_' + quantity.unit : '');
            } else if (quantity != null) {
                qtyStr = String(quantity);
            }
            var qtyPart = qtyStr.toLowerCase().replace(/[^\w]/g, '_').substring(0, 20);

            var msgHash = 0;
            if (messageText) {
                for (var mi = 0; mi < messageText.length; mi++) {
                    msgHash = ((msgHash << 5) - msgHash) + messageText.charCodeAt(mi);
                    msgHash |= 0;
                }
            }
            var msgPart = msgHash ? Math.abs(msgHash).toString(36) : '';

            var contentKey;
            if (queryIdPart) {
                contentKey = queryIdPart + '_' + prodPart + (sellerPart ? '_' + sellerPart : '');
            } else {
                contentKey = prodPart + '|' + locPart + (sellerPart ? '|' + sellerPart : '') + (qtyPart ? '|' + qtyPart : '') + (msgPart ? '|' + msgPart : '');
            }

            return {
                leadId: leadId,
                element: el,
                uniqueQueryId: Core.elementLeadId(el) || null,
                queryId: Core.elementLeadId(el) || null,
                queryType: 'BUY_LEAD',
                queryTime: new Date().toISOString(),

                productName: productName,
                leadName: productName,
                queryProductName: productName,

                senderName: senderName || null,
                sellerName: senderName || null,

                messageText: messageText,
                queryMessage: messageText,

                mcatName: mcatName || null,
                queryMcatName: mcatName || null,

                location: location,
                city: location ? location.split(',')[0].trim() : null,
                state: location ? location.split(',').pop().trim() : null,
                countryIso: countryIso,
                isForeign: isForeignLead,

                quantity: quantity,

                senderMobile: senderMobile,
                senderEmail: senderEmail,

                contact: contact,
                subject: subject,
                buyButton: buyBtn,
                raw: { element: el, button: buyBtn }
            };
        } catch (e) {
            this.logger.error('parseCard error: ' + e.message, { leadId: leadId });
            return null;
        }
    };

    Parser.prototype.normalize = function (lead) {
        if (!lead) return null;
        lead.productName = (lead.productName || '').toLowerCase();
        lead.state = (lead.state || '').toLowerCase();
        lead.city = (lead.city || '').toLowerCase();
        return lead;
    };

    // ============================================================
    // ACTION ADAPTER (EXACT TARGET + SINGLE SUBMISSION + VERIFIED OUTCOME)
    // ============================================================
    
    // ═══════════════════════════════════════════════════════════════
    // Disabled legacy backdrop entry point. Never alter portal session/authentication overlays.
    // ═══════════════════════════════════════════════════════════════
    function removeDomBackdrops() { /* Portal owns its overlays; never remove page-wide backdrops. */ }

    function ActionAdapter(popupMgr) {
        this.logger = new Logger('ActionAdapter');
        this._dryRun = false;
        this._clicked = {};
        this._inFlight = {};
        this.popupManager = popupMgr;
        this._autoMinimize = true;
        this._confirmationAnswer = 'yes';
        this._purchaseAction = 'close';
        this._timeout = 15000;
    }
    ActionAdapter.prototype.setDryRun = function (v) { this._dryRun = v; };
    ActionAdapter.prototype.setAutoMinimize = function (v) { this._autoMinimize = v; };
    ActionAdapter.prototype.setConfirmationAnswer = function (v) { this._confirmationAnswer = v; };
    ActionAdapter.prototype.setPurchaseAction = function (v) { this._purchaseAction = v; };
    ActionAdapter.prototype.setPopupTimeout = function (v) { this._timeout = v; };

    function simulateClick(el) {
        if (!el) return false;
        try {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                (el.classList && el.classList.contains('disabled'))) return false;
            var rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var eventOpts = {
                bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy, buttons: 1
            };
            // Prime portal pointer handlers, then use the browser activation path once.
            try { el.dispatchEvent(new PointerEvent('pointerdown', eventOpts)); } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mousedown', eventOpts)); } catch (e) { }
            try { if (typeof el.focus === 'function') el.focus(); } catch (e) { }
            try { el.dispatchEvent(new PointerEvent('pointerup', eventOpts)); } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mouseup', eventOpts)); } catch (e) { }
            if (typeof el.click === 'function') {
                try { el.click(); } catch (e) { return false; }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function workerMessage(message, timeoutMs) {
        return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () { if (!done) { done = true; resolve({ error: 'Worker acknowledgement timed out' }); } }, timeoutMs || 3000);
            try {
                chrome.runtime.sendMessage(message, function (response) {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    var err = chrome.runtime.lastError;
                    resolve(err ? { error: err.message } : response || { error: 'No worker acknowledgement' });
                });
            } catch (e) { clearTimeout(timer); done = true; resolve({ error: e.message }); }
        });
    }

    ActionAdapter.prototype.handleNetworkResult = function (data) {
        if (!data || !data.attemptId || !data.leadId) return;
        if (this._active && this._active.attemptId === data.attemptId && this._active.leadId === data.leadId) {
            this._active.finish(Object.assign({}, data, { verified: data.success === true || data.action === 'already_acquired', evidence: 'correlated_transaction' }));
            return;
        }
        var late = this._lateAttempts && this._lateAttempts.get(data.attemptId);
        if (late && late.uniqueQueryId === data.leadId && data.success === true) {
            this._lateAttempts.delete(data.attemptId);
            workerMessage({ action: 'ACQUISITION_COMPLETE', leadId: data.leadId, attemptId: data.attemptId, result: Object.assign({}, data, { verified: true }) });
            if (this.orchestrator) this.orchestrator._handleAcquisitionSuccess(late, Object.assign({}, data, { verified: true, evidence: 'late_correlated_transaction' }));
        }
    };

    ActionAdapter.prototype._authorizationFailure = function (lead) {
        var orch = this.orchestrator;
        if (!orch) return null;
        if (orch._shutdown || orch._isPaused || !orch.circuitBreaker.canExecute() || !orch.safety.canAcquire(lead._safetyToken).allowed || ((orch.config.mode === 'ASSISTED' || orch.config.mode === 'REVIEW') && !lead._userConfirmed)) return { action: 'cancelled', message: 'Current mode, pause or safety settings no longer authorize submission' };
        var current = orch._matchLead(lead);
        if (!current.passed || !orch._checkStrictCountry(lead).allowed || (orch._supabaseEnabled && !orch.supabase.hasFreshFilters()) || (lead.filterId && current.filterId !== lead.filterId)) return { action: 'filter_changed', message: 'Current filter no longer authorizes this exact lead' };
        return null;
    };

    ActionAdapter.prototype.acquire = async function (lead) {
        var self = this;
        if (this._dryRun) return { success: false, simulated: true, notAttempted: true, action: 'dry_run' };
        if (this._active) return { success: false, notAttempted: true, action: 'busy', message: 'Another acquisition is being verified' };
        if (!Core.activePage(window.location)) return { success: false, notAttempted: true, action: 'wrong_page', message: 'Not on an active BuyLeads feed' };
        var inquiryId = Core.id(lead.queryId || lead.uniqueQueryId);
        if (!inquiryId) return { success: false, notAttempted: true, action: 'missing_identity', message: 'No exact inquiry identity; acquisition was not attempted' };
        var timeoutMs = Math.min(60000, Math.max(1000, Number(this._timeout) || 15000));
        var attemptId = 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
        var claim = await workerMessage({ action: 'ACQUISITION_CLAIM', leadId: inquiryId, attemptId: attemptId, timeoutMs: timeoutMs });
        if (!claim.allowed) return { success: false, notAttempted: true, action: 'duplicate_or_blocked', code: claim.reason || 'PERSISTENCE_UNAVAILABLE', message: claim.error || claim.reason || 'Acquisition lease unavailable' };
        lead._attemptId = attemptId;
        var unauthorized = this._authorizationFailure(lead);
        if (unauthorized) {
            workerMessage({ action: 'ACQUISITION_COMPLETE', leadId: inquiryId, attemptId: attemptId, result: { notAttempted: true } });
            return Object.assign({ success: false, notAttempted: true }, unauthorized);
        }
        return new Promise(function (resolve) {
            var done = false;
            var initiated = false;
            var nativeInvoked = false;
            var bridgeAcknowledged = false;
            var observer = null;
            var heartbeat = null;
            var deadline = null;
            var ackTimer = null;
            var checkPending = false;
            var card = lead.element || (lead.raw && lead.raw.element) || Core.findCard(document, inquiryId);
            var clickedButton = null;
            var actedButtons = new WeakSet();
            var existingDialogs = new Set();
            var baselineCard = cardEvidence(card);
            var portalConflict = false;
            var dialogSelector = '.SLC_PopCntr, [class*="Cnt_blpack"], [role="dialog"], [role="alertdialog"]';
            Array.prototype.forEach.call(document.querySelectorAll(dialogSelector), function (el) { if (Core.visible(el)) existingDialogs.add(el); });
            var active = { attemptId: attemptId, leadId: inquiryId, finish: finish };
            self._active = active;
            if (self.orchestrator) {
                self.orchestrator._inFlightLead = lead;
                self.orchestrator._resolveInFlight = function (result) { self.handleNetworkResult(result); };
            }
            function finish(result) {
                if (done) return;
                done = true;
                if (observer) observer.disconnect();
                clearInterval(heartbeat);
                clearTimeout(deadline);
                clearTimeout(ackTimer);
                window.removeEventListener('message', onBridge);
                if (document.removeEventListener) document.removeEventListener('click', onManualClick, true);
                if (self._active === active) self._active = null;
                if (self.orchestrator && self.orchestrator._inFlightLead === lead) {
                    self.orchestrator._inFlightLead = null;
                    self.orchestrator._resolveInFlight = null;
                }
                result = Object.assign({ success: false, attemptId: attemptId, initiated: initiated }, result || {});
                if (result.success && !result.verified) { result.success = false; result.ambiguous = true; }
                if (!initiated && !nativeInvoked && bridgeAcknowledged) result.notAttempted = true;
                if (result.ambiguous && !result.notAttempted) {
                    if (!self._lateAttempts) self._lateAttempts = new Map();
                    self._lateAttempts.set(attemptId, lead);
                    while (self._lateAttempts.size > 200) self._lateAttempts.delete(self._lateAttempts.keys().next().value);
                }
                window.postMessage({ __leadsync_attempt_end__: true, attemptId: attemptId }, window.location.origin || '*');
                workerMessage({ action: 'ACQUISITION_COMPLETE', leadId: inquiryId, attemptId: attemptId, result: { success: result.success, verified: result.verified, ambiguous: result.ambiguous, action: result.action, notAttempted: result.notAttempted } });
                resolve(result);
            }
            self.cancelActive = function () {
                if (!done) finish({ success: false, ambiguous: initiated, notAttempted: !initiated && bridgeAcknowledged, action: initiated ? 'cancelled_unverified' : 'cancelled', message: 'Stopped by user; submitted actions cannot be undone' });
            };
            function onManualClick(event) {
                if (!event.isTrusted || !event.target || !event.target.closest) return;
                if (event.target.closest('#bl-safety-status, .bl-approval, .bl-top-toast')) return;
                portalConflict = true;
            }
            function cardEvidence(el) {
                if (!el || !Core.visible(el) || Core.elementLeadId(el) !== inquiryId) return { positive: false, contact: false };
                var statusNodes = el.querySelectorAll('button, a[role="button"], [role="status"], [data-status], [class*="status" i], [class*="success" i], [class*="contacted" i]');
                var text = Array.prototype.filter.call(statusNodes, Core.visible).map(function (node) { return node.textContent || node.value || ''; }).join(' ').toLowerCase();
                var positive = !/not contacted|not acquired|not sent|failed|unsuccessful/.test(text) && /\b(?:already contacted|contacted on|lead acquired|successfully purchased|enquiry sent|inquiry sent|message sent|interest sent)\b/.test(text);
                var contact = false;
                var links = el.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]');
                for (var i = 0; i < links.length; i++) {
                    var href = links[i].getAttribute('href') || '';
                    if (Core.visible(links[i]) && (/^tel:\+?[\d\s()-]{7,}$/.test(href) && href.replace(/\D/g, '').length >= 7 || /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href))) contact = true;
                }
                return { positive: positive, contact: contact, contacted: positive && /\b(?:already contacted|contacted on|enquiry sent|inquiry sent|message sent|interest sent)\b/.test(text) };
            }
            function failure(text, isDialog) {
                if (/sold out|already sold|no longer available|quota exhausted/.test(text)) return { success: false, action: 'lost_race', message: 'Lead no longer available' };
                if (/unusually high activity|request limit|please wait 15 minutes/.test(text)) return { success: false, action: 'account_blocked', code: 'RATE_LIMITED', message: 'IndiaMART request limit' };
                if (/insufficient balance|balance exhausted|recharge/.test(text) || (isDialog && /buy points|purchase buylead|per buylead|points required/.test(text))) return { success: false, action: 'account_blocked', code: 'INSUFFICIENT_BALANCE', message: 'BuyLead balance/purchase action required' };
                if (/subscription expired|subscription required|renew subscription|upgrade plan/.test(text)) return { success: false, action: 'account_blocked', code: 'SUBSCRIPTION_REQUIRED', message: 'Subscription action required' };
                return null;
            }
            function clickCardOnce() {
                if (done || initiated || nativeInvoked || !bridgeAcknowledged) return;
                var unauthorized = self._authorizationFailure(lead);
                if (unauthorized) { finish(Object.assign({ notAttempted: true }, unauthorized)); return; }
                card = Core.findCard(document, inquiryId) || card;
                if (!card || !Core.visible(card) || Core.elementLeadId(card) !== inquiryId) return;
                lead.element = card;
                var text = (card.textContent || '').toLowerCase();
                var rejected = failure(text);
                if (rejected) { finish(Object.assign(rejected, { notAttempted: true })); return; }
                baselineCard = cardEvidence(card);
                if (baselineCard.positive) { finish({ success: false, action: 'already_acquired', notAttempted: true, verified: true, message: 'Exact lead is already contacted' }); return; }
                var buttons = card.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"], [class*="BuyLdC_cta"]');
                for (var i = 0; i < buttons.length; i++) {
                    var label = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase().replace(/\s+/g, ' ');
                    if (/^(?:contact buyers?(?: now)?|contact now|connect (?:with )?buyer|connect now|view (?:contact|number|buyer)|call buyer|send enquiry|i am interested|interested|send interest|reply now)$/.test(label) && Core.visible(buttons[i]) && !buttons[i].disabled && buttons[i].getAttribute('aria-disabled') !== 'true') { clickedButton = buttons[i]; break; }
                }
                if (!clickedButton) return;
                // Snapshot and subscribe before the sole CTA activation. No 20ms native/DOM race.
                initiated = true;
                if (!simulateClick(clickedButton)) { initiated = false; finish({ notAttempted: true, action: 'click_failed', message: 'Exact lead CTA could not be activated' }); return; }
                if (self.orchestrator && !lead._initiationCounted) { lead._initiationCounted = true; self.orchestrator.stats.initiated++; }
                self.logger.info('action.request.started', { context: { leadId: inquiryId, route: 'DOM' }, operationId: attemptId });
                scheduleCheck();
            }
            function onBridge(event) {
                if (event.source !== window || !event.data || (event.origin && event.origin !== window.location.origin)) return;
                var data = event.data;
                if (!data.__leadsync_dispatch_result__ || data.attemptId !== attemptId || data.leadId !== inquiryId) return;
                clearTimeout(ackTimer);
                bridgeAcknowledged = true;
                nativeInvoked = data.invoked === true;
                if (nativeInvoked) {
                    initiated = true;
                    if (self.orchestrator && !lead._initiationCounted) { lead._initiationCounted = true; self.orchestrator.stats.initiated++; }
                    self.logger.info('action.request.started', { context: { leadId: inquiryId, route: 'NATIVE_VERIFIED_CTA' }, operationId: attemptId });
                } else if (data.reason === 'NATIVE_UNAVAILABLE') clickCardOnce();
                else finish({ notAttempted: true, action: 'bridge_rejected', message: data.reason || 'Page bridge rejected the action' });
            }
            function check() {
                checkPending = false;
                if (done) return;
                if (!Core.activePage(window.location)) { finish({ ambiguous: initiated, action: 'page_changed', message: 'Portal navigated during acquisition' }); return; }
                if (!initiated) { clickCardOnce(); return; }
                card = Core.findCard(document, inquiryId) || card;
                if (card && Core.elementLeadId(card) === inquiryId) {
                    var rejected = failure((card.textContent || '').toLowerCase());
                    if (rejected) { finish(rejected); return; }
                    var evidence = cardEvidence(card);
                    if ((!baselineCard.positive && evidence.positive) || (!baselineCard.contact && evidence.contact)) {
                        finish({ success: true, verified: true, acquisitionSuccess: true, contactSuccess: evidence.contacted, evidence: 'exact_card_transition', action: 'card_updated', message: 'Exact lead acquired state changed' }); return;
                    }
                }
                var dialogs = document.querySelectorAll(dialogSelector);
                for (var i = 0; i < dialogs.length; i++) {
                    var dialog = dialogs[i];
                    if (existingDialogs.has(dialog) || !Core.visible(dialog) || (dialog.id && dialog.id.indexOf('bl') === 0) || portalConflict) continue;
                    var dialogId = Core.elementLeadId(dialog);
                    if (dialogId && dialogId !== inquiryId) continue;
                    var text = (dialog.textContent || '').toLowerCase();
                    var error = failure(text, true);
                    if (error) {
                        if (self._purchaseAction === 'close') {
                            var close = dialog.querySelector('[aria-label="Close"], button[class*="close"], .SLC_pa.SLC_cp');
                            if (close) simulateClick(close);
                        }
                        finish(error); return;
                    }
                    var unauthorized = self._authorizationFailure(lead);
                    if (unauthorized) { finish(Object.assign({ ambiguous: true }, unauthorized)); return; }
                    var options = dialog.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[role="button"], .SLC_FillCTA');
                    for (var b = 0; b < options.length; b++) {
                        var button = options[b];
                        var label = (button.textContent || button.value || '').trim().toLowerCase();
                        var allowed = self._confirmationAnswer === 'no' ? /^(no|cancel|skip)$/ : /^(yes|ok|confirm|proceed|continue|accept|contact buyer(?: now)?|send(?: enquiry| reply| message| quotation| now)?|submit(?: enquiry| interest)?|reply)$/;
                        if (!allowed.test(label) || actedButtons.has(button) || !Core.visible(button) || button.disabled) continue;
                        var input = dialog.querySelector('textarea, input[name*="requirement"], input[name*="enquiry"]');
                        if (input && !input.value && self._confirmationAnswer !== 'no') {
                            var proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype : window.HTMLInputElement && window.HTMLInputElement.prototype;
                            var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
                            if (setter && setter.set) setter.set.call(input, 'Interested in your requirement. Please share further details.'); else input.value = 'Interested in your requirement. Please share further details.';
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        actedButtons.add(button);
                        simulateClick(button);
                        if (self._confirmationAnswer === 'no') { finish({ success: false, action: 'cancelled', message: 'Confirmation declined by configured preference' }); return; }
                        // A Send/Confirm click is an intermediate step. Continue observing until verified or timeout.
                        self.logger.debug('action.confirmation.submitted', { operationId: attemptId, context: { leadId: inquiryId } });
                        break;
                    }
                }
            }
            function scheduleCheck() {
                if (checkPending || done) return;
                checkPending = true;
                Promise.resolve().then(check);
            }
            if (card && Core.elementLeadId(card) === inquiryId && Core.visible(card)) {
                var initialFailure = failure((card.textContent || '').toLowerCase());
                if (initialFailure || baselineCard.positive) {
                    bridgeAcknowledged = true;
                    finish(initialFailure ? Object.assign(initialFailure, { notAttempted: true }) : { action: 'already_acquired', verified: true, notAttempted: true, message: 'Exact lead is already acquired' });
                    return;
                }
            }
            window.addEventListener('message', onBridge);
            if (document.addEventListener) document.addEventListener('click', onManualClick, true);
            if (typeof MutationObserver !== 'undefined') {
                observer = new MutationObserver(scheduleCheck);
                observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-lead-id', 'data-query-id', 'data-blid', 'data-uqid', 'class', 'style', 'disabled', 'href'] });
            }
            heartbeat = setInterval(check, 250);
            deadline = setTimeout(function () { finish({ success: false, ambiguous: initiated || !bridgeAcknowledged, notAttempted: !initiated && bridgeAcknowledged, action: initiated ? 'timeout_unverified' : 'target_not_available', message: initiated ? 'Acquisition timed out without authoritative confirmation' : 'No verified native route or exact rendered lead CTA' }); }, timeoutMs);
            ackTimer = setTimeout(function () { finish({ success: false, ambiguous: true, action: 'bridge_timeout', message: 'Native dispatch acknowledgement missing; no fallback was submitted' }); }, Math.min(2000, timeoutMs));
            window.postMessage({ __leadsync_dispatch_lead__: true, leadId: inquiryId, attemptId: attemptId, native: true }, window.location.origin || '*');
        });
    };

    // ============================================================
    // SCORER
    // ============================================================
    function LeadScorer() {
        this.minimumScore = 60;
        this.weights = {
            base: 50, perProductKeyword: 10, maxProductBonus: 30,
            preferredState: 15, countryMatch: 15,
            hasMobile: 10, hasEmail: 8, hasPhone: 5,
            detailedRequirement: 5, requirementLengthThreshold: 100
        };
        this.penalties = { wrongCountry: -20, wrongState: -10, noContact: -5 };
        this.preferredStates = ['maharashtra'];
        this.preferredCountries = ['IN'];
    }
    LeadScorer.prototype.setWeights = function (weights) {
        if (!weights) return;
        for (var k in weights) if (weights.hasOwnProperty(k) && this.weights.hasOwnProperty(k)) this.weights[k] = weights[k];
    };
    LeadScorer.prototype.setPenalties = function (penalties) {
        if (!penalties) return;
        for (var k in penalties) if (penalties.hasOwnProperty(k) && this.penalties.hasOwnProperty(k)) this.penalties[k] = penalties[k];
    };
    LeadScorer.prototype.setPreferredStates = function (states) {
        if (Array.isArray(states)) this.preferredStates = states.map(function (s) { return String(s).toLowerCase().trim(); });
    };
    LeadScorer.prototype.setPreferredCountries = function (countries) {
        if (Array.isArray(countries)) this.preferredCountries = countries.map(function (c) { return String(c).toUpperCase().trim(); });
    };
    function validMinScore(value) {
        var n = Number(value);
        return Number.isFinite(n) && value !== null && value !== '' ? Math.min(100, Math.max(0, n)) : DEFAULT_CONFIG.minScore;
    }
    LeadScorer.prototype.setMinimumScore = function (s) { this.minimumScore = validMinScore(s); };
    LeadScorer.prototype.evaluate = function (lead, match) {
        var weights = this.weights, penalties = this.penalties, reasons = [];
        var score = Number(weights.base) || 0;
        function add(name, amount) { amount = Number(amount) || 0; score += amount; if (amount) reasons.push({ rule: name, points: amount }); }
        add('product_keywords', Math.min(Number(weights.maxProductBonus) || 0, (match.matchedProducts || []).length * (Number(weights.perProductKeyword) || 0)));
        var iso = Core.countryFromLead(lead);
        if (iso && this.preferredCountries.length) add('preferred_country', this.preferredCountries.some(function (value) { return Core.country(value) === iso; }) ? weights.countryMatch : penalties.wrongCountry);
        var state = normalizeText(lead.state || '');
        if (state && this.preferredStates.length) add('preferred_state', this.preferredStates.some(function (value) { return wordBoundaryMatch(state, normalizeText(value)); }) ? weights.preferredState : penalties.wrongState);
        var contact = lead.contact || {};
        var mobile = Core.available(contact.mobile) || Core.available(lead.hasMobile) || Core.available(lead.senderMobile), email = Core.available(contact.email) || Core.available(lead.hasEmail) || Core.available(lead.senderEmail), phone = Core.available(contact.phone) || Core.available(lead.hasPhone) || Core.available(lead.senderPhone);
        if (mobile) add('mobile_available', weights.hasMobile);
        if (email) add('email_available', weights.hasEmail);
        if (phone) add('phone_available', weights.hasPhone);
        if (!mobile && !email && !phone) add('no_contact', penalties.noContact);
        if ((lead.messageText || '').length >= (Number(weights.requirementLengthThreshold) || 100)) add('detailed_requirement', weights.detailedRequirement);
        score = Math.min(100, Math.max(0, score));
        return { passed: score >= this.minimumScore, reason: score >= this.minimumScore ? null : 'score_below_minimum', score: score, pointsDistribution: reasons };
    };

    // ============================================================
    // CENTRALIZED PERFORMANCE METRICS SERVICE (v6.3 - GRAVITAS)
    // ============================================================
    function PerformanceMetrics() {
        this._activeFiltersCount = 0;
        this._detections = new Map(); // leadId -> timestamp
        this._matches = new Map();    // leadId -> timestamp
        this._currentCycleId = 'cycle_' + Date.now();
        this._attempts = 0;           // total eligible acquisition attempts
        this._acquisitions = [];      // [{ leadId, durationMs, timestamp }]
        this._failedAttempts = 0;
        this._contacts = [];          // [{ leadId, durationMs, timestamp }]
        this._failedContacts = 0;
        this._completedResults = new Map();
        this._completedAttempts = 0;
        this._completedSuccesses = 0; // successfully acquired AND contacted leads
        this._sampleLimit = 20;
    }

    PerformanceMetrics.prototype.resetCycle = function (cycleId) {
        this._currentCycleId = cycleId || ('cycle_' + Date.now());
        this._acquisitions = [];
        this._attempts = 0;
        this._failedAttempts = 0;
        this._contacts = [];
        this._failedContacts = 0;
        this._completedResults = new Map();
        this._completedAttempts = 0;
        this._completedSuccesses = 0;
    };

    PerformanceMetrics.prototype.recordLeadAttemptCompleted = function (attemptId, success) {
        if (!this._completedResults) this._completedResults = new Map();
        if (this._completedResults.has(attemptId)) {
            if (!this._completedResults.get(attemptId) && success) {
                this._completedResults.set(attemptId, true);
                this._completedSuccesses++;
                this._failedAttempts = Math.max(0, this._failedAttempts - 1);
            }
            return;
        }
        this._completedResults.set(attemptId, success === true);
        while (this._completedResults.size > 5000) this._completedResults.delete(this._completedResults.keys().next().value);
        this._completedAttempts = (this._completedAttempts || 0) + 1;
        if (success) this._completedSuccesses = (this._completedSuccesses || 0) + 1;
    };

    PerformanceMetrics.prototype.setActiveFiltersCount = function (count) {
        this._activeFiltersCount = Math.max(0, parseInt(count, 10) || 0);
    };

    PerformanceMetrics.prototype.getActiveFiltersCount = function () {
        return this._activeFiltersCount;
    };

    PerformanceMetrics.prototype.recordDetection = function (leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (!this._detections.has(leadId)) {
            this._detections.set(leadId, t);
        }
    };

    PerformanceMetrics.prototype.recordMatch = function (leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this._matches.set(leadId, t);
    };

    PerformanceMetrics.prototype.recordAcquisitionAttempt = function (leadId) {
        this._attempts++;
    };

    PerformanceMetrics.prototype.recordAcquisitionSuccess = function (leadId, timestamp) {
        var now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var detectedAt = this._detections.get(leadId) || (this._matches ? this._matches.get(leadId) : null);
        var durationMs = detectedAt ? Math.max(0, now - detectedAt) : 0;
        if (durationMs > 0) this._lastDurationMs = durationMs;

        this._acquisitions.push({
            leadId: leadId,
            durationMs: durationMs,
            timestamp: Date.now()
        });

        if (this._acquisitions.length > 50) {
            this._acquisitions.shift();
        }
        this._detections.delete(leadId);
    };

    PerformanceMetrics.prototype.recordAcquisitionFailure = function (leadId, reason) {
        this._failedAttempts++;
        this._detections.delete(leadId);
    };

    PerformanceMetrics.prototype.recordContactSuccess = function (leadId, timestamp) {
        var now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var matchedAt = this._matches.get(leadId) || now;
        var durationMs = Math.max(0, now - matchedAt);

        this._contacts.push({
            leadId: leadId,
            durationMs: durationMs,
            timestamp: Date.now()
        });
        if (this._contacts.length > 50) this._contacts.shift();
        this._matches.delete(leadId);
    };

    PerformanceMetrics.prototype.recordContactFailure = function (leadId, reason) {
        this._failedContacts++;
        this._matches.delete(leadId);
    };

    PerformanceMetrics.prototype.getSpeedPerAcquisition = function () {
        if (this._acquisitions.length === 0) {
            return {
                hasData: false,
                avgMs: 0,
                lastMs: 0,
                averageMs: null,
                formatted: '0s',
                formattedAvg: '0s',
                formattedLast: '0s',
                text: '0s',
                sampleCount: 0,
                sampleSize: 0
            };
        }
        var sample = this._acquisitions.slice(-this._sampleLimit);
        var total = 0;
        for (var i = 0; i < sample.length; i++) {
            total += sample[i].durationMs;
        }
        var avgMs = Math.round(total / sample.length);
        var lastMs = Math.round(sample[sample.length - 1].durationMs);
        var formatted = avgMs < 1000 ? (avgMs + 'ms') : ((avgMs / 1000).toFixed(1) + 's');
        var formattedLast = lastMs < 1000 ? (lastMs + 'ms') : ((lastMs / 1000).toFixed(1) + 's');
        return {
            hasData: true,
            avgMs: avgMs,
            lastMs: lastMs,
            averageMs: avgMs,
            formatted: formatted,
            formattedAvg: formatted,
            formattedLast: formattedLast,
            text: formatted,
            sampleCount: sample.length,
            sampleSize: sample.length
        };
    };

    PerformanceMetrics.prototype.getAcceptanceRate = function () {
        var totalAttempts = this._completedAttempts || this._attempts;
        if (totalAttempts === 0) {
            return {
                hasData: false,
                percentage: 0,
                ratePercent: 0,
                successful: 0,
                successes: 0,
                attempts: 0,
                formatted: '0%',
                text: '0%'
            };
        }
        var successes = this._completedSuccesses !== undefined && this._completedAttempts ? this._completedSuccesses : this._acquisitions.length;
        var rate = (successes / totalAttempts) * 100;
        var pct = Math.min(100, Math.max(0, rate));
        var rounded = Math.round(pct * 10) / 10;
        return {
            hasData: true,
            percentage: parseFloat(rounded.toFixed(1)),
            ratePercent: rounded,
            successful: successes,
            successes: successes,
            attempts: totalAttempts,
            formatted: rounded.toFixed(1) + '%',
            text: rounded.toFixed(1) + '%'
        };
    };

    PerformanceMetrics.prototype.getSummary = function () {
        var speed = this.getSpeedPerAcquisition();
        var acc = this.getAcceptanceRate();
        return {
            activeFilters: this.getActiveFiltersCount(),
            speedFormatted: speed.formatted,
            speedAverageMs: speed.averageMs,
            speedSampleCount: speed.sampleCount,
            acceptanceRateFormatted: acc.formatted,
            acceptanceRatePercent: acc.ratePercent,
            attempts: acc.attempts,
            successes: acc.successes
        };
    };

    PerformanceMetrics.prototype.exportState = function () {
        return {
            acquisitions: this._acquisitions ? this._acquisitions.slice(-50) : [],
            contacts: this._contacts ? this._contacts.slice(-50) : [],
            attempts: this._attempts || 0,
            failedAttempts: this._failedAttempts || 0,
            contactsCount: (this._contacts && this._contacts.length) || 0,
            failedContacts: this._failedContacts || 0,
            completedResults: Array.from((this._completedResults || new Map()).entries()).slice(-5000),
            completedAttempts: this._completedAttempts || 0,
            completedSuccesses: this._completedSuccesses || 0,
            lastDurationMs: this._lastDurationMs || 0
        };
    };

    PerformanceMetrics.prototype.importState = function (state) {
        if (!state || typeof state !== 'object') return;
        if (Array.isArray(state.acquisitions)) this._acquisitions = state.acquisitions;
        if (Array.isArray(state.contacts)) this._contacts = state.contacts;
        if (typeof state.attempts === 'number') this._attempts = state.attempts;
        if (typeof state.failedAttempts === 'number') this._failedAttempts = state.failedAttempts;
        if (typeof state.failedContacts === 'number') this._failedContacts = state.failedContacts;
        if (Array.isArray(state.completedResults)) this._completedResults = new Map(state.completedResults);
        if (typeof state.completedAttempts === 'number') this._completedAttempts = state.completedAttempts;
        if (typeof state.completedSuccesses === 'number') this._completedSuccesses = state.completedSuccesses;
        if (typeof state.lastDurationMs === 'number') this._lastDurationMs = state.lastDurationMs;
    };

    // ============================================================
    // LEAD LIFECYCLE & VERIFIED TERMINAL STATES (v6.3 - GRAVITAS)
    // ============================================================
    var LEAD_STATES = {};
    ['DETECTED', 'MATCHED', 'READY_FOR_REVIEW', 'MONITORED', 'DRY_RUN', 'ACQUISITION_PENDING', 'ACQUIRED', 'CONTACT_PENDING', 'CONTACTED', 'ACQUISITION_FAILED', 'CONTACT_FAILED', 'RETRY_SCHEDULED', 'BLOCKED', 'SKIPPED', 'UNKNOWN', 'UNAVAILABLE', 'ALREADY_ACQUIRED', 'NOT_ATTEMPTED'].forEach(function (state) { LEAD_STATES[state] = state; });
    var VALID_TRANSITIONS = {
        DETECTED: ['MATCHED', 'SKIPPED', 'BLOCKED'],
        MATCHED: ['READY_FOR_REVIEW', 'MONITORED', 'DRY_RUN', 'ACQUISITION_PENDING', 'SKIPPED', 'BLOCKED'],
        READY_FOR_REVIEW: ['ACQUISITION_PENDING', 'SKIPPED', 'BLOCKED'],
        MONITORED: ['MATCHED', 'ACQUISITION_PENDING', 'SKIPPED'], DRY_RUN: ['MATCHED', 'ACQUISITION_PENDING', 'SKIPPED'],
        ACQUISITION_PENDING: ['ACQUIRED', 'ALREADY_ACQUIRED', 'ACQUISITION_FAILED', 'BLOCKED', 'UNKNOWN', 'UNAVAILABLE', 'NOT_ATTEMPTED', 'RETRY_SCHEDULED'],
        ACQUIRED: ['CONTACT_PENDING', 'CONTACTED', 'CONTACT_FAILED'], CONTACT_PENDING: ['CONTACTED', 'CONTACT_FAILED', 'RETRY_SCHEDULED'],
        RETRY_SCHEDULED: ['ACQUISITION_PENDING', 'CONTACT_PENDING', 'BLOCKED', 'SKIPPED'],
        ACQUISITION_FAILED: ['RETRY_SCHEDULED', 'BLOCKED', 'SKIPPED', 'ACQUIRED'], CONTACT_FAILED: ['RETRY_SCHEDULED', 'BLOCKED', 'SKIPPED'],
        NOT_ATTEMPTED: ['DETECTED', 'MATCHED', 'ACQUISITION_PENDING', 'SKIPPED', 'BLOCKED', 'ACQUIRED'],
        UNKNOWN: ['ACQUIRED', 'ALREADY_ACQUIRED', 'SKIPPED'], UNAVAILABLE: [], ALREADY_ACQUIRED: [], CONTACTED: [], BLOCKED: ['RETRY_SCHEDULED'], SKIPPED: []
    };

    function LeadLifecycleManager() {
        this._states = new Map();
        this._inFlight = new Set();
    }

    LeadLifecycleManager.prototype.getState = function (leadId) {
        var entry = this._states.get(leadId);
        return entry ? entry.state : null;
    };

    LeadLifecycleManager.prototype.transition = function (leadId, newState, meta) {
        if (!leadId) return { ok: false, error: 'missing_lead_id' };
        if (!LEAD_STATES[newState]) return { ok: false, error: 'invalid_target_state: ' + newState };

        var currentEntry = this._states.get(leadId);
        var currentState = currentEntry ? currentEntry.state : null;

        if (!currentState) {
            if (newState !== LEAD_STATES.DETECTED) {
                return { ok: false, error: 'Initial state must be DETECTED, got ' + newState };
            }
            this._states.set(leadId, {
                state: newState,
                history: [{ state: newState, at: Date.now(), meta: meta || {} }],
                updatedAt: Date.now()
            });
            return { ok: true, previousState: null, currentState: newState };
        }

        if (currentState === newState) {
            return { ok: true, previousState: currentState, currentState: newState, noop: true };
        }

        var allowed = VALID_TRANSITIONS[currentState] || [];
        var verifiedPromotion = newState === LEAD_STATES.ACQUIRED && ['CONTACTED', 'ALREADY_ACQUIRED'].indexOf(currentState) === -1;
        if (!verifiedPromotion && allowed.indexOf(newState) === -1) {
            return {
                ok: false,
                error: 'Illegal state transition from ' + currentState + ' to ' + newState
            };
        }

        if (newState === LEAD_STATES.ACQUISITION_PENDING || newState === LEAD_STATES.CONTACT_PENDING) {
            this._inFlight.add(leadId);
        } else if (['ACQUIRED', 'CONTACTED', 'ACQUISITION_FAILED', 'CONTACT_FAILED', 'SKIPPED', 'BLOCKED', 'UNKNOWN', 'UNAVAILABLE', 'ALREADY_ACQUIRED', 'MONITORED', 'DRY_RUN', 'NOT_ATTEMPTED'].indexOf(newState) !== -1) {
            this._inFlight.delete(leadId);
        }

        currentEntry.history.push({ state: newState, at: Date.now(), meta: meta || {} });
        currentEntry.state = newState;
        currentEntry.updatedAt = Date.now();

        return { ok: true, previousState: currentState, currentState: newState };
    };

    LeadLifecycleManager.prototype.isInFlight = function (leadId) {
        return this._inFlight.has(leadId);
    };

    LeadLifecycleManager.prototype.getSummary = function () {
        var counts = {};
        this._states.forEach(function (val) {
            counts[val.state] = (counts[val.state] || 0) + 1;
        });
        return {
            totalTracked: this._states.size,
            inFlightCount: this._inFlight.size,
            counts: counts
        };
    };

    var SCANNER_STATES = {
        IDLE: 'IDLE',
        PAUSED: 'PAUSED',
        INITIALIZING: 'INITIALIZING',
        SCANNING: 'SCANNING'
    };

    // ORCHESTRATOR — network-first discovery with one serialized, verified action path.
    function Orchestrator() {
        this.logger = new Logger('Orchestrator');
        var manifestVersion = null;
        try { manifestVersion = chrome.runtime.getManifest().version; } catch (e) { }
        this.logger.info('🚀 Initializing v5.1.0 (Lead-Monitoring & Review Assistant)', {
            instanceId: _initInfo.instanceId, reason: _initInfo.reason,
            bundleVersion: '5.1.0', manifestVersion: manifestVersion
        });

        this.circuitBreaker = new CircuitBreaker();
        this.supabase = new window.SupabaseService();
        this.supabase.setLogger(this.logger);

        this.safety = new SafetyController(this.circuitBreaker);
        this.stateMachine = new LeadStateMachine();
        this.queue = new LeadQueue();
        this.duplicateManager = new DuplicateManager(this.supabase);
        this.keywordManager = new KeywordManager();
        this.keywordManager.orchestrator = this;
        this.scanner = new Scanner();
        this.scanner.orchestrator = this;
        this.parser = new Parser();
        this.popupManager = new PopupManager();
        this.actionAdapter = new ActionAdapter(this.popupManager);
        this.actionAdapter.orchestrator = this;
        this._reviewLeads = new Map();
        this.scorer = new LeadScorer();
        this.navigator = new PageNavigator(this);
        this.metrics = new PerformanceMetrics();
        this.lifecycle = new LeadLifecycleManager();

        this.stats = {
            initiated: 0,
            discovered: 0, parsed: 0, validated: 0, scored: 0,
            queued: 0, acquired: 0, rejected: 0, duplicate: 0, failed: 0,
            countryBlocked: 0, unique: 0, filtered: 0, contactFailed: 0,
            dbSynced: 0, popupsHandled: 0, loopsCompleted: 0, loadMoreClicks: 0,
            cycleScanned: 0
        };

        // Session acquisition log (stores verified matched leads & acquisition outcomes for the entire session without trimming)
        this._sessionAcquisitions = [];
        try {
            var rawAcq = sessionStorage.getItem('bl_session_acquisitions');
            if (rawAcq) {
                var parsedAcq = JSON.parse(rawAcq);
                if (Array.isArray(parsedAcq)) {
                    this._sessionAcquisitions = parsedAcq;
                }
            }
        } catch (e) { }

        var selfAcqLog = this;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['bl_session_acquisitions', 'session_acquisition_logs'], function (res) {
                    var list = res && (res.bl_session_acquisitions || res.session_acquisition_logs);
                    if (Array.isArray(list) && list.length > 0) {
                        if (selfAcqLog._sessionAcquisitions.length === 0) {
                            selfAcqLog._sessionAcquisitions = list;
                        } else {
                            var seenIds = new Set(selfAcqLog._sessionAcquisitions.map(function (x) { return x.id || x.uniqueQueryId; }));
                            for (var li = 0; li < list.length; li++) {
                                var item = list[li];
                                var key = item.id || item.uniqueQueryId;
                                if (!seenIds.has(key)) {
                                    seenIds.add(key);
                                    selfAcqLog._sessionAcquisitions.push(item);
                                }
                            }
                        }
                        try { sessionStorage.setItem('bl_session_acquisitions', JSON.stringify(selfAcqLog._sessionAcquisitions)); } catch (e) { }
                    }
                });
            }
        } catch (e) { }

        this._uniqueSeenIds = new Set();
        // Restore session stats across auto-reloads
        try {
            var reloadFlag = sessionStorage.getItem('bl_last_reload_flag');
            var reloadPending = sessionStorage.getItem('bl_reload_pending');
            var isFromReload = (reloadFlag === 'from_reload') || (reloadPending === 'true');

            if (isFromReload) {
                // Clear reload-pending flags safely now that extension is restarting
                sessionStorage.removeItem('bl_reload_pending');
                sessionStorage.removeItem('bl_last_reload_flag');

                var savedStats = sessionStorage.getItem('bl_session_stats');
                if (savedStats) {
                    var parsed = JSON.parse(savedStats);
                    if (parsed && typeof parsed === 'object') {
                        Object.assign(this.stats, parsed);
                    }
                }
                var savedSeen = sessionStorage.getItem('bl_session_seen_ids');
                if (savedSeen) {
                    var parsedSeen = JSON.parse(savedSeen);
                    if (Array.isArray(parsedSeen)) {
                        for (var sIdx = 0; sIdx < parsedSeen.length; sIdx++) {
                            this._uniqueSeenIds.add(parsedSeen[sIdx]);
                        }
                        this.stats.discovered = Math.max(this.stats.discovered || 0, this._uniqueSeenIds.size);
                        this.stats.unique = this._uniqueSeenIds.size;
                    }
                }
                var savedMetrics = sessionStorage.getItem('bl_session_metrics');
                if (savedMetrics && this.metrics && typeof this.metrics.importState === 'function') {
                    try {
                        this.metrics.importState(JSON.parse(savedMetrics));
                    } catch (e) { }
                }
                var autoResume = sessionStorage.getItem('bl_scanner_auto_resume');
                if (autoResume === 'false') {
                    this._isPaused = true;
                }
            } else {
                sessionStorage.removeItem('bl_session_stats');
                sessionStorage.removeItem('bl_session_seen_ids');
                sessionStorage.removeItem('bl_session_metrics');
                sessionStorage.removeItem('bl_scanner_auto_resume');
                sessionStorage.removeItem('bl_auto_reload_count');
                sessionStorage.removeItem('bl_reload_pending');
                sessionStorage.removeItem('bl_last_reload_flag');
            }
        } catch (e) { }
        // Only force-clear isPaused if this is NOT a post-reload resume where the
        // autoResume flag explicitly asked us to stay paused.
        if (this._isPaused !== true) {
            this._isPaused = false;
        }
        this._scannerState = SCANNER_STATES.IDLE;
        this._currentCycleId = 'cycle_' + Date.now();
        this._currentCycleSeenLeads = new Set();
        this._pendingNetworkLeadCards = new Map();
        this._acquiredLeadIds = new Set();
        this._acquiredRecords = [];
        var selfAcq = this;
        this._acquiredReady = new Promise(function (resolve) {
        try {
            chrome.storage.local.get(['acquiredLeadIds', 'acquiredRecords'], function (res) {
                if (res && Array.isArray(res.acquiredLeadIds)) {
                    res.acquiredLeadIds.forEach(function (id) { selfAcq._acquiredLeadIds.add(String(id)); });
                }
                if (res && Array.isArray(res.acquiredRecords)) {
                    selfAcq._acquiredRecords = res.acquiredRecords;
                }
                resolve();
            });
        } catch (e) { selfAcq._isPaused = true; resolve(); }
        });

        this.config = Object.assign({}, DEFAULT_CONFIG);
        this._initialized = false;
        this._observedLeads = new Map(); // Filter notifications can arrive before the first lead.
        this._startupState = 'LOADING_CONFIG';
        this._bridgeReady = false;
        this._statsTimer = null;
        this._cleanupTimer = null;
        this._statusPanelTimer = null;
        this._supabaseEnabled = true;
        this._initTime = Date.now();
        this._syncRetryAttempt = 0;
        this._syncRetryNextAt = 0;
        this._refreshCountdownSeconds = 10;
        this._refreshCountdownCurrent = 10;
        this._refreshCountdownTimer = null;
        this._refreshSafetyGateTimer = null;
        this._tcpKeepAliveTimer = null;
        this._lastKeepAlivePing = 0;

        var self = this;
        this.logger.logEvent({ level: 'INFO', event: 'app.initialization.started', reasonCode: 'CONTENT_SCRIPT_LOADED', context: { documentState: document.readyState } });
        this._loadConfig().then(function () { self._init(); }).catch(function (err) { self._failInitialization(err); });
    }

    Orchestrator.prototype._failInitialization = function (err) {
        this._startupState = 'FAILED';
        this._initialized = false;
        this._isPaused = true;
        if (this.queue) this.queue.pause();
        if (this.scanner) this.scanner.stopWatching();
        if (this._bridgeTimer) clearTimeout(this._bridgeTimer);
        this.logger.logEvent({ level: 'ERROR', event: 'app.initialization.failed', reasonCode: 'STARTUP_ERROR', error: err && err.message || String(err) });
        _flushLogsNow();
    };

    Orchestrator.prototype._loadConfig = function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            chrome.storage.local.get(DEFAULT_CONFIG, function (c) { try {
                self.config = Object.assign({}, DEFAULT_CONFIG, c);
                if (c.scoreWeights) self.config.scoreWeights = Object.assign({}, DEFAULT_CONFIG.scoreWeights, c.scoreWeights);
                if (c.scorePenalties) self.config.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, c.scorePenalties);

                if (['MONITOR', 'DRY_RUN', 'ASSISTED', 'AUTOMATIC', 'REVIEW'].indexOf(self.config.mode) === -1) self.config.mode = 'MONITOR';
                self.keywordManager.matcher.minConfidenceScore = validMinScore(self.config.minScore);
                self.config.minScore = self.keywordManager.matcher.minConfidenceScore;
                self.config.strictCountryMode = self.config.strictCountryMode === true;
                self.config.allowedCountries = (self.config.allowedCountries || ['IN']).map(function (x) {
                    return String(x).toUpperCase().trim();
                }).filter(function (x) { return x; });
                self.config.strictCountryRejectUnknown = self.config.strictCountryRejectUnknown !== false;

                self._supabaseEnabled = self.config.supabaseEnabled !== false;
                self._isPaused = c.automationPaused === true;
                if (self.supabase.setClientId) self.supabase.setClientId(c.supabaseClientId || null);
                self._savedPanelPosition = self.config.panelPosition;
                self._panelCollapsed = self.config.panelCollapsed || false;

                // Stop Sold (persisted setting, shared with skipSoldOut alias)
                if (c.stopSold !== undefined) {
                    self.config.stopSold = !!c.stopSold;
                } else if (c.skipSoldOut !== undefined) {
                    self.config.stopSold = !!c.skipSoldOut;
                } else {
                    self.config.stopSold = true;
                }
                self.config.skipSoldOut = self.config.stopSold;

                self.safety.setLimits({
                    perMinute: self.config.maxPerMinute,
                    perHour: self.config.maxPerHour,
                    perDay: self.config.maxPerDay,
                    perSession: self.config.maxPerSession
                });
                self.safety.setMode(self.config.mode);
                self.safety.setCooldown(self.config.cooldownMs);

                self.actionAdapter.setDryRun(self.config.mode === 'DRY_RUN');
                self.actionAdapter.setAutoMinimize(self.config.autoMinimize);
                self.actionAdapter.setConfirmationAnswer(self.config.confirmationAnswer);
                self.actionAdapter.setPurchaseAction(self.config.purchaseAction);
                self.actionAdapter.setPopupTimeout(self.config.popupTimeoutMs);

                self.scorer.setMinimumScore(self.config.minScore);
                self.scorer.setWeights(self.config.scoreWeights);
                self.scorer.setPenalties(self.config.scorePenalties);
                self.scorer.setPreferredStates(self.config.preferredStates);
                self.scorer.setPreferredCountries(self.config.preferredCountries);

                // In live browser, hard reloads are completely removed to protect real-time API interception.
                self.config.autoReloadOnComplete = false;
                self.navigator.applySettings(self.config);
                self.keywordManager.setSupabaseEnabled(self._supabaseEnabled);

                resolve();
            } catch (err) { reject(err); } });
        });
    };
    Orchestrator.prototype._init = function () {
        var self = this;
        if (this._initializing || this._shutdown) return;
        this._initializing = true;
        if (this.supabase.onFiltersChanged) this._unsubscribeFilters = this.supabase.onFiltersChanged(function (filters) { self._applyFilters(filters); });
        this._startupState = 'WAITING_FOR_DOM_AND_STATE';
        // document_start may already have a body that the parser/portal will replace.
        // Keep network observation early; mount the existing UI only after parsing.
        var domReady = document.readyState !== 'loading' ? Promise.resolve() : new Promise(function (resolve) { document.addEventListener('DOMContentLoaded', resolve, { once: true }); });
        var restore = Promise.all([this.keywordManager.loadKeywords(), this.circuitBreaker.ready, this.safety.ready, this._acquiredReady]);
        // Start the cache/read while the portal renders. Only validated, age-bounded cache entries are used.
        var filters = restore.then(function () {
            if (!self._supabaseEnabled) return true;
            return self.supabase.loadFilters(false).then(function (success) {
                if (success) self._applyFilters(self.supabase.getFilters());
                return success;
            });
        }).catch(function (err) { self.logger.error('filters.sync.failed', { error: err.message }); return false; });
        Promise.all([domReady, restore]).then(function () {
            if (self._shutdown) return;
            self._injectPanelStyles();
            self.queue.setProcessor(function (lead) { return self._processLead(lead); });
            self._setupUI();
            self._initialized = true;
            self._startupState = 'READY';
            if (!self.circuitBreaker.canExecute()) self._isPaused = true;
            self._startPeriodicTasks();
            self._updateScannerLifecycleState('initialized');
            // MAIN world drains its document_start buffer only after this point. No startup events are discarded.
            self._bridgeTimer = setTimeout(function () {
                if (!self._bridgeReady && !self._shutdown) { self.logger.warn('network.bridge.unavailable', { reasonCode: 'MAIN_WORLD_ACK_MISSING' }); _flushLogsNow(); }
            }, 2000);
            window.postMessage({ __leadsync_ready__: true }, window.location.origin || '*');
            self.logger.logEvent({ level: 'INFO', event: 'app.initialization.completed', context: { scannerState: self._scannerState, mode: self.config.mode } });
            _flushLogsNow();
            self._broadcastStatus();
            filters.then(function (success) { if (!success && self._supabaseEnabled) self._syncSupabaseKeywords(); });
        }).catch(function (err) {
            self._failInitialization(err);
        });
    };

    Orchestrator.prototype._applyFilters = function (filters) {
        if (this._shutdown || !this._supabaseEnabled || !Array.isArray(filters)) return false;
        var self = this;
        var reactivated = false;
        filters.forEach(function (f) {
            var key = String(f.id), km = self.keywordManager;
            var meta = km._deactivatedMeta[key];
            if (km._deactivatedFilterIds.has(key) && f.is_active === true && !f.deleted_at && !f.is_deleted &&
                (km._observedInactiveFilters.has(key) || (meta && meta.deactivationVersion && Date.parse(f.updated_at) > Date.parse(meta.deactivationVersion)))) {
                km._finishFilterReactivation(key, 'manual_user_reactivation');
                reactivated = true;
            }
        });
        this.keywordManager._deactivatedFilterIds.forEach(function (key) {
            if (!filters.some(function (f) { return String(f.id) === key && f.is_active !== false; })) self.keywordManager._observedInactiveFilters.add(key);
        });
        var signature = Core.signature(filters);
        if (!reactivated && this._lastFiltersSignature === signature) {
            if (this._initialized) {
                this._flushPendingNetworkLeads();
                this._observedLeads.forEach(function (entry) {
                    if (entry.revision === 'STALE' && Date.now() - entry.at < 30000) self._evaluateObservedLead(entry.lead, 'FILTER_REFRESH');
                });
            }
            return false;
        }
        this._lastFiltersSignature = signature;
        this._filterRevision = (this._filterRevision || 0) + 1;
        this.keywordManager.extractFromSupabaseFilters(filters);
        if (!this._initialized) return true;
        if (this.scanner) this.scanner.resetEmitted();
        this._updateScannerLifecycleState('filters_updated');
        // Re-evaluate fresh rejected network observations after a CRM edit; never reset attempt/confirmed dedup state.
        var self = this;
        Array.from((this._observedLeads || new Map()).values()).forEach(function (entry) {
            if (Date.now() - entry.at < 30000) self._evaluateObservedLead(entry.lead, 'FILTER_UPDATE');
        });
        return true;
    };

    // No synthetic anti-idle events or unsolicited HEAD requests. The authenticated portal owns its session.
    Orchestrator.prototype._initTcpKeepAlive = function () {};
    Orchestrator.prototype._pingKeepAlive = function () {};
    Orchestrator.prototype._stopTcpKeepAlive = function () {};

    Orchestrator.prototype.startNewCycle = function (cycleId, resetMetrics, reason) {
        this._cycleStartedAt = Date.now();
        this._currentCycleId = cycleId || ('cycle_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));
        this.stats.cycleScanned = 0;
        this._cycleAcquiredThisScan = false; // reset per-cycle acquisition flag
        if (this._currentCycleSeenLeads) {
            this._currentCycleSeenLeads.clear();
        } else {
            this._currentCycleSeenLeads = new Set();
        }
        if (resetMetrics && this.metrics) {
            this.metrics.resetCycle(this._currentCycleId);
        }
        var statsScanned = document.getElementById('bl-stat-scanned');
        if (statsScanned) statsScanned.textContent = '0';
        this.logger.info('🔄 New scan cycle initialized: ' + this._currentCycleId + ' (per-cycle counter reset to 0; dedup state kept; reason=' + (reason || 'init') + ')');
        this._broadcastStatus();
        return this._currentCycleId;
    };

    Orchestrator.prototype._updateScannerLifecycleState = function (reason) {
        if (!this._initialized || this._shutdown) return SCANNER_STATES.INITIALIZING;
        if (!this.circuitBreaker.canExecute()) this._isPaused = true;
        window.postMessage({ __leadsync_stream_control__: this._isPaused ? 'pause' : 'resume', proactiveFeedPolling: this.config.proactiveFeedPolling === true }, window.location.origin || '*');
        this._flushPendingNetworkLeads();
        var activeFilterCount = this.keywordManager ? this.keywordManager.getActiveFilterCount() : 0;
        if (this.metrics) {
            this.metrics.setActiveFiltersCount(activeFilterCount);
        }
        var filterCountEl = document.getElementById('bl-filters-count');
        if (filterCountEl) filterCountEl.textContent = String(activeFilterCount);

        if (this._isPaused) {
            this._scannerState = SCANNER_STATES.PAUSED;
            if (this.scanner && this.scanner._running) {
                this.scanner.stopWatching();
            }
            if (this.navigator && this.navigator._running) {
                this.navigator.stop();
            }
            this._broadcastStatus();
            return this._scannerState;
        }

        if (activeFilterCount === 0) {
            var idleReason = this._supabaseEnabled && !this.supabase._filtersLoaded ? 'FILTERS_LOADING' : 'NO_ELIGIBLE_FILTERS';
            if (this._scannerState !== SCANNER_STATES.IDLE || this._idleReason !== idleReason) {
                this._idleReason = idleReason;
                this.logger.logEvent({ level: 'INFO', event: 'scanner.idle', reasonCode: idleReason, context: { activeFilters: 0 } });
            }
            var wasRunning = this.scanner && this.scanner._running;
            this._scannerState = SCANNER_STATES.IDLE;
            if (wasRunning) {
                this.scanner.stopWatching();
                this.logger.info('⏸ Scanner transitioned to IDLE: 0 eligible filters active. Observer disconnected. (' + (reason || '') + ')');
            }
            if (this.navigator && this.navigator._running) {
                this.navigator.stop();
            }
            this._broadcastStatus();
            return this._scannerState;
        }

        this._idleReason = null;
        // Active filters exist (> 0) and user has not paused
        if (this._scannerState === SCANNER_STATES.IDLE || this._scannerState === SCANNER_STATES.INITIALIZING || !this.scanner._running) {
            this.logger.info('▶ Eligible filters detected (' + activeFilterCount + '). Transitioning from ' + this._scannerState + ' to SCANNING.');
            this._scannerState = SCANNER_STATES.SCANNING;
            this.startNewCycle();
            var self = this;
            if (this.scanner) {
                this.scanner.startWatching(function (cards) {
                    self._onCardsDetected(cards);
                });
                this.scanner._scan();
            }
            if (this.navigator && !this.navigator._running) {
                this.navigator.start();
            }
            this._broadcastStatus();
        } else {
            this._scannerState = SCANNER_STATES.SCANNING;
        }
        return this._scannerState;
    };

    Orchestrator.prototype._syncSupabaseKeywords = function () {
        var self = this;
        if (this._shutdown || !this._supabaseEnabled) return Promise.resolve(false);
        return this.supabase.loadFilters(true).then(function (success) {
            if (success) {
                self._syncRetryAttempt = 0; self._syncRetryNextAt = 0;
                self._applyFilters(self.supabase.getFilters());
                self.duplicateManager.loadFromDb();
                return true;
            }
            // The periodic sync remains active; no uncancellable recursive retry timers.
            self._syncRetryAttempt = (self._syncRetryAttempt || 0) + 1;
            self._syncRetryNextAt = Date.now() + 10000;
            return false;
        }).catch(function (err) { self.logger.warn('Filter sync failed', { error: err.message }); return false; });
    };
    Orchestrator.prototype._injectPanelStyles = function () {
        if (document.getElementById('bl-panel-styles')) return;
        var style = document.createElement('style');
        style.id = 'bl-panel-styles';
        style.textContent = `
            .bl-panel {
                position: fixed;
                background: #ffffff;
                border: 1px solid #e4e4e7;
                border-radius: 8px;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 12px;
                color: #18181b;
                box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04);
                z-index: 2147483647;
                user-select: none;
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
            }
            .bl-panel-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                border-bottom: 1px solid #e4e4e7;
                cursor: move;
                touch-action: none;
                background: #fafafa;
            }
            .bl-panel-header img {
                width: 18px; height: 18px;
                object-fit: contain;
                border-radius: 4px;
                flex-shrink: 0;
            }
            .bl-panel-title {
                flex: 1;
                font-size: 12px;
                font-weight: 600;
                color: #18181b;
                letter-spacing: -0.01em;
            }
            .bl-status-dot {
                width: 7px; height: 7px;
                border-radius: 50%;
                background: #059669;
                flex-shrink: 0;
            }
            .bl-panel-toggle {
                background: #ffffff;
                border: 1px solid #e4e4e7;
                color: #52525b;
                width: 20px; height: 20px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: inherit;
                transition: background 0.12s ease;
            }
            .bl-panel-toggle:hover { background: #f4f4f5; color: #18181b; }
            .bl-panel-body {
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                width: 220px;
                box-sizing: border-box;
            }
            .bl-row {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: #52525b;
                line-height: 1.4;
            }
            .bl-row .bl-strong { color: #18181b; font-weight: 500; }
            .bl-row .bl-dim { color: #a1a1aa; }
            .bl-stats-row {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 4px;
                font-size: 10.5px;
                line-height: 1.4;
                white-space: nowrap;
                overflow: hidden;
            }
            .bl-stat-group {
                display: inline-flex;
                align-items: center;
                gap: 2px;
            }
            .bl-stop-sold-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 1px 0;
            }
            .bl-toggle-btn {
                background: #f4f4f5;
                border: 1px solid #e4e4e7;
                border-radius: 4px;
                padding: 2px 7px;
                font-size: 10px;
                font-weight: 600;
                color: #18181b;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                font-family: inherit;
                transition: all 0.12s ease;
            }
            .bl-toggle-btn:hover { background: #e4e4e7; }
            .bl-toggle-btn .bl-indicator {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                display: inline-block;
                flex-shrink: 0;
            }
            .bl-toggle-btn .bl-indicator.active { background: #10b981; }
            .bl-toggle-btn .bl-indicator.inactive { background: #a1a1aa; }
            .bl-toggle-label {
                font-size: 10px;
                letter-spacing: 0.02em;
            }
            .bl-warning {
                display: none;
                margin-top: 6px;
                padding: 6px 8px;
                background: #fffbeb;
                border: 1px solid #fde68a;
                border-radius: 5px;
                color: #92400e;
                font-size: 10px;
                font-weight: 500;
                text-align: center;
            }
            .bl-warning.show { display: block; }

            .bl-approval {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: #ffffff;
                border: 1px solid #e4e4e7;
                border-radius: 8px;
                padding: 12px;
                width: 300px;
                z-index: 2147483646;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                color: #18181b;
                -webkit-font-smoothing: antialiased;
            }
            .bl-approval-header {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 8px;
                padding-bottom: 8px;
                border-bottom: 1px solid #f4f4f5;
            }
            .bl-approval-header img {
                width: 18px; height: 18px;
                object-fit: contain;
                border-radius: 4px;
            }
            .bl-approval-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 7px;
                background: #f0fdfa;
                color: #0d9488;
                border: 1px solid #99f6e4;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.02em;
                text-transform: uppercase;
            }
            .bl-approval-badge svg { flex-shrink: 0; }
            .bl-approval-product {
                font-size: 13px;
                font-weight: 600;
                color: #18181b;
                line-height: 1.35;
                margin-bottom: 4px;
                word-break: break-word;
                letter-spacing: -0.01em;
            }
            .bl-approval-country {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 11px;
                color: #71717a;
                margin-bottom: 12px;
            }
            .bl-approval-actions {
                display: flex;
                gap: 6px;
            }
            .bl-btn {
                flex: 1;
                padding: 7px 10px;
                border: 1px solid transparent;
                border-radius: 5px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                font-family: inherit;
                transition: all 0.12s ease;
            }
            .bl-btn svg { flex-shrink: 0; }
            .bl-btn-acquire {
                background: #18181b;
                color: #ffffff;
            }
            .bl-btn-acquire:hover { background: #000000; }
            .bl-btn-skip {
                background: #ffffff;
                color: #52525b;
                border-color: #e4e4e7;
            }
            .bl-btn-skip:hover { background: #f4f4f5; color: #18181b; }

            /* Top-Center Toast Container & Prompts */
            #bl-toast-container {
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
                pointer-events: none;
            }
            .bl-top-toast {
                pointer-events: auto;
                min-width: 290px;
                max-width: 460px;
                background: #0f172a;
                color: #f8fafc;
                border-radius: 8px;
                padding: 10px 16px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.35), 0 8px 10px -6px rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.12);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                animation: blToastSlideDown 0.26s cubic-bezier(0.16, 1, 0.3, 1);
                transition: opacity 0.28s ease, transform 0.28s ease;
            }
            .bl-top-toast.bl-toast-leave {
                opacity: 0;
                transform: translateY(-12px) scale(0.96);
            }
            .bl-toast-found { border-left: 4px solid #3b82f6; }
            .bl-toast-acquiring { border-left: 4px solid #f59e0b; }
            .bl-toast-contacted { border-left: 4px solid #10b981; }
            .bl-toast-failed { border-left: 4px solid #ef4444; }
            .bl-toast-warning { border-left: 4px solid #f59e0b; }
            .bl-toast-reactivated { border-left: 4px solid #10b981; }
            .bl-toast-refresh { border-left: 4px solid #8b5cf6; }
            .bl-toast-info { border-left: 4px solid #06b6d4; }
            .bl-toast-icon { font-size: 18px; line-height: 1; flex-shrink: 0; }
            .bl-toast-content { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
            .bl-toast-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #94a3b8; }
            .bl-toast-message { font-size: 13px; font-weight: 500; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            @keyframes blToastSlideDown {
                from { opacity: 0; transform: translateY(-20px) scale(0.95); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            /* ── Panel control row & buttons ── */
            .bl-ctrl-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
            .bl-ctrl-btn {
                font-size: 11px; font-weight: 600; padding: 5px 8px; border-radius: 4px;
                border: none; cursor: pointer; transition: all 0.15s ease; line-height: 1.3;
                display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: 1;
            }
            .bl-ctrl-stop   { background: #ef4444; color: #fff; }
            .bl-ctrl-stop:hover { background: #dc2626; }
            .bl-ctrl-resume { background: #22c55e; color: #fff; }
            .bl-countdown-btn {
                background: #0f172a !important;
                color: #38bdf8 !important;
                border: 1px solid #1e293b !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
                font-size: 11px !important;
                font-weight: 700 !important;
                font-variant-numeric: tabular-nums !important;
                min-width: 52px !important;
                padding: 5px 8px !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 4px !important;
                border-radius: 4px !important;
                cursor: pointer !important;
                user-select: none !important;
                transition: background 0.15s ease, border-color 0.15s ease !important;
            }
            .bl-countdown-btn:hover {
                background: #1e293b !important;
                border-color: #38bdf8 !important;
                color: #7dd3fc !important;
            }
            .bl-countdown-icon {
                font-size: 10px !important;
                line-height: 1 !important;
            }
            .bl-countdown-val {
                font-variant-numeric: tabular-nums !important;
                letter-spacing: 0.02em !important;
            }
            .bl-ctrl-refresh {
                background: #f1f5f9 !important;
                color: #1e293b !important;
                border: 1px solid #cbd5e1 !important;
            }
            .bl-ctrl-filters {
                background: #18181b !important;
                color: #ffffff !important;
                border: 1px solid #27272a !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 5px !important;
            }
            .bl-ctrl-filters:hover {
                background: #09090b !important;
                border-color: #3f3f46 !important;
            }
            .bl-badge {
                background: #2563eb;
                color: #ffffff;
                font-size: 9px;
                padding: 1px 5px;
                border-radius: 10px;
                font-weight: 700;
                line-height: 1.2;
            }

            /* Performance metrics cards below Resume */
            .bl-metrics-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                padding: 3px 0;
                margin-top: 2px;
            }
            .bl-metric-card {
                flex: 1;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 4px;
                padding: 4px 6px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 10px;
            }
            .bl-metric-label {
                color: #64748b;
                font-weight: 500;
            }
            .bl-metric-val {
                color: #0f172a;
                font-weight: 700;
                font-family: monospace;
            }
        `;
        document.head.appendChild(style);
    };
    Orchestrator.prototype._startPeriodicTasks = function () {
        var self = this;
        if (this._filterWatchTimer) return;
        this._filterWatchTimer = setInterval(function () { self._checkDynamicFilterChanges(true); }, 10000);
        this._statsTimer = setInterval(function () {
            if (self._supabaseEnabled && self.supabase.updateFilterStats) self.supabase.updateFilterStats(self.stats.discovered, self.stats.filtered, self.metrics._attempts);
        }, 30000);
        this._cleanupTimer = setInterval(function () { self.duplicateManager.cleanup(); }, 120000);
    };

    Orchestrator.prototype._setupUI = function () {
        var existing = document.getElementById('bl-safety-status');
        if (existing) existing.remove();
        var self = this;
        var panel = document.createElement('div');
        panel.id = 'bl-safety-status';
        panel.className = 'bl-panel';

        var savedPos = this._savedPanelPosition;
        if (savedPos && savedPos.top !== undefined) {
            var maxX = window.innerWidth - 220, maxY = window.innerHeight - 150;
            panel.style.top = Math.max(0, Math.min(savedPos.top, maxY)) + 'px';
            panel.style.left = Math.max(0, Math.min(savedPos.left, maxX)) + 'px';
        } else {
            panel.style.bottom = '20px';
            panel.style.left = '20px';
        }

        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) { }

        panel.innerHTML =
            '<div class="bl-panel-header" id="bl-panel-header">' +
            (iconUrl ? '<img src="' + iconUrl + '" alt="logo" />' : '') +
            '<span class="bl-panel-title">BuyLead</span>' +
            '<span class="bl-status-dot" id="bl-status-dot"></span>' +
            '<button class="bl-panel-toggle" id="bl-panel-toggle" type="button">−</button>' +
            '</div>' +
            '<div class="bl-panel-body" id="bl-panel-body">' +
            '<div class="bl-row"><span id="bl-status-text" class="bl-strong">Init...</span></div>' +
            '<div class="bl-row bl-stats-row">' +
            '<span class="bl-stat-group"><span class="bl-dim">Scanned</span> <span id="bl-stat-scanned" class="bl-strong">0</span></span>' +
            '<span class="bl-dim">·</span>' +
            '<span class="bl-stat-group"><span class="bl-dim">Acquired</span> <span id="bl-stat-acquired" class="bl-strong">0</span></span>' +
            '<span class="bl-dim">·</span>' +
            '<span class="bl-stat-group"><span class="bl-dim">Matched</span> <span id="bl-stat-filtered" class="bl-strong">0</span></span>' +
            '</div>' +
            '<div class="bl-row bl-stop-sold-row">' +
            '<span class="bl-dim">Stop Sold</span>' +
            '<button id="bl-stop-sold-btn" class="bl-toggle-btn" type="button" aria-pressed="true" title="Stop Sold: ON (Skipping sold-out leads)">' +
            '<span id="bl-stop-sold-indicator" class="bl-indicator active"></span>' +
            '<span id="bl-stop-sold-label" class="bl-toggle-label">ON</span>' +
            '</button>' +
            '</div>' +
            '<div class="bl-row"><span id="bl-connection-text" class="bl-dim">CRM</span></div>' +
            '<div class="bl-row bl-ctrl-row">' +
            '<button id="bl-stop-btn" class="bl-ctrl-btn bl-ctrl-stop" type="button">⏸ Pause</button>' +
            '<button id="bl-resume-btn" class="bl-ctrl-btn bl-ctrl-resume" type="button" style="display:none">▶ Resume</button>' +
            '<button id="bl-hard-refresh-btn" class="bl-ctrl-btn bl-countdown-btn" type="button" title="Reload manually when no acquisition is in progress">' +
            '<span class="bl-countdown-icon">⏱</span>' +
            '<span id="bl-hard-refresh-label" class="bl-countdown-val">Reload</span>' +
            '</button>' +
            '<button id="bl-filters-btn" class="bl-ctrl-btn bl-ctrl-filters" type="button" title="Open CRM Filters">' +
            '<span>⚡ Filters</span>' +
            '<span id="bl-filters-count" class="bl-badge">0</span>' +
            '</button>' +
            '</div>' +
            '<div class="bl-row bl-metrics-row">' +
            '<div class="bl-metric-card" title="Average elapsed time between lead detection and verified acquisition">' +
            '<span class="bl-metric-label">Speed:</span>' +
            '<span id="bl-stat-speed" class="bl-metric-val">0s</span>' +
            '</div>' +
            '<div class="bl-metric-card" title="Verified successful acquisitions divided by eligible completed attempts">' +
            '<span class="bl-metric-label">Acceptance:</span>' +
            '<span id="bl-stat-acceptance" class="bl-metric-val">0%</span>' +
            '</div>' +
            '</div>' +
            '<div class="bl-warning" id="bl-warning-text"></div>' +
            '</div>';

        document.body.appendChild(panel);
        this._safetyPanel = panel;
        if (this._panelCollapsed) this._setPanelCollapsed(true);
        this._setupDrag(panel);

        var toggleBtn = document.getElementById('bl-panel-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var isCollapsed = document.getElementById('bl-panel-body').style.display === 'none';
                self._setPanelCollapsed(!isCollapsed);
                chrome.storage.local.set({ panelCollapsed: !isCollapsed });
            });
        }

        // ── Stop Sold toggle button ──
        var stopSoldBtn = document.getElementById('bl-stop-sold-btn');
        if (stopSoldBtn) {
            this._updateStopSoldUI();
            stopSoldBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var current = self.config.stopSold !== false;
                self.setStopSold(!current);
            });
        }

        // ── Stop / Resume buttons ──
        var stopBtn = document.getElementById('bl-stop-btn');
        var resumeBtn = document.getElementById('bl-resume-btn');
        var hardRefreshBtn = document.getElementById('bl-hard-refresh-btn');
        if (hardRefreshBtn) {
            hardRefreshBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.triggerHardRefresh('user_click');
            });
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.emergencyStop();
            });
        }
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.resume();
            });
        }

        // (Safe 10-Second Countdown Hard Refresh button removed per user request)

        // ── Filters CRM button ──
        var filtersBtn = document.getElementById('bl-filters-btn');
        if (filtersBtn) {
            filtersBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var crmFiltersUrl = 'https://leadsync-tau-sand.vercel.app/';
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'OPEN_TAB', url: crmFiltersUrl }, function () {
                            if (chrome.runtime.lastError) {
                                window.open(crmFiltersUrl, '_blank');
                            }
                        });
                    } else {
                        window.open(crmFiltersUrl, '_blank');
                    }
                } catch (err) {
                    window.open(crmFiltersUrl, '_blank');
                }
            });
        }

        this._onPanelResize = function () { self._keepPanelInView(); };
        window.addEventListener('resize', this._onPanelResize);
        this._startStatusUpdates();
    };

    Orchestrator.prototype._setPanelCollapsed = function (c) {
        var body = document.getElementById('bl-panel-body');
        var btn = document.getElementById('bl-panel-toggle');
        if (!body || !btn) return;
        body.style.display = c ? 'none' : 'block';
        btn.textContent = c ? '+' : '−';
        this._panelCollapsed = c;
    };

    Orchestrator.prototype._setupDrag = function (panel) {
        var self = this;
        var header = document.getElementById('bl-panel-header');
        if (!header) return;
        var dragging = false, sx = 0, sy = 0, sl = 0, st = 0, moved = false, raf = null;
        function ptr(e) {
            if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
            return { x: e.clientX, y: e.clientY };
        }
        function down(e) {
            if (e.target && e.target.id === 'bl-panel-toggle') return;
            if (e.button !== undefined && e.button !== 0) return;
            var p = ptr(e); sx = p.x; sy = p.y; moved = false; dragging = true;
            var r = panel.getBoundingClientRect();
            sl = r.left; st = r.top;
            panel.style.left = sl + 'px'; panel.style.top = st + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            document.body.style.userSelect = 'none';
            if (e.cancelable) e.preventDefault();
        }
        function move(e) {
            if (!dragging) return;
            var p = ptr(e);
            var dx = p.x - sx, dy = p.y - sy;
            if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
            moved = true;
            var nl = sl + dx, nt = st + dy;
            var r = panel.getBoundingClientRect();
            nl = Math.max(0, Math.min(nl, window.innerWidth - r.width));
            nt = Math.max(0, Math.min(nt, window.innerHeight - r.height));
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(function () { panel.style.left = nl + 'px'; panel.style.top = nt + 'px'; });
            if (e.cancelable) e.preventDefault();
        }
        function up() {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (moved) {
                var r = panel.getBoundingClientRect();
                self._savedPanelPosition = { left: r.left, top: r.top };
                chrome.storage.local.set({ panelPosition: self._savedPanelPosition });
            }
        }
        header.addEventListener('mousedown', down);
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        header.addEventListener('touchstart', down, { passive: false });
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', up);
        this._disposePanelDrag = function () {
            if (raf) cancelAnimationFrame(raf);
            document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
            document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
        };
    };

    Orchestrator.prototype._keepPanelInView = function () {
        if (!this._safetyPanel) return;
        var r = this._safetyPanel.getBoundingClientRect();
        var nl = Math.max(0, Math.min(r.left, window.innerWidth - r.width));
        var nt = Math.max(0, Math.min(r.top, window.innerHeight - r.height));
        if (nl !== r.left || nt !== r.top) {
            this._safetyPanel.style.left = nl + 'px';
            this._safetyPanel.style.top = nt + 'px';
        }
    };

    Orchestrator.prototype._startStatusUpdates = function () {
        var self = this;
        this._statusPanelTimer = setInterval(function () {
            // Portal hydration/SPA rendering may replace the body after startup.
            // Reattach our original node, retaining its controls, position and collapse state.
            if (self._safetyPanel && !self._safetyPanel.isConnected && document.body) document.body.appendChild(self._safetyPanel);
            if (document.head && !document.getElementById('bl-panel-styles')) self._injectPanelStyles();
            var s = self.safety.getStatus();
            if (!self._safetyPanel) return;
            var dot = document.getElementById('bl-status-dot');
            var text = document.getElementById('bl-status-text');
            var statsScanned = document.getElementById('bl-stat-scanned');
            var statsAcquired = document.getElementById('bl-stat-acquired');
            var conn = document.getElementById('bl-connection-text');

            var modeLabel = self.config.mode === 'AUTOMATIC' ? '[AUTO]' : (self.config.mode === 'ASSISTED' ? '[ASSIST]' : '[' + self.config.mode + ']');
            if (dot) dot.style.background = s.emergencyStop ? '#ef7076' : (s.cooldown ? '#fff5cc' : '#fff');
            if (text) {
                var t = modeLabel + ' ';
                if (s.emergencyStop) t += '🚨 EMERGENCY';
                else if (self._isPaused) t += '⏸ Paused';
                else if (s.cooldown) t += '⏳ Cooldown';
                else if (self.navigator._running) t += '▶ Loop Running';
                else if (self.scanner._running) t += '▶ Scanning';
                else if (self._supabaseEnabled && !self.supabase._filtersLoaded) t += 'Waiting for CRM filters';
                else if (self._scannerState === SCANNER_STATES.IDLE) t += 'No eligible filters';
                else t += '⏹ Stopped';
                text.textContent = t;
            }
            if (statsScanned) statsScanned.textContent = self.stats.cycleScanned !== undefined ? self.stats.cycleScanned : (self.stats.unique || self.stats.discovered || 0);
            if (statsAcquired) statsAcquired.textContent = self.stats.acquired;

            var filtEl = document.getElementById('bl-stat-filtered');
            if (filtEl) filtEl.textContent = self.stats.filtered || 0;

            var speedEl = document.getElementById('bl-stat-speed');
            var accEl = document.getElementById('bl-stat-acceptance');
            var filterCountEl = document.getElementById('bl-filters-count');

            if (speedEl) speedEl.textContent = self.metrics.getSpeedPerAcquisition().formatted;
            if (accEl) accEl.textContent = self.metrics.getAcceptanceRate().formatted;
            if (filterCountEl) filterCountEl.textContent = self.keywordManager.getActiveFilterCount();

            var _sb = document.getElementById('bl-stop-btn');
            var _rb = document.getElementById('bl-resume-btn');
            var _running = !self._isPaused && self.scanner && self.scanner._running;
            if (_sb) _sb.style.display = _running ? '' : 'none';
            if (_rb) _rb.style.display = _running ? 'none' : '';
            if (conn) {
                var kws = self.keywordManager.getAllKeywords();
                conn.textContent = (self._supabaseEnabled ? '☁️ CRM' : '📴 Local') + ' (P' + kws.product.length + ')';
                conn.style.color = self._supabaseEnabled ? '#02A699' : '#f5a623';
            }

            self._updateStopSoldUI();

            var warnEl = document.getElementById('bl-warning-text');
            if (warnEl) {
                var restricted = !self.circuitBreaker.canExecute();
                var shouldWarn = self._supabaseEnabled
                    && (!self.supabase._filtersLoaded || (self.supabase.hasFreshFilters && !self.supabase.hasFreshFilters()))
                    && (Date.now() - self._initTime > 5000);

                if (restricted) {
                    warnEl.textContent = 'IndiaMART restriction: ' + (self.circuitBreaker._reason || 'Manual review required') + '. Resume only after reviewing the portal.';
                    warnEl.classList.add('show');
                } else if (shouldWarn) {
                    var msg = '⚠️ Filters not loaded — acquiring disabled';
                    if (self._syncRetryAttempt > 0) {
                        var secondsLeft = Math.max(0, Math.round((self._syncRetryNextAt - Date.now()) / 1000));
                        msg = '⚠️ Filters not loaded — retrying in ' + secondsLeft + 's (' + self._syncRetryAttempt + '/' + 5 + ')';
                    } else if (self._syncRetryAttempt === -1) {
                        msg = '🛑 Filters failed to load — refresh page to retry';
                    }
                    warnEl.textContent = msg;
                    warnEl.classList.add('show');
                } else {
                    warnEl.classList.remove('show');
                }
            }
            self._broadcastStatus();
        }, 800);
    };

    // ============================================================
    // SAFE PAGE REFRESH CONTROLLER & 10-SECOND COUNTDOWN
    // ============================================================
    Orchestrator.prototype._isSafeForHardRefresh = function () {
        if (this._pendingSaves && this._pendingSaves.size) return false;
        // 1. LeadQueue: Must have 0 items in memory and 0 actively processing
        var q = this.queue;
        if (q && (q.processing > 0 || (q.queue && q.queue.length > 0))) return false;

        // 2. Scanner: Must NOT be currently running a scan pass or debouncing
        if (this.scanner && (this.scanner._scanning || this.scanner._scanPending)) return false;

        // 3. LifecycleManager: No lead ID marked in flight
        if (this.lifecycle && this.lifecycle._inFlight && this.lifecycle._inFlight.size > 0) return false;

        // 4. StateMachine: No active processing or acquisition/contact pending
        if (this.stateMachine) {
            var sm = this.stateMachine.getStats();
            if ((sm.PROCESSING || 0) > 0 ||
                (sm.ACQUISITION_PENDING || 0) > 0 ||
                (sm.CONTACT_PENDING || 0) > 0 ||
                (sm.ACTION_PENDING || 0) > 0) {
                return false;
            }
        }

        // 5. PopupManager: No modal/OTP active
        if (this.popupManager && this.popupManager._active) return false;

        // 6. Review Dialog: No unconfirmed approval card in DOM
        if (typeof document !== 'undefined' && document.querySelector && document.querySelector('.bl-approval')) {
            return false;
        }

        // 7. Auto-Pause Protection: Never reload while paused for lead acquired
        if (this._isPaused || this._cycleAcquiredThisScan) return false;

        return true;
    };

    // Countdown UI and interval timers removed per backend alignment
    // ============================================================
    // SAFE PAGE REFRESH CONTROLLER & 10-SECOND COUNTDOWN (Option 1)
    // ============================================================
    Orchestrator.prototype._updateRefreshButtonLabel = function (val) {
        try {
            if (typeof document === 'undefined') return;
            var labelEl = document.getElementById('bl-hard-refresh-label');
            if (labelEl) {
                if (typeof val === 'number') {
                    labelEl.textContent = val + 's';
                } else if (val === 'pause' || this._isPaused) {
                    labelEl.textContent = '⏸';
                } else if (val) {
                    labelEl.textContent = String(val);
                } else {
                    labelEl.textContent = '10s';
                }
            }
        } catch (e) { }
    };

    Orchestrator.prototype._startRefreshCountdown = function () { return false; };

    Orchestrator.prototype._stopRefreshCountdown = function (reason) {
        if (this._refreshCountdownTimer) {
            clearInterval(this._refreshCountdownTimer);
            this._refreshCountdownTimer = null;
        }
        if (this._refreshSafetyGateTimer) {
            clearInterval(this._refreshSafetyGateTimer);
            this._refreshSafetyGateTimer = null;
        }
        if (reason === 'lead_acquired' || this._isPaused) {
            this._updateRefreshButtonLabel('pause');
        }
    };

    Orchestrator.prototype._enterRefreshSafetyGate = function () { return false; };

    Orchestrator.prototype.triggerHardRefresh = function (reason) {
        var self = this;
        if (reason !== 'user_click' && reason !== 'user_click_deferred') return false;
        var isSafe = this._isSafeForHardRefresh();

        // If not in a clean quiescent micro-hold, defer so we never interrupt an in-flight lead
        if (!isSafe) {
            this.logger.info('⏳ Refresh deferred: lead operation in progress (' + reason + ')');
            if (!this._manualRefreshTimer) this._manualRefreshTimer = setTimeout(function () {
                self._manualRefreshTimer = null;
                if (!self._shutdown) self.triggerHardRefresh('user_click_deferred');
            }, 1000);
            return;
        }

        this.logger.info('🔄 Executing safe hard refresh (' + reason + ')...');
        try {
            sessionStorage.setItem('bl_scanner_auto_resume', this._isPaused ? 'false' : 'true');
            if (this.supabase && this.supabase._filters) {
                sessionStorage.setItem('bl_cached_filters', JSON.stringify(this.supabase._filters));
                sessionStorage.setItem('bl_cached_filters_ts', String(Date.now()));
            }
        } catch (e) { }

        if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
            window.location.reload();
        } else if (typeof window !== 'undefined' && window.location) {
            window.location.href = window.location.href;
        }
    };

    // ============================================================
    // STRICT COUNTRY
    // ============================================================
    Orchestrator.prototype._checkStrictCountry = function (lead) {
        // When Supabase filters are active, country restrictions are dynamically enforced per filter
        // (allows leads from any country when no country filter is specified in that filter)
        if (this._supabaseEnabled) {
            return { allowed: true };
        }
        if (!this.config.strictCountryMode) return { allowed: true };
        var allowed = (this.config.allowedCountries || []).map(function (c) {
            var raw = String(c).toLowerCase().trim();
            return COUNTRY_NAME_TO_ISO[raw] || (raw.length === 2 ? raw.toUpperCase() : raw.toUpperCase());
        }).filter(function (c) { return c && c.length > 0; });

        if (allowed.length === 0) {
            return { allowed: true };
        }

        var leadCountry = Core.countryFromLead(lead);
        if (!leadCountry) {
            if (this.config.strictCountryRejectUnknown) {
                return { allowed: false, reason: 'STRICT_COUNTRY_UNKNOWN', details: { allowed: allowed } };
            }
            return { allowed: true, reason: 'STRICT_COUNTRY_UNKNOWN_ALLOWED' };
        }
        if (allowed.indexOf(leadCountry) !== -1) {
            return { allowed: true, reason: 'STRICT_COUNTRY_MATCH', details: { country: leadCountry } };
        }
        return { allowed: false, reason: 'STRICT_COUNTRY_MISMATCH', details: { leadCountry: leadCountry, allowed: allowed } };
    };

    // ============================================================
    // CENTRALIZED ACQUISITION SUCCESS HANDLER (v6.4.2 - Bot-Speed)
    // ============================================================
    // Handles the complete post-acquisition lifecycle: statistics,
    // deduplication, pause loop, Supabase sync, and instant live toasts.
    Orchestrator.prototype._enrichAcquiredLead = function (lead, result) {
        var contact = result && result.buyerContact || {};
        ['senderMobile', 'senderPhone', 'senderEmail'].forEach(function (key) { if (contact[key]) lead[key] = contact[key]; });
        var card = Core.findCard(document, lead.uniqueQueryId);
        if (!card) return;
        var parsed = this.parser.parseCard(card, lead.leadId);
        if (!parsed || parsed.queryId !== lead.uniqueQueryId) return;
        ['senderName', 'senderMobile', 'senderPhone', 'senderEmail'].forEach(function (key) { if (parsed[key]) lead[key] = parsed[key]; });
        // Revealed contacts may be links without visible telephone text.
        card.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').forEach(function (link) {
            if (!Core.visible(link)) return;
            var href = link.getAttribute('href') || '';
            if (/^tel:\+?[\d ()-]{7,30}$/.test(href)) lead.senderMobile = lead.senderMobile || href.slice(4);
            if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href)) lead.senderEmail = lead.senderEmail || href.slice(7);
        });
    };

    Orchestrator.prototype._handleAcquisitionSuccess = function (lead, result) {
        if (!result || result.success !== true || result.verified !== true) return false;
        var id = lead.uniqueQueryId || lead.leadId;
        if (this._acquiredLeadIds.has(String(id))) return false;
        this._enrichAcquiredLead(lead, result);
        if (!lead._initiationCounted) { lead._initiationCounted = true; this.stats.initiated++; }
        this.stats.acquired++;
        this._recordLeadAcquired(lead);
        this.stateMachine.setState(lead.leadId, 'ACQUIRED');
        if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'ACQUIRED');
        if (this.metrics) this.metrics.recordAcquisitionSuccess(lead.leadId, Date.now());
        this.safety.recordAcquisition();
        if (lead.filterId) this.keywordManager.recordFilterSuccess(lead.filterId, lead);
        var contacted = result.contactSuccess === true;
        if (contacted) {
            this.stateMachine.setState(lead.leadId, 'CONTACTED');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'CONTACTED');
            if (this.metrics) this.metrics.recordContactSuccess(lead.leadId, Date.now());
        }
        if (this.metrics) this.metrics.recordLeadAttemptCompleted(lead._attemptId || lead.leadId, true);
        this._reviewLeads.delete(id);
        this._recordSessionAcquisition(lead, 'SUCCESS', contacted ? 'ACQUIRED_AND_CONTACTED' : 'ACQUIRED_CONTACT_PENDING', { result: result });
        this._saveLeadToDb(lead, true, Object.assign({}, result, { state: contacted ? 'CONTACTED' : 'ACQUIRED', attemptId: lead._attemptId }));
        if (this.showTopToast) this.showTopToast('contacted', contacted ? 'Lead Acquired & Contacted' : 'Lead Acquisition Verified', lead.productName || 'Lead', 3000);
        this._updateScannerLifecycleState('acquisition_confirmed');
        this._broadcastStatus();
        return true;
    };

    Orchestrator.prototype._bindDomCardToLead = function (lead) {
        var card = Core.findCard(document, lead.uniqueQueryId);
        if (card) { lead.element = card; lead.raw = { element: card }; }
        // No per-lead body observer. The scanner and the single active adapter own observers.
    };

    Orchestrator.prototype._flushPendingNetworkLeads = function () {
        if (!this._initialized || this._isPaused || (this._supabaseEnabled && !this.supabase._filtersLoaded) || !this._pendingNetworkLeadCards) return 0;
        var pending = Array.from(this._pendingNetworkLeadCards.values());
        this._pendingNetworkLeadCards.clear();
        this._onNetworkLeads(pending);
        return pending.length;
    };

    Orchestrator.prototype._onNetworkLeads = function (cards) {
        var self = this;
        (cards || []).forEach(function (pc) {
            try {
                var raw = Core.normalizeLead(pc._rawApiLead);
                if (!raw || !raw.uniqueQueryId) return;
                var at = pc.observedAt || (pc._rawApiLead && pc._rawApiLead.observedAt) || Date.now();
                if (Date.now() - at > 30000 || Date.now() < at - 5000) return;
                if (!self._initialized || self._isPaused || (self._supabaseEnabled && !self.supabase._filtersLoaded)) {
                    self._pendingNetworkLeadCards.set(raw.uniqueQueryId, Object.assign({}, pc, { observedAt: at }));
                    while (self._pendingNetworkLeadCards.size > 1000) self._pendingNetworkLeadCards.delete(self._pendingNetworkLeadCards.keys().next().value);
                    return;
                }
                var lead = {
                    leadId: raw.uniqueQueryId, uniqueQueryId: raw.uniqueQueryId, queryId: raw.uniqueQueryId,
                    productName: raw.queryProductName, queryProductName: raw.queryProductName, subject: raw.queryProductName,
                    messageText: raw.queryMessage, queryMessage: raw.queryMessage, queryMcatName: raw.queryMcatName,
                    city: raw.senderCity, state: raw.senderState, countryIso: raw.senderCountryIso || 'UNKNOWN',
                    location: [raw.senderCity, raw.senderState, raw.senderCountryIso].filter(Boolean).join(', '),
                    hasMobile: raw.hasMobile, hasPhone: raw.hasPhone, hasEmail: raw.hasEmail, hasWhatsapp: raw.hasWhatsapp,
                    contact: { mobile: raw.hasMobile ? 'available' : null, phone: raw.hasPhone ? 'available' : null, email: raw.hasEmail ? 'available' : null, whatsapp: raw.hasWhatsapp ? 'available' : null },
                    quantity: typeof raw.quantity === 'string' ? parseQuantityString(raw.quantity) : raw.quantity,
                    queryTime: raw.queryTime, queryType: 'BUY_LEAD', availability: raw.availability,
                    _fromNetwork: true, _observedAt: at, _rawApiLead: raw
                };
                self._evaluateObservedLead(lead, 'NETWORK');
            } catch (err) { self.logger.warn('Network lead processing failed', { error: err.message }); }
        });
    };

    Orchestrator.prototype._onPassiveNetworkLead = function (rawLead, sourceUrl) {
        this._onNetworkLeads([{ _rawApiLead: rawLead, _sourceUrl: sourceUrl }]);
    };

    Orchestrator.prototype._onCardsDetected = function (cards) {
        var self = this;
        if (this._isPaused || !Core.activePage(window.location) || !this.circuitBreaker.canExecute()) return;
        (cards || []).forEach(function (card) {
            try {
                var lead = self.parser.normalize(self.parser.parseCard(card.element, card.id));
                if (!lead) { if (self.scanner) self.scanner.forget(card.id, 500); return; }
                lead._domId = card.id;
                // Cross-route identity is the actual inquiry ID, not dm_ID_product_seller.
                lead.leadId = Core.elementLeadId(card.element) || lead.leadId;
                lead.uniqueQueryId = Core.elementLeadId(card.element) || lead.uniqueQueryId;
                if (self._supabaseEnabled && !self.supabase._filtersLoaded) { self.scanner.forget(card.id); return; }
                self._evaluateObservedLead(lead, 'DOM');
            } catch (err) { self.stats.failed++; self.logger.warn('DOM lead parsing failed', { error: err.message }); }
        });
    };

    Orchestrator.prototype._evaluateObservedLead = function (lead, source) {
        if (this._isPaused || !Core.activePage(window.location) || !this.circuitBreaker.canExecute()) return;
        var id = Core.id(lead.uniqueQueryId);
        if (!id) { this.logger.debug('lead.identity.missing', { reasonCode: 'NO_EXACT_INQUIRY_ID' }); return; }
        if (!this._observedLeads) this._observedLeads = new Map();
        var prior = this._observedLeads.get(id);
        if (prior) {
            // Prefer known fields over empty/unknown hydration shells; never bind by product text.
            var merged = prior.lead;
            if (source === 'DOM' && prior.lead._fromNetwork && Date.now() - (prior.lead._observedAt || 0) < 30000) {
                lead.contact = Object.assign({}, prior.lead.contact, Object.fromEntries(Object.entries(lead.contact || {}).filter(function (entry) { return Core.available(entry[1]); })));
                ['hasMobile', 'hasPhone', 'hasEmail', 'hasWhatsapp'].forEach(function (k) { lead[k] = Core.available(lead[k]) || Core.available(prior.lead[k]); });
                // A still-hydrating card must not overwrite fresh structured qualification
                // data. DOM can fill missing fields and reveal contacts for this exact ID.
                ['productName', 'queryProductName', 'messageText', 'queryMessage', 'queryMcatName', 'countryIso', 'city', 'state', 'quantity'].forEach(function (key) {
                    if (prior.lead[key] != null && prior.lead[key] !== '' && prior.lead[key] !== 'UNKNOWN') delete lead[key];
                });
            }
            Object.keys(lead).forEach(function (key) {
                if (lead[key] != null && lead[key] !== '' && lead[key] !== 'UNKNOWN') merged[key] = lead[key];
            });
            if (lead.element) { prior.lead.element = lead.element; prior.lead.raw = lead.raw; }
            lead = merged;
        }
        var targetBound = !!(lead.element && Core.visible(lead.element) && Core.elementLeadId(lead.element) === id);
        var newlyAvailableTarget = source === 'DOM' && targetBound && prior && !prior.targetBound && lead._lastOutcome && lead._lastOutcome.state === 'NOT_ATTEMPTED' && lead._lastOutcome.action === 'target_not_available';
        var signature = Core.signature({ productName: lead.productName, messageText: lead.messageText, countryIso: lead.countryIso, city: lead.city, state: lead.state, contact: lead.contact, quantity: lead.quantity, availability: lead.availability });
        var revision = 'filters:' + (this._filterRevision || 0) + '|options:' + (this._evaluationRevision || 0);
        this._observedLeads.delete(id);
        this._observedLeads.set(id, { lead: lead, signature: signature, revision: revision, targetBound: targetBound, at: Date.now() });
        while (this._observedLeads.size > 1000) this._observedLeads.delete(this._observedLeads.keys().next().value);
        if (this._supabaseEnabled && this.supabase.hasFreshFilters && !this.supabase.hasFreshFilters()) {
            this._observedLeads.get(id).revision = 'STALE';
            return;
        }
        // Metadata may be identical when a previously absent exact CTA finally hydrates.
        // Only a proven no-action outcome can become newly actionable; UNKNOWN never retries.
        if (prior && prior.signature === signature && prior.revision === revision && !newlyAvailableTarget) return;
        if (this.stateMachine.getState(id) === 'UNKNOWN') {
            if (source === 'DOM' && (lead.senderMobile || lead.senderPhone || lead.senderEmail)) this._saveLeadToDb(lead, true, null);
            return;
        }
        if (!this._uniqueSeenIds.has(id)) {
            this._uniqueSeenIds.add(id); this.stats.discovered++; this.stats.unique = this._uniqueSeenIds.size;
            if (this.metrics) this.metrics.recordDetection(id, Date.now());
        }
        this._currentCycleSeenLeads.add(id);
        this.stats.cycleScanned = this._currentCycleSeenLeads.size;
        var scanned = document.getElementById('bl-stat-scanned');
        if (scanned) scanned.textContent = String(this.stats.cycleScanned);
        lead.traceId = generateTraceId(id);
        this.logger.logEvent({ level: 'DEBUG', event: 'lead.observed', traceId: lead.traceId, context: { leadId: id, source: source } });
        if (this._isLeadAcquired(lead, { element: lead.element, id: lead.leadId }) || this.duplicateManager.isDuplicate(id)) {
            if (source === 'DOM' && (lead.senderMobile || lead.senderEmail || lead.senderPhone)) this._saveLeadToDb(lead, true, null);
            this.stats.duplicate++; return;
        }
        if (this._reviewLeads.has(id) || this.queue._activeUqids.has(id) || this.queue.queue.some(function (item) { return item.uniqueQueryId === id; })) return;
        if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'DETECTED');
        if (this._isLeadSoldOut(lead, { element: lead.element }) || /sold out|unavailable|consumed/i.test(lead.availability || '')) {
            this.stats.rejected++;
            this.stateMachine.setState(lead.leadId, 'UNAVAILABLE');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'SKIPPED');
            return;
        }
        var country = this._checkStrictCountry(lead);
        if (!country.allowed) { this.stats.countryBlocked++; return; }
        var match = this._matchLead(lead);
        this.logger.logEvent({ level: match.passed ? 'INFO' : 'DEBUG', event: 'lead.filter.evaluated', traceId: lead.traceId, result: match.passed ? 'PASSED' : 'REJECTED', reasonCode: match.passed ? 'FILTER_MATCH' : match.reason, context: { leadId: id, filterId: match.filterId || null, score: match.score || 0, diagnostics: match.diagnostics || null } });
        if (!match.passed) { this.stats.rejected++; return; }
        lead.filterId = match.filterId;
        lead.filterName = match.filterName;
        lead.score = match.score;
        lead.confidence = match.confidence;
        lead.matchedProducts = match.matchedProducts || [];
        lead.pointsDistribution = match.pointsDistribution || match.reasons || [];
        this.stats.validated++; this.stats.filtered++;
        if (this.metrics) this.metrics.recordMatch(lead.leadId, Date.now());
        if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'MATCHED');
        // Persist asynchronously; no Supabase round trip is on the acquisition critical path.
        this._saveLeadToDb(lead, true, { state: 'MATCHED' });
        var mode = this.config.mode;
        if (mode === 'MONITOR' || mode === 'DRY_RUN') {
            this.stateMachine.setState(lead.leadId, mode === 'MONITOR' ? 'MONITORED' : 'DRY_RUN');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, mode === 'MONITOR' ? 'MONITORED' : 'DRY_RUN');
            this._recordSessionAcquisition(lead, 'SIMULATED', mode === 'MONITOR' ? 'MONITORED' : 'DRY_RUN', { action: 'no_side_effect' });
            return;
        }
        if (mode === 'ASSISTED' || mode === 'REVIEW') {
            this._reviewLeads.set(id, lead);
            this.stateMachine.setState(lead.leadId, 'READY_FOR_REVIEW');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'READY_FOR_REVIEW');
            this._showReviewUI(lead);
            return;
        }
        if (this.queue.enqueue(lead)) this.stats.queued++;
    };

    Orchestrator.prototype._saveLeadToDb = function (lead, isMatched, outcome) {
        if (!this._supabaseEnabled) return Promise.resolve(null);
        var self = this;
        var payload = {
            uniqueQueryId: lead.uniqueQueryId, queryType: lead.queryType, queryTime: lead.queryTime,
            subject: lead.subject || lead.productName, queryProductName: lead.queryProductName || lead.productName,
            queryMessage: lead.queryMessage || lead.messageText, queryMcatName: lead.queryMcatName,
            senderName: lead.senderName, senderCity: lead.city, senderState: lead.state, senderCountryIso: lead.countryIso,
            senderMobile: lead.senderMobile, senderPhone: lead.senderPhone, senderEmail: lead.senderEmail, isMatched: isMatched, traceId: lead.traceId
        };
        if (this.supabase.syncLead) {
            lead._savePromise = this.supabase.syncLead(payload, outcome).then(function (result) {
                if (!result || !result.queued) { self.logger.error('crm.write.not_queued', { error: result && result.error || 'No durable acknowledgement' }); return null; }
                self.logger.debug('crm.write.queued', { context: { uniqueQueryId: lead.uniqueQueryId } });
                return result; // Deliberately NOT counted as a DB write.
            }).catch(function (err) { self.logger.error('crm.write.not_queued', { error: err.message }); return null; });
        } else {
            // Legacy service compatibility; success requires a real row, not an error wrapper.
            lead._savePromise = Promise.resolve(this.supabase.insertLead(payload)).then(function (result) {
                var row = result && (result.data || (!result.error && result.id ? result : null));
                if (!row || !row.id) return null;
                lead._dbId = row.id;
                if (!self._dbSyncedIds) self._dbSyncedIds = new Set();
                if (!self._dbSyncedIds.has(lead.uniqueQueryId)) { self._dbSyncedIds.add(lead.uniqueQueryId); self.stats.dbSynced++; }
                return row;
            });
        }
        if (!this._pendingSaves) this._pendingSaves = new Set();
        var pending = lead._savePromise;
        this._pendingSaves.add(pending);
        pending.finally(function () { self._pendingSaves.delete(pending); }).catch(function () {});
        return pending;
    };

    Orchestrator.prototype._processLead = async function (lead) {
        var outcome;
        try {
            outcome = await this._executeLead(lead);
            return outcome;
        } catch (err) {
            this.logger.error('Acquisition pipeline exception', { error: err.message });
            this.stateMachine.setState(lead.leadId, 'UNKNOWN');
            this.lifecycle.transition(lead.leadId, 'UNKNOWN');
            this._recordSessionAcquisition(lead, 'UNKNOWN', 'UNKNOWN', { error: err.message });
            this._saveLeadToDb(lead, true, { state: 'UNKNOWN', ambiguous: true, attemptId: lead._attemptId, message: err.message });
            outcome = { success: false, status: 'UNKNOWN', error: err.message };
            return outcome;
        } finally {
            if (lead._safetyToken) { this.safety.releaseReservation(lead._safetyToken); delete lead._safetyToken; }
            if (lead.filterId) this.keywordManager.releaseReservation(lead.filterId, lead.leadId);
            this.lifecycle._inFlight.delete(lead.leadId);
            if (lead._completion) { var complete = lead._completion; lead._completion = null; complete(outcome || { success: false, status: 'UNKNOWN' }); }
        }
    };

    Orchestrator.prototype._executeLead = async function (lead) {
        var self = this;
        if (this._isPaused || !Core.activePage(window.location) || !this.circuitBreaker.canExecute()) {
            this.stateMachine.setState(lead.leadId, 'BLOCKED');
            return { success: false, status: 'BLOCKED' };
        }
        if (this.config.mode === 'MONITOR' || this.config.mode === 'DRY_RUN') {
            this.stateMachine.setState(lead.leadId, this.config.mode === 'MONITOR' ? 'MONITORED' : 'DRY_RUN');
            return { success: false, simulated: true, status: this.config.mode };
        }
        if ((this.config.mode === 'ASSISTED' || this.config.mode === 'REVIEW') && !lead._userConfirmed) {
            this._reviewLeads.set(lead.uniqueQueryId, lead); this._showReviewUI(lead);
            return { success: false, status: 'READY_FOR_REVIEW' };
        }
        if (this._isLeadAcquired(lead)) return { success: false, status: 'ALREADY_ACQUIRED' };
        if (this._supabaseEnabled && this.supabase.hasFreshFilters && !this.supabase.hasFreshFilters()) {
            this.stateMachine.setState(lead.leadId, 'FILTERS_STALE');
            var entry = this._observedLeads.get(lead.uniqueQueryId);
            if (entry) entry.revision = 'STALE';
            return { success: false, status: 'BLOCKED', reason: 'FILTERS_STALE' };
        }
        // Re-evaluate the complete current filter, not only whether its ID is still active.
        if (lead.filterId) this.keywordManager.releaseReservation(lead.filterId, lead.leadId);
        var match = this._matchLead(lead);
        if (!match.passed || !this._checkStrictCountry(lead).allowed) {
            this.stateMachine.setState(lead.leadId, 'FILTERED_OUT');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'SKIPPED');
            return { success: false, status: 'FILTERED_OUT' };
        }
        lead.filterId = match.filterId; lead.filterName = match.filterName;
        var capacity = this.safety.reserveCapacity(lead.leadId);
        if (!capacity.allowed) {
            this.stateMachine.setState(lead.leadId, 'BLOCKED');
            this._recordSessionAcquisition(lead, 'BLOCKED', 'SAFETY_BLOCKED', { error: capacity.reason });
            return { success: false, status: 'BLOCKED', reason: capacity.reason };
        }
        lead._safetyToken = capacity.token;
        if (lead.filterId) this.keywordManager.reserveSlot(lead.filterId, lead.leadId);
        this.stateMachine.setState(lead.leadId, 'ACQUISITION_PENDING');
        if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'ACQUISITION_PENDING');
        if (this.metrics) this.metrics.recordAcquisitionAttempt(lead.leadId);
        var result;
        try {
            result = await this.actionAdapter.acquire(lead);
        } catch (err) { result = { success: false, ambiguous: true, action: 'exception', message: err.message }; }
        this.safety.releaseReservation(capacity.token);
        delete lead._safetyToken;
        if (lead.filterId) this.keywordManager.releaseReservation(lead.filterId, lead.leadId);
        if (result && result.success === true && result.verified === true) {
            this._handleAcquisitionSuccess(lead, result);
            return { success: true, status: 'SERVER_CONFIRMED', result: result };
        }
        if (result && result.action === 'already_acquired' && result.verified === true) {
            this._enrichAcquiredLead(lead, result);
            this._recordLeadAcquired(lead);
            this.stateMachine.setState(lead.leadId, 'ALREADY_ACQUIRED');
            if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'ALREADY_ACQUIRED');
            this._saveLeadToDb(lead, true, Object.assign({}, result, { verified: true, state: 'ALREADY_ACQUIRED' }));
            this._recordSessionAcquisition(lead, 'ALREADY_ACQUIRED', 'ALREADY_ACQUIRED', { result: result });
            return { success: false, status: 'ALREADY_ACQUIRED', result: result };
        }
        var unknown = !result || result.ambiguous === true || (result.success && !result.verified);
        var blocked = result && (result.action === 'account_blocked' || result.action === 'duplicate_or_blocked' || result.code === 'INSUFFICIENT_BALANCE' || result.code === 'SUBSCRIPTION_REQUIRED');
        var unavailable = result && result.action === 'lost_race';
        var state = unknown ? 'UNKNOWN' : blocked ? 'BLOCKED' : unavailable ? 'UNAVAILABLE' : result && result.notAttempted ? 'NOT_ATTEMPTED' : 'ACQUISITION_FAILED';
        this.stats.failed++;
        this.stateMachine.setState(lead.leadId, state);
        if (this.lifecycle) this.lifecycle.transition(lead.leadId, state);
        if (this.metrics) { this.metrics.recordAcquisitionFailure(lead.leadId, state); this.metrics.recordLeadAttemptCompleted(lead._attemptId || lead.leadId, false); }
        this._recordSessionAcquisition(lead, state === 'UNKNOWN' ? 'UNKNOWN' : blocked ? 'BLOCKED' : 'FAILED', state, { error: result && result.message || 'No authoritative result', result: result });
        this._saveLeadToDb(lead, true, Object.assign({}, result, { success: false, state: state, attemptId: lead._attemptId }));
        if (blocked && result.action === 'account_blocked') {
            var warn = document.getElementById('bl-warning-text');
            if (warn) { warn.textContent = result.message || 'Account action required'; warn.classList.add('show'); }
            this._onRateLimitDetected(result.message || result.code);
        }
        this._broadcastStatus();
        return { success: false, status: state === 'UNKNOWN' ? 'UNKNOWN' : state, result: result };
    };

    Orchestrator.prototype._confirmAndContactLead = function (lead) {
        var self = this;
        if (!lead || this._isPaused || this.config.mode === 'MONITOR' || this.config.mode === 'DRY_RUN') return Promise.resolve({ success: false, status: 'BLOCKED' });
        if (lead._approvalPromise) return lead._approvalPromise;
        lead._userConfirmed = true;
        this._reviewLeads.delete(lead.uniqueQueryId);
        lead._approvalPromise = new Promise(function (resolve) {
            lead._completion = resolve;
            if (!self.queue.enqueue(lead)) { lead._completion = null; resolve({ success: false, status: 'BLOCKED' }); }
        });
        return lead._approvalPromise;
    };

    Orchestrator.prototype._showReviewUI = function (lead) {
        var existing = document.getElementById('bl_approval_' + lead.leadId);
        if (existing) existing.remove();
        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) { }

        var traceId = lead.traceId || (this.logger && this.logger.generateTraceId ? this.logger.generateTraceId(lead.leadId) : lead.leadId);
        var opId = this.logger && this.logger.generateOperationId ? this.logger.generateOperationId('rev') : ('rev_' + Date.now());

        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'action.review.requested', 'Orchestrator', {
                traceId: traceId,
                operationId: opId,
                reasonCode: 'REVIEW_REQUIRED',
                result: 'PROMPTED',
                context: { productName: lead.productName, city: lead.city, country: lead.countryIso }
            });
        }

        var card = document.createElement('div');
        card.id = 'bl_approval_' + lead.leadId;
        card.className = 'bl-approval';

        var countryFlag = '';
        if (lead.countryIso && lead.countryIso.length === 2 && lead.countryIso !== 'UNKNOWN') {
            try {
                var codePoints = lead.countryIso.toUpperCase().split('').map(function (c) { return 127397 + c.charCodeAt(0); });
                countryFlag = String.fromCodePoint.apply(null, codePoints);
            } catch (e) { }
        }

        var locText = [lead.city, lead.state, lead.countryIso || 'UNKNOWN'].filter(Boolean).join(', ');
        var reqText = (lead.messageText || lead.queryMessage || lead.description || '').trim();
        if (reqText.length > 120) reqText = reqText.substring(0, 117) + '...';

        var isAlreadyAcquired = (lead && lead.state === 'ACQUIRED') ||
            (this.stateMachine && this.stateMachine.getState(lead.leadId) === 'ACQUIRED') ||
            (this._acquiredLeadIds && (this._acquiredLeadIds.has(String(lead.leadId)) || this._acquiredLeadIds.has(String(lead.uniqueQueryId))));
        var contactInfo = lead.senderMobile || lead.mobile || lead.senderEmail || lead.email || '';

        var badgeHtml = isAlreadyAcquired
            ? '<span class="bl-approval-badge" style="background:#16a34a;color:#fff;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Lead Acquired &mdash; Review</span>'
            : '<span class="bl-approval-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Review Lead</span>';

        var actionsHtml = isAlreadyAcquired
            ? '<div class="bl-approval-actions">' +
              '<button class="bl-btn bl-btn-acquire" type="button" data-a="resume">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
              'Continue Automation' +
              '</button>' +
              '<button class="bl-btn bl-btn-skip" type="button" data-a="skip">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>' +
              'Dismiss' +
              '</button>' +
              '</div>'
            : '<div class="bl-approval-actions">' +
              '<button class="bl-btn bl-btn-acquire" type="button" data-a="acq">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
              'Confirm Contact' +
              '</button>' +
              '<button class="bl-btn bl-btn-skip" type="button" data-a="skip">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>' +
              'Dismiss' +
              '</button>' +
              '</div>';

        card.innerHTML =
            '<div class="bl-approval-header">' +
            (iconUrl ? '<img src="' + iconUrl + '" alt="logo" />' : '') +
            badgeHtml +
            '</div>' +
            '<div class="bl-approval-product">' + this._esc(lead.productName || 'Lead') + '</div>' +
            (contactInfo ? '<div style="font-size:11px;font-weight:600;color:#16a34a;margin-bottom:6px;">Buyer Contact: ' + this._esc(contactInfo) + '</div>' : '') +
            (reqText ? '<div style="font-size:11px;color:#52525b;margin-bottom:6px;line-height:1.35;">' + this._esc(reqText) + '</div>' : '') +
            '<div class="bl-approval-country">' + (countryFlag ? countryFlag + ' ' : '') + this._esc(locText) + '</div>' +
            (lead._matchReasons ? '<div style="font-size:10px;color:#0284c7;background:#f0f9ff;border:1px solid #bae6fd;border-radius:4px;padding:2px 6px;margin-bottom:8px;">Match: ' + this._esc(lead._matchReasons) + '</div>' : '') +
            actionsHtml;

        document.body.appendChild(card);

        var self = this;
        var resumeBtn = card.querySelector('[data-a="resume"]');
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function () {
                card.remove();
                if (typeof self.resume === 'function') {
                    self.resume();
                }
            });
        }
        var acqBtn = card.querySelector('[data-a="acq"]');
        if (acqBtn) {
            acqBtn.addEventListener('click', function () {
                acqBtn.disabled = true;
                acqBtn.textContent = '⏳ Contacting...';
                if (self.logger && typeof self.logger.logEvent === 'function') {
                    self.logger.logEvent('INFO', 'action.user.confirmed', 'Orchestrator', {
                        traceId: traceId,
                        operationId: opId,
                        reasonCode: 'USER_CONFIRMED',
                        result: 'CONFIRMED'
                    });
                }
                self._confirmAndContactLead(lead).then(function (outcome) {
                    if (outcome.status === 'SERVER_CONFIRMED') {
                        acqBtn.textContent = outcome.result && outcome.result.contactSuccess ? '✅ Contacted' : '✅ Acquired';
                        setTimeout(function () { card.remove(); }, 1500);
                    } else if (outcome.status === 'UNKNOWN') {
                        acqBtn.textContent = '⚠️ Status Unknown';
                    } else {
                        acqBtn.textContent = '❌ Failed';
                    }
                });
            });
        }
        var skipBtn = card.querySelector('[data-a="skip"]');
        if (skipBtn) {
            skipBtn.addEventListener('click', function () {
                self._reviewLeads.delete(lead.uniqueQueryId);
                if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self.stateMachine.setState(lead.leadId, 'DISMISSED');
                card.remove();
            });
        }
    };

    Orchestrator.prototype._showApprovalUI = function (lead) {
        return this._showReviewUI(lead);
    };

    Orchestrator.prototype._esc = function (t) { if (!t) return ''; var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    Orchestrator.prototype._broadcastStatus = function () {
        try {
            var p = chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: this.getStatus() });
            if (p && typeof p.catch === 'function') p.catch(function () { });
        } catch (e) { }
    };

    Orchestrator.prototype.updateFullConfig = function (newConfig) {
        var previousMode = this.config.mode;
        var merged = Object.assign({}, DEFAULT_CONFIG, this.config, newConfig || {});
        if (['MONITOR', 'DRY_RUN', 'ASSISTED', 'AUTOMATIC', 'REVIEW'].indexOf(merged.mode) === -1) return Promise.resolve(false);
        merged.autoReloadOnComplete = false;
        merged.maxReloadsPerSession = 0;
        if (newConfig && newConfig.scoreWeights) merged.scoreWeights = Object.assign({}, DEFAULT_CONFIG.scoreWeights, newConfig.scoreWeights);
        if (newConfig && newConfig.scorePenalties) merged.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, newConfig.scorePenalties);

        merged.strictCountryMode = merged.strictCountryMode === true;
        merged.allowedCountries = (merged.allowedCountries || ['IN']).map(function (x) {
            return String(x).toUpperCase().trim();
        }).filter(function (x) { return x; });
        merged.strictCountryRejectUnknown = merged.strictCountryRejectUnknown !== false;

        merged.minScore = validMinScore(merged.minScore);
        this.config = merged;
        var scopeChanged = String(this.supabase._clientId || '') !== String(merged.supabaseClientId || '');
        if (this.supabase.setClientId) this.supabase.setClientId(merged.supabaseClientId || null);
        this._supabaseEnabled = merged.supabaseEnabled !== false;
        this.keywordManager.setSupabaseEnabled(this._supabaseEnabled);
        if (scopeChanged) { this._lastFiltersSignature = undefined; this.keywordManager.extractFromSupabaseFilters([]); this._checkDynamicFilterChanges(true); }
        chrome.storage.local.set(merged);

        this.safety.setLimits({
            perMinute: merged.maxPerMinute,
            perHour: merged.maxPerHour,
            perDay: merged.maxPerDay,
            perSession: merged.maxPerSession
        });
        this.safety.setMode(merged.mode);
        this.safety.setCooldown(merged.cooldownMs);
        this.actionAdapter.setDryRun(merged.mode === 'DRY_RUN');
        this.actionAdapter.setAutoMinimize(merged.autoMinimize);
        this.actionAdapter.setConfirmationAnswer(merged.confirmationAnswer);
        this.actionAdapter.setPurchaseAction(merged.purchaseAction);
        this.actionAdapter.setPopupTimeout(merged.popupTimeoutMs);

        this.keywordManager.matcher.minConfidenceScore = merged.minScore;
        this.scorer.setMinimumScore(merged.minScore);
        this.scorer.setWeights(merged.scoreWeights);
        this.scorer.setPenalties(merged.scorePenalties);
        this.scorer.setPreferredStates(merged.preferredStates);
        this.scorer.setPreferredCountries(merged.preferredCountries);

        this.navigator.applySettings(merged);
        if (previousMode !== merged.mode) {
            this._reviewLeads.clear();
            Array.prototype.forEach.call(document.querySelectorAll('.bl-approval'), function (el) { el.remove(); });
            if ((merged.mode === 'MONITOR' || merged.mode === 'DRY_RUN') && this.actionAdapter.cancelActive) this.actionAdapter.cancelActive();
        }
        this._revalidateObservedLeads('config_changed');

        this.logger.info('Config updated. Rate limits: ' + merged.maxPerMinute + '/min, ' + merged.maxPerHour + '/hr');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype._matchLead = function (lead) {
        var match = this._supabaseEnabled ? this.keywordManager.evaluateFilters(lead) : this.keywordManager.checkKeywords(lead.productName, lead.messageText, lead);
        if (match.passed && !this._supabaseEnabled) Object.assign(match, this.scorer.evaluate(lead, match));
        return match;
    };

    Orchestrator.prototype._revalidateObservedLeads = function (reason) {
        if (!this._initialized || this._shutdown) return;
        this._evaluationRevision = (this._evaluationRevision || 0) + 1;
        this.scanner.resetEmitted();
        var self = this;
        Array.from((this._observedLeads || new Map()).values()).forEach(function (entry) {
            if (Date.now() - entry.at < 30000) self._evaluateObservedLead(entry.lead, reason || 'OPTIONS_CHANGED');
        });
        this._updateScannerLifecycleState(reason);
    };

    Orchestrator.prototype.setMode = function (m) {
        if (['MONITOR', 'DRY_RUN', 'ASSISTED', 'AUTOMATIC', 'REVIEW'].indexOf(m) === -1) return Promise.resolve(false);
        var changed = this.config.mode !== m;
        this.config.mode = m;
        this.safety.setMode(m);
        this.actionAdapter.setDryRun(m === 'DRY_RUN');
        chrome.storage.local.set({ mode: m, userSetMode: true });
        if (changed && this._initialized) {
            this._reviewLeads.clear();
            Array.prototype.forEach.call(document.querySelectorAll('.bl-approval'), function (el) { el.remove(); });
            if ((m === 'MONITOR' || m === 'DRY_RUN') && this.actionAdapter.cancelActive) this.actionAdapter.cancelActive();
            this._revalidateObservedLeads('mode_changed');
        }
        return Promise.resolve(true);
    };
    Orchestrator.prototype.setLimits = function (l) {
        if (l.perMinute) this.config.maxPerMinute = l.perMinute;
        if (l.perHour) this.config.maxPerHour = l.perHour;
        if (l.perDay) this.config.maxPerDay = l.perDay;
        if (l.perSession) this.config.maxPerSession = l.perSession;
        this.safety.setLimits({
            perMinute: this.config.maxPerMinute, perHour: this.config.maxPerHour,
            perDay: this.config.maxPerDay, perSession: this.config.maxPerSession
        });
        chrome.storage.local.set({
            maxPerMinute: this.config.maxPerMinute, maxPerHour: this.config.maxPerHour,
            maxPerDay: this.config.maxPerDay, maxPerSession: this.config.maxPerSession
        });
    };
    Orchestrator.prototype.setMinScore = function (s) {
        this.config.minScore = validMinScore(s);
        this.keywordManager.matcher.minConfidenceScore = this.config.minScore;
        this.scorer.setMinimumScore(this.config.minScore);
        chrome.storage.local.set({ minScore: this.config.minScore });
        this._revalidateObservedLeads('score_changed');
    };
    Orchestrator.prototype.setAutoMinimize = function (v) { this.config.autoMinimize = v; this.actionAdapter.setAutoMinimize(v); chrome.storage.local.set({ autoMinimize: v }); };
    Orchestrator.prototype.setConfirmationAnswer = function (a) { this.config.confirmationAnswer = a; this.actionAdapter.setConfirmationAnswer(a); chrome.storage.local.set({ confirmationAnswer: a }); };
    Orchestrator.prototype.setPurchaseAction = function (a) { this.config.purchaseAction = a; this.actionAdapter.setPurchaseAction(a); chrome.storage.local.set({ purchaseAction: a }); };
    Orchestrator.prototype.setStopSold = function (enabled) {
        var val = !!enabled;
        this.config.stopSold = val;
        this.config.skipSoldOut = val;
        this.logger.info('🛑 Stop Sold setting updated: ' + (val ? 'ENABLED' : 'DISABLED'));
        chrome.storage.local.set({ stopSold: val, skipSoldOut: val });
        this._updateStopSoldUI();
        return Promise.resolve(val);
    };

    Orchestrator.prototype._updateStopSoldUI = function () {
        var btn = document.getElementById('bl-stop-sold-btn');
        var indicator = document.getElementById('bl-stop-sold-indicator');
        var label = document.getElementById('bl-stop-sold-label');
        var isEnabled = this.config.stopSold !== false;
        if (btn) {
            btn.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
            btn.title = isEnabled ? 'Stop Sold: ON (Skipping sold-out leads)' : 'Stop Sold: OFF (Sold-out leads not filtered)';
        }
        if (indicator) {
            if (isEnabled) {
                indicator.classList.add('active');
                indicator.classList.remove('inactive');
            } else {
                indicator.classList.remove('active');
                indicator.classList.add('inactive');
            }
        }
        if (label) {
            label.textContent = isEnabled ? 'ON' : 'OFF';
        }
    };

    Orchestrator.prototype._isLeadSoldOut = function (lead, card) {
        if (!card && (!lead || !lead.raw)) {
            if (lead && (lead.isSoldOut === true || lead.soldOut === true || lead.isSold === true)) return true;
            return false;
        }
        var el = (card && card.element) || (lead && lead.raw && lead.raw.element);

        // 1. Direct explicit property check on lead
        if (lead && (lead.isSoldOut === true || lead.soldOut === true || lead.isSold === true)) {
            return true;
        }

        if (!el) return false;

        // 2. DOM Attribute checks on the card container
        try {
            if (el.getAttribute && (el.getAttribute('data-sold') === 'true' || el.getAttribute('data-status') === 'sold' || el.getAttribute('data-is-sold') === 'true')) {
                return true;
            }
            if (el.className && typeof el.className === 'string') {
                var cName = el.className.toLowerCase();
                if (cName.indexOf('sold_out') !== -1 || cName.indexOf('soldout') !== -1 || cName.indexOf('lead_sold') !== -1) {
                    return true;
                }
            }
        } catch (e) { }

        // 3. Check card buttons, badges, tags, and ribbons
        // 3. Check ONLY visible badge/status/tag elements (not every div/span)
try {
    function _isVisible(node) {
        if (!node) return false;
        try {
            if (typeof node.getBoundingClientRect === 'function') {
                var r = node.getBoundingClientRect();
                if (r && (r.width === 0 || r.height === 0)) return false;
            }
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                var s = window.getComputedStyle(node);
                if (s && (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0)) return false;
            }
            return true;
        } catch (e) { return true; }
    }

    // Sold out indicators: badge elements, status tags, ribbons, and sold-out CTA buttons
    var badgeSelectors = [
        '[class*="sold_out"]', '[class*="soldout"]', '[class*="SoldOut"]',
        '[class*="sold-out"]', '[class*="Sold_Out"]',
        '[class*="badge"]', '[class*="Badge"]',
        '[class*="status"]', '[class*="Status"]',
        '[class*="ribbon"]', '[class*="Ribbon"]',
        'button', 'a', '[class*="btn"]', '[class*="cta"]'
    ];

    for (var si = 0; si < badgeSelectors.length; si++) {
        var nodes = el.querySelectorAll(badgeSelectors[si]);
        for (var bi = 0; bi < nodes.length; bi++) {
            var b = nodes[bi];

            // Hidden element ko ignore karo
            if (!_isVisible(b)) continue;

            var t = (b.textContent || '').trim().toLowerCase();

            // Badge text chhota hota hai — 30 chars se lamba matlab description hai, skip
            if (!t || t.length > 30) continue;

            var isSoldIndicator = t === 'sold' || t === 'sold out' || t === 'soldout' ||
                t === 'already sold' || t === 'quota exhausted' ||
                t === 'lead sold' ||
                (t.indexOf('sold out') !== -1 && t.indexOf('unsold') === -1) ||
                (t.indexOf('already sold') !== -1 && t.indexOf('unsold') === -1) ||
                (t.indexOf('quota exhausted') !== -1);

            if (isSoldIndicator && t.indexOf('unsold') === -1) {
                if (this.logger) {
                    this.logger.debug('Sold-out triggered by: <' + b.tagName.toLowerCase() +
                        ' class="' + (b.className || '') + '">' + t + '</>');
                }
                return true;
            }
        }
    }
} catch (e) { }

        return false;
    };

    // ============================================================
    // TOP-CENTER LIVE TELEMETRY TOASTS
    // ============================================================
    Orchestrator.prototype._ensureToastContainer = function () {
        var c = document.getElementById('bl-toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'bl-toast-container';
            document.body.appendChild(c);
        }
        return c;
    };

    Orchestrator.prototype.showTopToast = function (type, title, message, durationMs) {
        // Allow lead acquisition, status update toasts, and filter limit/deactivation/reactivation toasts
        var allowedTypes = { 'found': 1, 'acquiring': 1, 'contacted': 1, 'failed': 1, 'warning': 1, 'info': 1, 'reactivated': 1 };
        if (!allowedTypes[type]) {
            return;
        }
        var msgLower = (message || '').toLowerCase();
        var titleLower = (title || '').toLowerCase();
        var isFilterToast = titleLower.indexOf('filter') !== -1 || titleLower.indexOf('limit') !== -1;
        if (!isFilterToast && (msgLower.indexOf('refresh') !== -1 || msgLower.indexOf('scroll') !== -1 ||
            msgLower.indexOf('bottom') !== -1 || msgLower.indexOf('top') !== -1 ||
            titleLower.indexOf('refresh') !== -1 || titleLower.indexOf('scroll') !== -1)) {
            return;
        }

        try {
            var container = this._ensureToastContainer();
            var toast = document.createElement('div');
            toast.className = 'bl-top-toast bl-toast-' + (type || 'info');

            var iconMap = {
                'found': '🎯',
                'acquiring': '⚡',
                'contacted': '✅',
                'failed': '❌',
                'warning': '⚠️',
                'info': 'ℹ️',
                'reactivated': '🔄'
            };
            var icon = iconMap[type] || 'ℹ️';

            toast.innerHTML =
                '<span class="bl-toast-icon">' + icon + '</span>' +
                '<div class="bl-toast-content">' +
                '<div class="bl-toast-title">' + (title || 'Lead Update') + '</div>' +
                '<div class="bl-toast-message">' + (message || '') + '</div>' +
                '</div>';

            container.appendChild(toast);

            var timeout = durationMs || 2000;
            setTimeout(function () {
                toast.classList.add('bl-toast-leave');
                setTimeout(function () {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 300);
            }, timeout);
        } catch (e) { }
    };

    function _normLeadRecord(s) {
        return String(s || '').trim().toLowerCase().replace(/[^\w]/g, '_');
    }

    Orchestrator.prototype._recordSessionAcquisition = function (lead, status, outcomeType, meta) {
        if (!lead) return null;
        meta = meta || {};
        var now = new Date();
        var qid = String(lead.uniqueQueryId || lead.leadId || '');
        if (!this._sessionAcquisitions) this._sessionAcquisitions = [];

        // Deduplicate in session acquisitions by qid / leadId
        for (var i = 0; i < this._sessionAcquisitions.length; i++) {
            var existing = this._sessionAcquisitions[i];
            if (existing.uniqueQueryId === qid || existing.leadId === lead.leadId) {
                if (existing.status === 'SUCCESS' && status !== 'SUCCESS') return existing;
                if (!existing.buyerContact) existing.buyerContact = {};
                existing.status = status;
                existing.outcomeType = outcomeType || existing.outcomeType;
                existing.timestamp = now.toISOString();
                existing.timeFormatted = now.toLocaleTimeString();
                if (meta.error) existing.error = meta.error;
                if (meta.code) existing.code = meta.code;
                if (meta.action) existing.action = meta.action;
                if (lead.senderMobile && !existing.buyerContact.mobile) existing.buyerContact.mobile = lead.senderMobile;
                if (lead.senderEmail && !existing.buyerContact.email) existing.buyerContact.email = lead.senderEmail;
                this._persistSessionAcquisitions();
                return existing;
            }
        }

        var record = {
            id: 'acq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            timestamp: now.toISOString(),
            timeFormatted: now.toLocaleTimeString(),
            leadId: lead.leadId || qid,
            uniqueQueryId: qid,
            productName: lead.productName || lead.queryProductName || 'Unknown Product',
            sellerName: lead.senderName || lead.sellerName || 'N/A',
            buyerContact: {
                mobile: lead.senderMobile || (lead.contact && lead.contact.mobile) || null,
                email: lead.senderEmail || (lead.contact && lead.contact.email) || null,
                phone: lead.senderPhone || (lead.contact && lead.contact.phone) || null
            },
            location: lead.location || [lead.city, lead.state, lead.countryIso].filter(Boolean).join(', ') || 'N/A',
            countryIso: lead.countryIso || 'UNKNOWN',
            quantity: lead.quantity || null,
            messageText: (lead.messageText || lead.queryMessage || '').substring(0, 300),

            // Verified Matchmaking Details (Captured only for leads that passed matching)
            filterId: lead.filterId || 'N/A',
            filterName: lead.filterName || ('Filter #' + (lead.filterId || 'N/A')),
            matchScore: typeof lead.score === 'number' ? lead.score : (lead.confidence ? Math.round(lead.confidence * 100) : 60),
            matchConfidence: typeof lead.confidence === 'number' ? lead.confidence : 0.6,
            matchedKeywords: Array.isArray(lead.matchedProducts) ? lead.matchedProducts : (lead.matchedKeyword ? [lead.matchedKeyword] : []),
            pointsDistribution: Array.isArray(lead.pointsDistribution) ? lead.pointsDistribution : (Array.isArray(lead._matchReasons) ? [lead._matchReasons] : []),

            // Acquisition Outcome (SUCCESS, FAILED, BLOCKED)
            status: status,
            outcomeType: outcomeType || (status === 'SUCCESS' ? 'ACQUIRED_AND_CONTACTED' : 'ACQUISITION_FAILED'),
            action: (meta.result && meta.result.action) || meta.action || 'unknown',
            error: meta.error || null,
            code: meta.code || null,
            durationMs: meta.durationMs || null,
            traceId: lead.traceId || null
        };

        // Bounded diagnostic history; durable leases/outbox are independent of this display log.
        this._sessionAcquisitions.push(record);
        if (this._sessionAcquisitions.length > 2000) this._sessionAcquisitions.splice(0, this._sessionAcquisitions.length - 2000);
        this._persistSessionAcquisitions();

        this.logger.info('acquisition.session.recorded', {
            id: record.id,
            leadId: record.leadId,
            status: record.status,
            outcomeType: record.outcomeType,
            productName: record.productName,
            filterName: record.filterName,
            error: record.error
        });

        return record;
    };

    Orchestrator.prototype._persistSessionAcquisitions = function () {
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('bl_session_acquisitions', JSON.stringify(this._sessionAcquisitions));
            }
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({
                    bl_session_acquisitions: this._sessionAcquisitions,
                    session_acquisition_logs: this._sessionAcquisitions
                });
            }
        } catch (e) {
            this.logger.warn('Failed to persist session acquisitions: ' + (e && e.message));
        }
    };

    Orchestrator.prototype._recordLeadAcquired = function (lead) {
        if (!lead) return;
        var qid = lead.uniqueQueryId || lead.leadId;
        if (qid) this._acquiredLeadIds.add(String(qid));
        if (lead.leadId) this._acquiredLeadIds.add(String(lead.leadId));

        if (!this._acquiredRecords) this._acquiredRecords = [];
        var rec = {
            uniqueQueryId: String(qid || ''),
            leadId: String(lead.leadId || ''),
            productName: _normLeadRecord(lead.productName),
            sellerName: _normLeadRecord(lead.senderName || lead.sellerName),
            phone: String(lead.senderMobile || '').replace(/[^\d]/g, ''),
            location: _normLeadRecord(lead.location),
            acquiredAt: Date.now()
        };
        this._acquiredRecords.push(rec);
        this._acquiredRecords = this._acquiredRecords.slice(-500);

        // Mark only this specific lead in duplicateManager
        if (this.duplicateManager) {
            if (lead.uniqueQueryId) this.duplicateManager.markSeen(lead.uniqueQueryId);
            if (lead.leadId) this.duplicateManager.markSeen(lead.leadId);
        }
        try {
            var arr = Array.from(this._acquiredLeadIds);
            chrome.storage.local.set({
                acquiredLeadIds: arr,
                acquiredRecords: this._acquiredRecords.slice(-500)
            });
        } catch (e) { }
        this.logger.info('🔒 Lead permanently marked ACQUIRED & ignored for future scans: ' + (qid || lead.productName) + ' [Seller: ' + (lead.senderName || 'unknown') + ']');
    };

    Orchestrator.prototype._isLeadAcquired = function (lead, card) {
        if (!this._acquiredLeadIds) return false;

        // 1. Check only explicit acquisition/contact evidence on the card.
        // "View Contact" / "View Number" are actionable portal CTAs, not proof that
        // this lead was already acquired. A disabled generic button is also ambiguous
        // (balance/subscription restrictions can disable it), so neither is a duplicate.
        if (card && card.element) {
            if (card.element.getAttribute('data-leadsync-acquired') === 'true') return true;
            if (card.element.classList && card.element.classList.contains('bl-acquired-card')) return true;
            var buttons = card.element.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_Cta"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"]');
            for (var bIdx = 0; bIdx < buttons.length; bIdx++) {
                var btn = buttons[bIdx];
                var bt = (btn.textContent || btn.value || '').trim().toLowerCase();
                if (!/not contacted|not acquired|not sent|failed|unsuccessful/.test(bt) && /\b(contacted|already contacted|already contact|acquired|message sent|enquiry sent|successfully sent)\b/.test(bt)) {
                    return true;
                }
            }
        }

        if (card && card.id && this._acquiredLeadIds.has(String(card.id))) return true;

        if (lead) {
            // 2. Direct ID matches
            if (lead.uniqueQueryId && this._acquiredLeadIds.has(String(lead.uniqueQueryId))) return true;
            if (lead.leadId && this._acquiredLeadIds.has(String(lead.leadId))) return true;

        }
        return false;
    };

    Orchestrator.prototype._checkDynamicFilterChanges = function (forceRefresh) {
        var self = this;
        if (!this._supabaseEnabled || this._shutdown) return Promise.resolve(false);
        return this.supabase.loadFilters(forceRefresh === true).then(function (success) {
            return success ? self._applyFilters(self.supabase.getFilters()) : false;
        }).catch(function (err) { self.logger.warn('Filter synchronization failed', { error: err.message }); return false; });
    };

    // ============================================================
    // REFRESH SCAN WITHOUT WEBPAGE RELOAD
    // ============================================================
    Orchestrator.prototype.restartScan = function () {
        this.scanner.resetEmitted();
        this._checkDynamicFilterChanges(true);
        this._updateScannerLifecycleState('manual_rescan');
        if (!this._isPaused) this.scanner._scan();
    };

    // Emergency stop triggered when Scanner detects IndiaMART's rate-limit warning.
    // Halts the navigator and queue, marks the extension PAUSED, and shows a status message.
    Orchestrator.prototype._onRateLimitDetected = function (reason) {
        var self = this;
        try {
            var restrictionReason = reason || 'Platform rate limit or restriction banner detected';
            this.logger.warn('🛑 ' + restrictionReason + ' — pausing immediately. Auto-resume disabled.');
            
            // 1. Trip persistent circuit breaker
            if (this.circuitBreaker) {
                this.circuitBreaker.trip(restrictionReason);
            }

            // 2. Stop navigator loop and observers
            if (this.navigator && typeof this.navigator.stop === 'function') this.navigator.stop();
            if (this.scanner) this.scanner.stopWatching();
            window.postMessage({ __leadsync_stream_control__: 'pause' }, window.location.origin || '*');
            this.config.automationPaused = true;
            chrome.storage.local.set({ automationPaused: true });

            // 3. Pause action queue
            if (this.queue && typeof this.queue.pause === 'function') {
                this.queue.pause();
            } else if (this.queue) {
                this.queue._paused = true;
            }

            // 4. Clear timers

            if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
            this._stopRefreshCountdown('rate_limit_detected');

            this._isPaused = true;
            this._broadcastStatus();

            // 5. Update UI: persistent warning and status
            var statusEl = document.getElementById('bl-status-text');
            if (statusEl) {
                statusEl.textContent = '🛑 RESTRICTION DETECTED';
                statusEl.style.color = '#f44336';
            }
            var warnEl = document.getElementById('bl-warning-text');
            if (warnEl) {
                warnEl.textContent = '🛑 IndiaMART account restriction detected. Auto-resume disabled. Manual review required on platform before resuming.';
                warnEl.classList.add('show');
            }

            // 6. Show resume button, hide stop button
            var resumeBtn = document.getElementById('bl-resume-btn');
            if (resumeBtn) resumeBtn.style.display = 'inline-block';
            var stopBtn = document.getElementById('bl-stop-btn');
            if (stopBtn) stopBtn.style.display = 'none';

            if (this.showTopToast) {
                this.showTopToast('failed', 'Account Restriction Detected', 'Platform limit reached. Extension halted.', 8000);
            }
        } catch (e) {
            this.logger.error('Error handling rate limit detection: ' + (e && e.message));
        }
    };

    Orchestrator.prototype.setAutoScroll = function (e) {
        this.config.autoScroll = e;
        chrome.storage.local.set({ autoScroll: e });
        if (e) this.navigator.start(); else this.navigator.stop();
    };

    Orchestrator.prototype.setStrictCountry = function (enabled, countries, rejectUnknown) {
        this.config.strictCountryMode = enabled === true;
        if (Array.isArray(countries)) {
            this.config.allowedCountries = countries.map(function (c) { return String(c).toUpperCase().trim(); }).filter(function (c) { return c; });
        }
        if (rejectUnknown !== undefined) this.config.strictCountryRejectUnknown = rejectUnknown !== false;
        chrome.storage.local.set({
            strictCountryMode: this.config.strictCountryMode,
            allowedCountries: this.config.allowedCountries,
            strictCountryRejectUnknown: this.config.strictCountryRejectUnknown
        });
        this._revalidateObservedLeads('strict_country_changed');
        this.logger.info('🌍 Strict country ' + (this.config.strictCountryMode ? 'ON' : 'OFF'));
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.toggleSupabase = function (enabled) {
        var self = this;
        this._supabaseEnabled = enabled;
        this.config.supabaseEnabled = enabled;
        this.keywordManager.setSupabaseEnabled(enabled);
        chrome.storage.local.set({ supabaseEnabled: enabled });
        if (enabled) {
            return this.supabase.loadFilters(true).then(function (success) {
                if (!success) return false;
                self._lastFiltersSignature = undefined;
                var filtersArray = self.supabase.getFilters();
                self._applyFilters(filtersArray);
                self.supabase.updateFilterStatus(true);
                self._updateScannerLifecycleState('supabase_toggled_on');
                return self.duplicateManager.loadFromDb();
            }).then(function (result) { return result !== false; });
        } else {
            this.supabase._filters = [];
            this.supabase._filtersLoaded = false;
            this.keywordManager.extractFromSupabaseFilters([]);
            this._updateScannerLifecycleState('supabase_toggled_off');
            return Promise.resolve(true);
        }
    };

    Orchestrator.prototype.clearLocalDuplicateCache = function () {
        this.duplicateManager.clear();
        return Promise.resolve({ success: true, message: 'Duplicate cache cleared' });
    };

    Orchestrator.prototype.clearAllLocalData = function () {
        this.duplicateManager.clear();
        this.scanner.resetEmitted();
        // Deliberately preserve durable CRM jobs, uncertain attempts, safety state and user filters.
        return Promise.resolve({ success: true, message: 'Scan cache cleared; safety and pending CRM data preserved' });
    };

    // Called immediately when a lead is acquired.
    // Halts the hard-reload cycle so the page stays stable during contact.
    // The existing ▶ Resume button on the panel restarts everything.
    Orchestrator.prototype._pauseForLeadAcquired = function (lead) {
        try {
            // Continuous parallel scan: never stop the scanner or navigator
            this._cycleAcquiredThisScan = false;
            this._stopRefreshCountdown('lead_acquired');
            if (this.logger) this.logger.info('Lead acquired, continuing parallel scan: ' + (lead && lead.productName || lead && lead.leadId || 'lead'));
            this._broadcastStatus();
        } catch (e) { }
    };

    Orchestrator.prototype.emergencyStop = function () {
        this._isPaused = true;
        this.config.automationPaused = true;
        chrome.storage.local.set({ automationPaused: true });
        if (this.queue) this.queue.pause();
        this._scannerState = SCANNER_STATES.PAUSED;
        this._stopRefreshCountdown('emergency_stop');
        this.safety.emergencyStopFn ? this.safety.emergencyStopFn() : this.safety.emergencyStop();
        if (this.scanner) this.scanner.stopWatching();
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
        // Clear any pending-reload flags so a manual page refresh after pause
        // does NOT auto-resume the extension unexpectedly.
        try {
            sessionStorage.setItem('bl_scanner_auto_resume', 'false');
            sessionStorage.removeItem('bl_reload_pending');
            sessionStorage.removeItem('bl_last_reload_flag');
        } catch (e) { }
        try {
            if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                window.postMessage({ __leadsync_stream_control__: 'pause' }, '*');
            }
        } catch (e) { }
        this.logger.warn('🚨 EMERGENCY STOP ACTIVATED — Scanner & Navigator halted');
        this._stopTcpKeepAlive();
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.resume = function () {
        if (this.circuitBreaker && !this.circuitBreaker.isNormal()) {
            this.circuitBreaker.reset('user_action');
            this.logger.info('Circuit breaker reset by user action');
        }
        this._isPaused = false;
        this.config.automationPaused = false;
        chrome.storage.local.set({ automationPaused: false });
        this._cycleAcquiredThisScan = false;
        this.safety.resume();
        this.queue.resume();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(true);
        try {
            if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                window.postMessage({ __leadsync_stream_control__: 'resume' }, '*');
            }
        } catch (e) { }
        this.logger.info('▶ RESUMED by user — evaluating eligible filters');
        this._startPeriodicTasks();
        this._initTcpKeepAlive();
        this._updateScannerLifecycleState('user_resume');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.getStatus = function () {
        var kws = this.keywordManager.getAllKeywords();
        return {
            mode: this.config.mode, stats: this.stats,
            queue: this.queue.getStatus(), safety: this.safety.getStatus(),
            scanner: this.scanner.getStatus(), stateStats: this.stateMachine.getStats(),
            initialized: this._initialized, startupState: this._startupState, bridgeReady: this._bridgeReady, scannerState: this._scannerState, config: this.config,
            supabaseEnabled: this._supabaseEnabled,
            autoMinimize: this.config.autoMinimize,
            confirmationAnswer: this.config.confirmationAnswer,
            purchaseAction: this.config.purchaseAction,
            autoScroll: this.config.autoScroll,
            popupsHandled: this.popupManager.getCount(),
            dbConnected: this._supabaseEnabled && this.supabase.hasFreshFilters(),
            filtersFresh: this.supabase.hasFreshFilters(),
            filterAgeMs: this.supabase._filtersLoaded ? Math.max(0, Date.now() - this.supabase._filtersLastFetch) : null,
            knownLeads: this.duplicateManager._seen.size,
            navigator: this.navigator.getStatus(),
            keywordSource: this._supabaseEnabled ? 'supabase' : 'local',
            keywordCounts: { product: kws.product.length, negative: kws.negative.length, location: kws.location.length, required: kws.required.length },
            scoreWeights: this.scorer.weights,
            scorePenalties: this.scorer.penalties,
            preferredStates: this.scorer.preferredStates,
            preferredCountries: this.scorer.preferredCountries,
            strictCountryMode: this.config.strictCountryMode,
            allowedCountries: this.config.allowedCountries,
            strictCountryRejectUnknown: this.config.strictCountryRejectUnknown,
            countryBlocked: this.stats.countryBlocked
        };
    };

    Orchestrator.prototype.shutdown = function () {
        if (this._shutdown) return;
        this._shutdown = true;
        this._initialized = false;
        if (this._onPanelResize) window.removeEventListener('resize', this._onPanelResize);
        if (this._disposePanelDrag) this._disposePanelDrag();
        if (this._unsubscribeFilters) this._unsubscribeFilters();
        this.keywordManager._reactivationTimers.forEach(function (timer) { clearTimeout(timer); });
        this.keywordManager._reactivationTimers.clear();
        if (this.supabase._statsFlushTimer) clearTimeout(this.supabase._statsFlushTimer);
        if (this.supabase._filterStatusDebounceTimer) clearTimeout(this.supabase._filterStatusDebounceTimer);
        if (this.actionAdapter.cancelActive) this.actionAdapter.cancelActive();
        this.scanner.stopWatching();
        this.queue.pause();
        this._stopRefreshCountdown('shutdown');
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._manualRefreshTimer) clearTimeout(this._manualRefreshTimer);
        if (this._inactivityHeartbeatTimer) clearInterval(this._inactivityHeartbeatTimer);
        if (this._statsTimer) clearInterval(this._statsTimer);
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        if (this._statusPanelTimer) clearInterval(this._statusPanelTimer);
        if (this._filterWatchTimer) clearInterval(this._filterWatchTimer);
        if (this._bridgeTimer) clearTimeout(this._bridgeTimer);
        if (this._mandatory30SecTimer) clearInterval(this._mandatory30SecTimer);
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
    };

    // Keep dependency failures in the same persisted diagnostics as later startup
    // failures instead of throwing before the logger has even been initialized.
    if (!Core) {
        new Logger('Startup').logEvent({ level: 'ERROR', event: 'app.initialization.failed', reasonCode: 'SHARED_CORE_MISSING', error: 'LeadSync shared contracts are not loaded; update all extension files and reload the portal tab.' });
        _flushLogsNow();
        return;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.Logger = Logger;
        module.exports.StructuredLogger = Logger;
        module.exports.flushLogsNow = _flushLogsNow;
        module.exports.getDroppedLogsCount = function () { return _droppedLogsCount; };
        module.exports.getPersistenceErrorsCount = function () { return _persistenceErrorsCount; };
        module.exports.generateTraceId = generateTraceId;
        module.exports.generateOperationId = generateOperationId;
        Object.assign(module.exports, { normalizeText: normalizeText, extractAttributes: extractAttributes, tokenize: tokenize, wordBoundaryMatch: wordBoundaryMatch, LeadMatcher: LeadMatcher, PerformanceMetrics: PerformanceMetrics, LeadLifecycleManager: LeadLifecycleManager, LEAD_STATES: LEAD_STATES });
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // ============================================================
    // INIT — multi-injection guard
    // ============================================================
    // A document marker also survives an extension context replacement on this page.
    // Guard is a per-document DOM marker (NOT sessionStorage): it is shared by all content-script
    // worlds, resets automatically on every navigation/reload, and cannot get stuck if
    // beforeunload never fires. A heartbeat lets a fresh injection take over from an orphaned
    // instance (e.g. after the extension was reloaded/updated and the old context was invalidated).
    var _instanceId = 'bl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    var _docEl = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement : null;
    var _prevInstance = _docEl && typeof _docEl.getAttribute === 'function' ? _docEl.getAttribute('data-bl-instance') : null;
    var _prevBeat = (_docEl && typeof _docEl.getAttribute === 'function' ? parseInt(_docEl.getAttribute('data-bl-heartbeat') || '0', 10) : 0) || 0;
    var _prevAlive = !!_prevInstance && (Date.now() - _prevBeat) < 8000;
    try { sessionStorage.removeItem('__bl_v6_init__'); } catch (e) {} // legacy guard key, no longer used

    if (_prevAlive) {
        console.warn('[LeadSync] Instance ' + _prevInstance + ' is alive — skipping duplicate injection (' + _instanceId + ').');
    } else {
        var _initReason = 'cold_start';
        try {
            if (_prevInstance) _initReason = 'takeover_stale_instance';
            else if (sessionStorage.getItem('bl_reload_pending') === 'true' || sessionStorage.getItem('bl_last_reload_flag') === 'from_reload') _initReason = 'auto_reload';
        } catch (e) {}
        _initInfo.instanceId = _instanceId;
        _initInfo.reason = _initReason;
        if (_docEl && typeof _docEl.setAttribute === 'function') {
            _docEl.setAttribute('data-bl-instance', _instanceId);
            _docEl.setAttribute('data-bl-heartbeat', String(Date.now()));
        }
        if (_prevInstance) { try { document.dispatchEvent(new Event('bl-teardown')); } catch (e) {} }
        var _heartbeatTimer = setInterval(function () {
            try { if (_docEl && typeof _docEl.setAttribute === 'function') _docEl.setAttribute('data-bl-heartbeat', String(Date.now())); } catch (e) {}
        }, 2000);
        console.log('🚀 IndiaMART BuyLead Assistant v5.1.0 [' + _instanceId + ', ' + _initReason + ']');

        var orchestrator = new Orchestrator();
        window.orchestrator = orchestrator;

        // Teardown hook: a newer injection asked this instance to stop. Idempotent.
        var _tornDown = false;
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('bl-teardown', function () {
                if (_tornDown || _docEl.getAttribute('data-bl-instance') === _instanceId) return;
                _tornDown = true;
                clearInterval(_heartbeatTimer);
                try { orchestrator.shutdown(); } catch (e) {}
            });
        }

        var _pageMessageHandler = function (evt) {
            if (_tornDown || !evt || evt.source !== window || !evt.data || (evt.origin && evt.origin !== window.location.origin)) return;
            var data = evt.data;
            if (data.__leadsync_log__) { orchestrator.logger.logEvent(data); return; }
            if (data.__leadsync_bridge_ready__) {
                if (!orchestrator._bridgeReady) orchestrator.logger.info('network.bridge.ready', { reasonCode: 'MAIN_WORLD_ACK' });
                orchestrator._bridgeReady = true; clearTimeout(orchestrator._bridgeTimer); return;
            }
            if (data.__leadsync_lead_acquired__) { orchestrator.actionAdapter.handleNetworkResult(data); return; }
            if (data.__leadsync_passive_lead__ || data.__leadsync_network__ || data.type === '__leadsync_passive_lead__') {
                var at = Number(data.ts || data.timestamp) || Date.now();
                if (Date.now() - at > 30000 || at - Date.now() > 5000) return;
                var leads = Array.isArray(data.leads) ? data.leads : data.lead ? [data.lead] : [];
                orchestrator._onNetworkLeads(leads.slice(0, 5000).map(function (lead) { return { _rawApiLead: lead, observedAt: lead.observedAt || at }; }));
            }
        };
        window.addEventListener('message', _pageMessageHandler);
        var _storageHandler = function (changes, areaName) {
            if (_tornDown || areaName !== 'local') return;
            if (changes.cached_filters_v1) {
                var cache = changes.cached_filters_v1.newValue;
                if (cache && Array.isArray(cache.filters) && typeof cache.timestamp === 'number' && cache.timestamp <= Date.now() && Date.now() - cache.timestamp <= 60000 && (cache.requestStartedAt || cache.timestamp) >= (orchestrator.supabase._filtersRequestStartedAt || 0) && (cache.clientId || null) === (orchestrator.supabase._clientId || null)) {
                    orchestrator.supabase._filters = cache.filters;
                    orchestrator.supabase._filtersLoaded = true;
                    orchestrator.supabase._filtersLastFetch = cache.timestamp;
                    orchestrator.supabase._filtersRequestStartedAt = cache.requestStartedAt || cache.timestamp;
                    orchestrator._applyFilters(cache.filters);
                }
            }
            if (changes.filters_last_updated || changes.supabase_filters_cache || changes.active_filters) orchestrator._checkDynamicFilterChanges(true);
            if (changes.mode && changes.mode.newValue !== orchestrator.config.mode) orchestrator.setMode(changes.mode.newValue);
            if (changes.keywords && changes.keywords.newValue) {
                orchestrator.keywordManager._localKeywords = Object.assign({ product: [], negative: [], required: [], location: [] }, changes.keywords.newValue);
                orchestrator.keywordManager._rebuildKeywords();
                orchestrator._revalidateObservedLeads('local_keywords_changed');
            }
            if (changes.minScore && changes.minScore.newValue !== orchestrator.config.minScore) orchestrator.setMinScore(changes.minScore.newValue);
            if (changes.cooldownMs) { orchestrator.config.cooldownMs = changes.cooldownMs.newValue; orchestrator.safety.setCooldown(changes.cooldownMs.newValue); }
            if (changes.maxPerMinute || changes.maxPerHour || changes.maxPerDay || changes.maxPerSession) {
                ['maxPerMinute', 'maxPerHour', 'maxPerDay', 'maxPerSession'].forEach(function (key) { if (changes[key]) orchestrator.config[key] = changes[key].newValue; });
                orchestrator.safety.setLimits({ perMinute: orchestrator.config.maxPerMinute, perHour: orchestrator.config.maxPerHour, perDay: orchestrator.config.maxPerDay, perSession: orchestrator.config.maxPerSession });
            }
            if (changes.scoreWeights || changes.scorePenalties || changes.preferredStates || changes.preferredCountries) {
                ['scoreWeights', 'scorePenalties', 'preferredStates', 'preferredCountries'].forEach(function (key) { if (changes[key]) orchestrator.config[key] = changes[key].newValue; });
                orchestrator.scorer.setWeights(orchestrator.config.scoreWeights); orchestrator.scorer.setPenalties(orchestrator.config.scorePenalties);
                orchestrator.scorer.setPreferredStates(orchestrator.config.preferredStates); orchestrator.scorer.setPreferredCountries(orchestrator.config.preferredCountries);
                orchestrator._revalidateObservedLeads('scoring_options_changed');
            }
            if (changes.strictCountryMode || changes.allowedCountries || changes.strictCountryRejectUnknown) {
                if (changes.strictCountryMode) orchestrator.config.strictCountryMode = changes.strictCountryMode.newValue === true;
                if (changes.allowedCountries) orchestrator.config.allowedCountries = changes.allowedCountries.newValue || [];
                if (changes.strictCountryRejectUnknown) orchestrator.config.strictCountryRejectUnknown = changes.strictCountryRejectUnknown.newValue !== false;
                orchestrator._revalidateObservedLeads('country_options_changed');
            }
            if (changes.supabaseClientId) {
                orchestrator.supabase.setClientId(changes.supabaseClientId.newValue || null);
                orchestrator._lastFiltersSignature = undefined;
                orchestrator.keywordManager.extractFromSupabaseFilters([]);
                orchestrator._checkDynamicFilterChanges(true);
            }
            if (changes.supabaseEnabled && changes.supabaseEnabled.newValue !== orchestrator._supabaseEnabled) orchestrator.toggleSupabase(changes.supabaseEnabled.newValue === true);
            if (changes.bl_circuit_breaker && changes.bl_circuit_breaker.newValue) {
                var saved = changes.bl_circuit_breaker.newValue;
                orchestrator.circuitBreaker._state = saved.state;
                orchestrator.circuitBreaker._reason = saved.reason || '';
                if (saved.state !== 'NORMAL') orchestrator.emergencyStop();
            }
            if (changes.automationPaused) {
                if (changes.automationPaused.newValue === true && !orchestrator._isPaused) orchestrator.emergencyStop();
            }
            if (changes.stopSold || changes.skipSoldOut) {
                var value = changes.stopSold || changes.skipSoldOut;
                orchestrator.config.stopSold = value.newValue !== false;
                orchestrator.config.skipSoldOut = orchestrator.config.stopSold;
                orchestrator._updateStopSoldUI();
            }
        };
        if (chrome.storage.onChanged) chrome.storage.onChanged.addListener(_storageHandler);

        var _runtimeHandler = function (req, sender, sendResponse) {
            if (_tornDown || !req) return false;
            if (req.action === 'CRM_SYNC_RESULT') {
                if (req.success) {
                    if (!orchestrator._dbSyncedIds) orchestrator._dbSyncedIds = new Set();
                    if (!orchestrator._dbSyncedIds.has(req.uniqueQueryId)) { orchestrator._dbSyncedIds.add(req.uniqueQueryId); orchestrator.stats.dbSynced++; }
                } else orchestrator.logger.warn('crm.write.retry_pending', { error: req.error });
                sendResponse({ received: true }); return false;
            }
            switch (req.action) {
                case 'GET_STATUS': sendResponse(Object.assign({ success: true }, orchestrator.getStatus())); return true;
                case 'GET_CONFIG': sendResponse({ success: true, config: orchestrator.config }); return true;
                case 'UPDATE_FULL_CONFIG': orchestrator.updateFullConfig(req.config).then(function (ok) { sendResponse({ success: !!ok }); }); return true;
                case 'SET_MODE': orchestrator.setMode(req.mode).then(function (ok) { sendResponse({ success: !!ok, mode: orchestrator.config.mode }); }); return true;
                case 'SET_STOP_SOLD': orchestrator.setStopSold(req.enabled); sendResponse({ success: true }); break;
                case 'SET_LIMITS': orchestrator.setLimits(req.limits); sendResponse({ success: true }); break;
                case 'SET_MIN_SCORE': orchestrator.setMinScore(req.score); sendResponse({ success: true }); break;
                case 'SET_AUTO_MINIMIZE': orchestrator.setAutoMinimize(req.enabled); sendResponse({ success: true }); break;
                case 'SET_CONFIRMATION_ANSWER': orchestrator.setConfirmationAnswer(req.answer); sendResponse({ success: true }); break;
                case 'SET_PURCHASE_ACTION': orchestrator.setPurchaseAction(req.purchaseAction); sendResponse({ success: true }); break;
                case 'SET_AUTO_SCROLL': orchestrator.setAutoScroll(req.enabled); sendResponse({ success: true }); break;
                case 'SET_STRICT_COUNTRY': orchestrator.setStrictCountry(req.enabled, req.countries, req.rejectUnknown).then(function () { sendResponse({ success: true }); }); return true;
                case 'TOGGLE_SUPABASE': orchestrator.toggleSupabase(req.enabled).then(function (ok) { sendResponse({ success: !!ok }); }); return true;
                case 'EMERGENCY_STOP': orchestrator.emergencyStop().then(function () { sendResponse({ success: true }); }); return true;
                case 'RESUME': orchestrator.resume().then(function () { sendResponse({ success: true }); }); return true;
                case 'UPDATE_KEYWORDS': orchestrator.keywordManager.updateKeywords(req.keywords).then(function () { sendResponse({ success: true }); }); return true;
                case 'REFRESH_FILTERS':
                    if (!orchestrator._supabaseEnabled) { sendResponse({ success: false }); return false; }
                    orchestrator.supabase.loadFilters(true).then(function (success) {
                        if (success) orchestrator._applyFilters(orchestrator.supabase.getFilters());
                        sendResponse({ success: !!success, count: success ? orchestrator.supabase.getFilters().length : 0 });
                    }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
                    return true;
                case 'RESET_DUPLICATES': orchestrator.duplicateManager.clear(); sendResponse({ success: true }); break;
                case 'CLEAR_DUPLICATE_CACHE': orchestrator.clearLocalDuplicateCache().then(function (r) { sendResponse(r); }); return true;
                case 'CLEAR_ALL_LOCAL_DATA': orchestrator.clearAllLocalData().then(function (r) { sendResponse(r); }); return true;
                case 'GET_KEYWORDS_DEBUG':
                    sendResponse({
                        success: true,
                        active: orchestrator.keywordManager.getAllKeywords(),
                        local: orchestrator.keywordManager._localKeywords,
                        supabase: orchestrator.keywordManager._supabaseKeywords,
                        source: orchestrator._supabaseEnabled ? 'supabase' : 'local'
                    });
                    return true;
                case 'TEST_LOAD_MORE':
                    var btn = orchestrator.navigator._findLoadMoreButton();
                    if (btn) { btn.click(); sendResponse({ success: true }); }
                    else sendResponse({ success: false, error: 'No button' });
                    return true;
                case 'GET_LOGS': chrome.storage.local.get('logs', function (result) { sendResponse(result.logs || []); }); return true;
                case 'GET_ACQUISITION_LOGS':
                case 'GET_SESSION_ACQUISITIONS':
                    sendResponse({ success: true, logs: orchestrator._sessionAcquisitions || [] });
                    return true;
                case 'CLEAR_ACQUISITION_LOGS':
                    orchestrator._sessionAcquisitions = [];
                    orchestrator._persistSessionAcquisitions();
                    sendResponse({ success: true });
                    return true;
                case 'CLEAR_LOGS': chrome.storage.local.set({ logs: [] }, function () { sendResponse({ success: true }); }); return true;
                default: sendResponse({ success: false });
            }
            return true;
        };
        chrome.runtime.onMessage.addListener(_runtimeHandler);
        var _originalShutdown = orchestrator.shutdown.bind(orchestrator);
        orchestrator.shutdown = function () {
            if (_tornDown && this._shutdown) return;
            _tornDown = true;
            clearInterval(_heartbeatTimer);
            window.removeEventListener('message', _pageMessageHandler);
            if (chrome.storage.onChanged && chrome.storage.onChanged.removeListener) chrome.storage.onChanged.removeListener(_storageHandler);
            if (chrome.runtime.onMessage.removeListener) chrome.runtime.onMessage.removeListener(_runtimeHandler);
            _originalShutdown();
        };

        // Clear init guard on unload so the next page load (after reload) re-initializes correctly.
        // The guard only needs to prevent duplicate injection WITHIN the same page lifecycle.
        window.addEventListener('pagehide', function (event) {
            if (!event.persisted) orchestrator.shutdown();
            else {
                orchestrator._bfcacheWasPaused = orchestrator._isPaused;
                orchestrator._isPaused = true;
                orchestrator.queue.pause();
                orchestrator.scanner.stopWatching();
                orchestrator.navigator.stop();
                if (orchestrator.actionAdapter.cancelActive) orchestrator.actionAdapter.cancelActive();
                window.postMessage({ __leadsync_stream_control__: 'pause' }, window.location.origin);
            }
            clearInterval(_heartbeatTimer);
            _flushLogsNow();
        });
        window.addEventListener('pageshow', function (event) {
            if (!event.persisted || _tornDown) return;
            _heartbeatTimer = setInterval(function () { _docEl.setAttribute('data-bl-heartbeat', String(Date.now())); }, 2000);
            orchestrator._checkDynamicFilterChanges(true).finally(function () {
                chrome.storage.local.get(['automationPaused'], function (settings) {
                    if (_tornDown) return;
                    orchestrator._isPaused = orchestrator._bfcacheWasPaused || settings.automationPaused === true || !orchestrator.circuitBreaker.canExecute();
                    if (!orchestrator._isPaused) orchestrator.queue.resume();
                    orchestrator._updateScannerLifecycleState('bfcache_restored');
                });
            });
        });

        if (typeof window !== 'undefined') {
            window.Logger = Logger;
            window.StructuredLogger = Logger;
            window.__leadsync_logger__ = {
                Logger: Logger,
                StructuredLogger: Logger,
                flushLogsNow: _flushLogsNow,
                getDroppedLogsCount: function () { return _droppedLogsCount; },
                getPersistenceErrorsCount: function () { return _persistenceErrorsCount; },
                generateTraceId: generateTraceId,
                generateOperationId: generateOperationId,
                getQueue: function () { return _logQueue; }
            };
        }

        console.log('✅ LeadSync Ready — v5.1.0 (Reliability Engine)');
    }



})();
