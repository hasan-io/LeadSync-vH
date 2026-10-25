(function (root) {
'use strict';
// src/supabase-service.js
// Complete Supabase integration with data management
// Developed by Keyn Labs
// Version 5.1.0
// ============================================================================
// CHANGELOG v4.9.0
//   • insertLead returns { data, conflict, existingId } on 409 (no throw)
//   • getRecentLeads(limit, statuses) — optional status filter
//   • _flushStats early-returns if no filters cached
//   • Filters cache TTL: 30s → 10s
//   • updateFilterStatus debounced (5s coalesce window)
//   • markLeadContacted fires history insert in parallel (non-blocking)
//   • AbortController timeouts on all mutating fetches
//   • getFilterById() + getActiveFilterCount() helpers added
//   • healthCheck gets 5s timeout
//   • More robust _extractCount across PostgREST versions
// ============================================================================

const SUPABASE_URL = 'https://zvhuromubukylsxrsfiz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2aHVyb211YnVreWxzeHJzZml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwODI4MDYsImV4cCI6MjEwMzY1ODgwNn0.29J2uGHxFhPtEqRZvnXjaYpL-x4I0uEc2TT8u9d5PVw';

// Default network timeouts (ms)
const TIMEOUT_READ   = 15000;
const TIMEOUT_WRITE  = 15000;
const TIMEOUT_HEALTH = 5000;

class SupabaseService {
    constructor(options) {
        options = options || {};
        this._useProxy = options.useProxy !== false;
        this._filterListeners = [];
        this.url = SUPABASE_URL;
        this.key = SUPABASE_KEY;
        this.headers = {
            'apikey': this.key,
            'Authorization': 'Bearer ' + this.key,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };
        this.logger = null;
        this._filters = [];
        this._filtersLoaded = false;
        this._filtersLastFetch = 0;
        this._filtersRequestStartedAt = 0;
        this._filtersTTL = 10000; // Bound filter staleness; matching never waits on a read.
        this._filtersCacheKey = 'cached_filters_v1';
        this._filtersCacheTTL = 60000; // 60s storage cache TTL
        this._inFlightFetchPromise = null;
        this._clientId = null;
        this._scopeVersion = 0;
        this._statsBuffer = { scanned: 0, matched: 0, clicked: 0 };
        this._statsFlushTimer = null;
        this._statsPending = false;
        this._filterStatusLastPushed = 0;
        this._filterStatusPending = null;
    }

    // ============================================================
    // LOGGING (Privacy-Safe)
    // ============================================================
    setLogger(logger) {
        this.logger = logger;
    }

    _sanitizeLogData(data) {
        if (!data || typeof data !== 'object') return data;
        var clean = Array.isArray(data) ? [] : {};
        for (var k in data) {
            if (!data.hasOwnProperty(k)) continue;
            var val = data[k];
            var kLow = k.toLowerCase();
            if (kLow.indexOf('mobile') !== -1 || kLow.indexOf('phone') !== -1) {
                clean[k] = typeof val === 'string' && val.length > 4 ? '***' + val.slice(-4) : '***';
            } else if (kLow.indexOf('email') !== -1) {
                clean[k] = typeof val === 'string' && val.indexOf('@') !== -1 ? val.replace(/^.+@/, '***@') : '***';
            } else if (kLow.indexOf('token') !== -1 || kLow.indexOf('auth') !== -1 || kLow.indexOf('key') !== -1 || kLow.indexOf('cookie') !== -1) {
                clean[k] = '[REDACTED]';
            } else if (val && typeof val === 'object') {
                clean[k] = this._sanitizeLogData(val);
            } else {
                clean[k] = val;
            }
        }
        return clean;
    }

    _log(level, msgOrEvent, data) {
        if (!this.logger) return;
        var lvl = (level || 'info').toLowerCase();
        if (typeof this.logger.logEvent === 'function' && typeof msgOrEvent === 'string' && msgOrEvent.indexOf('.') !== -1) {
            var opts = Object.assign({}, data || {});
            opts.level = lvl.toUpperCase();
            opts.event = msgOrEvent;
            opts.component = 'SupabaseService';
            this.logger.logEvent(opts);
            return;
        }
        if (typeof this.logger[lvl] === 'function') {
            this.logger[lvl](msgOrEvent, this._sanitizeLogData(data));
        }
    }

    // ============================================================
    // FETCH HELPERS (AbortController timeouts)
    // ============================================================
    async _fetchWithTimeout(url, options, timeoutMs) {
        timeoutMs = timeoutMs || TIMEOUT_READ;

        // Try service worker proxy first (bypasses webpage CSP/CORS on IndiaMART)
        if (this._useProxy && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            try {
                var swResponse = await new Promise(function(resolve, reject) {
                    var timer = setTimeout(function() {
                        reject(new Error('Timeout after ' + timeoutMs + 'ms'));
                    }, timeoutMs);

                    var cleanOptions = options ? {
                        method: options.method || 'GET',
                        headers: options.headers || {},
                        body: options.body || undefined
                    } : undefined;

                    chrome.runtime.sendMessage({
                        action: 'SUPABASE_FETCH',
                        url: url,
                        options: cleanOptions,
                        timeoutMs: timeoutMs
                    }, function(response) {
                        clearTimeout(timer);
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else if (!response) {
                            reject(new Error('No response from service worker'));
                        } else if (response.error) {
                            reject(new Error(response.error));
                        } else {
                            resolve(response);
                        }
                    });
                });

                var headersMap = swResponse.headers || {};
                return {
                    ok: !!swResponse.ok,
                    status: swResponse.status || 0,
                    statusText: swResponse.statusText || '',
                    headers: {
                        get: function(name) {
                            return headersMap[(name || '').toLowerCase()] || null;
                        }
                    },
                    text: async function() {
                        return swResponse.body || '';
                    },
                    json: async function() {
                        return swResponse.body ? JSON.parse(swResponse.body) : null;
                    }
                };
            } catch (swErr) {
                // A timed-out mutation may already have committed. Never replay it through a second transport.
                if (options && !/^(GET|HEAD)$/i.test(options.method || 'GET')) throw swErr;
                // Read-only fallback is safe when the worker is temporarily unavailable.
                if (this.logger && typeof this.logger.debug === 'function') {
                    this.logger.debug('Service worker proxy unavailable (' + swErr.message + '), falling back to direct fetch');
                }
            }
        }

        // Direct fetch fallback
        var controller = new AbortController();
        var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
        try {
            var opts = Object.assign({}, options || {}, { signal: controller.signal });
            var res = await fetch(url, opts);
            var text = await res.text();
            clearTimeout(timer);
            return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, text: async function () { return text; }, json: async function () { return text ? JSON.parse(text) : null; } };
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                throw new Error('Timeout after ' + timeoutMs + 'ms');
            }
            throw err;
        }
    }

    // ============================================================
    // FILTERS - Fetch and cache
    // ============================================================
    /**
     * Load active filters. Cached for _filtersTTL ms.
     * @param {boolean} forceRefresh
     * @returns {Promise<Array>}
     */
    async loadFilters(forceRefresh) {
        var self = this;
        var now = Date.now();
        var scopeVersion = this._scopeVersion;

        // 1) In-flight coalescing — return existing shared promise if a network fetch is ongoing
        if (this._inFlightFetchPromise) {
            return this._inFlightFetchPromise;
        }

        // 2) In-memory cache — fast reads
        if (!forceRefresh && this._filtersLoaded && (now - this._filtersLastFetch) < this._filtersTTL) {
            this._log('debug', 'filters.cache.hit', {
                reasonCode: 'MEMORY_CACHE_VALID',
                context: { count: this._filters.length }
            });
            return true;
        }

        // 3) Storage cache — instant cold boot only (if within cache TTL)
        if (!forceRefresh && !this._filtersLoaded) {
            var cached = await this._readFiltersCache();
            if (scopeVersion !== this._scopeVersion) return false;
            if (cached && Array.isArray(cached.filters)) {
                var cacheAge = now - cached.timestamp;
                if (cacheAge <= this._filtersCacheTTL) {
                    var tCache0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    this._filters = cached.filters;
                    this._filtersLoaded = true;
                    this._filtersLastFetch = cached.timestamp;
                    this._filtersRequestStartedAt = cached.requestStartedAt || cached.timestamp;
                    var cacheDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tCache0;
                    this._log('info', 'filters.cache.hit', {
                        reasonCode: 'STORAGE_CACHE_VALID',
                        durationMs: cacheDuration,
                        context: {
                            count: this._filters.length,
                            ageSec: Math.round(cacheAge / 1000)
                        }
                    });

                    this._refreshFiltersInBackground();
                    return true;
                }
            }
        }

        this._log('debug', 'filters.cache.miss', {
            reasonCode: forceRefresh ? 'FORCE_REFRESH' : 'CACHE_EXPIRED'
        });

        // A concurrent cold-boot caller may have started a request while storage was being read.
        if (this._inFlightFetchPromise) return this._inFlightFetchPromise;
        // 4) Network fetch (coalesced)
        var pending = this._fetchFiltersFromNetwork().finally(function () {
            if (self._inFlightFetchPromise === pending) self._inFlightFetchPromise = null;
        });
        this._inFlightFetchPromise = pending;
        return pending;
    }

    async _fetchFiltersFromNetwork() {
        var syncOpId = 'op_sync_' + Date.now().toString(36);
        var tSync0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        var scopeVersion = this._scopeVersion;
        var clientId = this._clientId;
        var requestStartedAt = Date.now();
        this._log('info', 'filters.sync.started', { operationId: syncOpId });

        var maxRetries = 2;
        var attempt = 0;
        var lastErr = null;
        while (attempt < maxRetries) {
            try {
                var url = this.url + '/rest/v1/filters?is_active=eq.true&select=*&order=id.asc' + (clientId ? '&client_id=eq.' + encodeURIComponent(clientId) : '');
                var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
                if (!response.ok) throw new Error('HTTP ' + response.status);

                var data = await response.json();
                if (scopeVersion !== this._scopeVersion || requestStartedAt < this._filtersRequestStartedAt) return false;
                if (!Array.isArray(data)) throw new Error('Invalid filters response: expected an array');
                this._filters = data;
                this._filtersLoaded = true;
                this._filtersLastFetch = Date.now();
                this._filtersRequestStartedAt = requestStartedAt;



                // Write to storage cache only if semantic filter content changed (excluding updated_at / poll timestamps)
                var newSig = this._buildSemanticSignature(this._filters);
                var configChanged = this._lastWrittenFiltersSig !== newSig;
                var cacheWritten = await this._writeFiltersCache(this._filters);
                if (cacheWritten === false) return false;
                if (scopeVersion !== this._scopeVersion) return false;
                if (configChanged) {
                    this._lastWrittenFiltersSig = newSig;
                    this._log('info', 'filters.config.changed', {
                        operationId: syncOpId,
                        reasonCode: 'CONFIG_CHANGED',
                        context: { count: this._filters.length }
                    });
                } else {
                    this._log('debug', 'filters.config.unchanged', {
                        operationId: syncOpId,
                        reasonCode: 'CONFIG_UNCHANGED',
                        context: { count: this._filters.length }
                    });
                }

                this._notifyFilters();
                var syncDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tSync0;
                this._log('info', 'filters.sync.completed', {
                    operationId: syncOpId,
                    result: 'SUCCESS',
                    durationMs: syncDuration,
                    context: { count: this._filters.length }
                });
                return true;
            } catch (err) {
                lastErr = err;
                attempt++;
                if (attempt < maxRetries) {
                    await new Promise(function(r) { setTimeout(r, 50 * attempt); });
                }
            }
        }
        var failDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tSync0;
        this._log('error', 'filters.sync.completed', {
            operationId: syncOpId,
            result: 'FAILURE',
            reasonCode: 'NETWORK_TIMEOUT',
            durationMs: failDuration,
            error: lastErr ? { message: lastErr.message } : { message: 'Unknown error' }
        });
        return false;
    }

    _buildSemanticSignature(filters) {
        return (root.LeadSyncCore || (typeof require === 'function' && require('./lead-core.js'))).signature(filters);
    }

    _clientQuery() { return this._clientId ? '&client_id=eq.' + encodeURIComponent(this._clientId) : ''; }
    setClientId(clientId) {
        var next = clientId && clientId !== 'default' ? String(clientId) : null;
        if (next === this._clientId) return;
        this._clientId = next;
        this._scopeVersion++;
        // Old requests may finish, but their generation is ignored and cannot overwrite this scope.
        this._inFlightFetchPromise = null;
        this._filters = [];
        this._filtersLoaded = false;
        this._filtersLastFetch = 0;
        this._filtersRequestStartedAt = 0;
    }
    onFiltersChanged(fn) {
        this._filterListeners.push(fn);
        var self = this;
        return function () { self._filterListeners = self._filterListeners.filter(function (f) { return f !== fn; }); };
    }
    _notifyFilters() {
        var self = this;
        this._filterListeners.forEach(function (fn) { try { fn(self._filters); } catch (e) { self._log('warn', 'Filter listener failed', { error: e.message }); } });
    }
    _refreshFiltersInBackground() {
        if (this._inFlightFetchPromise) return this._inFlightFetchPromise;
        var self = this;
        var pending = this._fetchFiltersFromNetwork().finally(function () { if (self._inFlightFetchPromise === pending) self._inFlightFetchPromise = null; });
        this._inFlightFetchPromise = pending;
        return pending;
    }

    _readFiltersCache() {
        var self = this;
        return new Promise(function(resolve) {
            try {
                chrome.storage.local.get(self._filtersCacheKey, function(result) {
                    var cached = result && result[self._filtersCacheKey];
                    if (cached && typeof cached.timestamp === 'number' && (cached.clientId || null) === self._clientId && Date.now() >= cached.timestamp && Date.now() - cached.timestamp < self._filtersCacheTTL) {
                        resolve(cached);
                    } else {
                        resolve(null);
                    }
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    _writeFiltersCache(filters) {
        var self = this, clientId = this._clientId, requestStartedAt = this._filtersRequestStartedAt;
        return new Promise(function(resolve) {
            try {
                chrome.storage.local.get(self._filtersCacheKey, function(result) {
                    var existing = result && result[self._filtersCacheKey];
                    if (clientId !== self._clientId) { resolve(false); return; }
                    if (existing && Array.isArray(existing.filters) && (existing.clientId || null) === clientId && (existing.requestStartedAt || existing.timestamp) > requestStartedAt && existing.timestamp <= Date.now()) {
                        self._filters = existing.filters;
                        self._filtersLoaded = true;
                        self._filtersLastFetch = existing.timestamp;
                        self._filtersRequestStartedAt = existing.requestStartedAt || existing.timestamp;
                        self._notifyFilters();
                        resolve(false);
                        return;
                    }
                    var payload = {};
                    payload[self._filtersCacheKey] = { filters: filters, timestamp: self._filtersLastFetch, requestStartedAt: requestStartedAt, clientId: clientId };
                    chrome.storage.local.set(payload, function() { resolve(true); });
                });
            } catch (e) { resolve(true); } // In-memory matching remains usable when storage is unavailable.
        });
    }

    hasFreshFilters() { return this._filtersLoaded && Date.now() >= this._filtersLastFetch && Date.now() - this._filtersLastFetch <= this._filtersCacheTTL; }

    /** @returns {Array} Currently cached filters */
    getFilters() {
        return this._filters;
    }

    /**
     * Fetch a single filter by id. Always hits the network (no cache).
     * @param {number|string} id
     * @returns {Promise<Object|null>}
     */
    async getFilterById(id) {
        var scopeVersion = this._scopeVersion, requestStartedAt = Date.now();
        try {
            var url = this.url + '/rest/v1/filters?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1' + this._clientQuery();
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var arr = await response.json();
            if (scopeVersion !== this._scopeVersion || !Array.isArray(arr)) return null;
            var row = arr.length ? arr[0] : null;
            // A later exact reconciliation supersedes an older in-flight list response.
            // Do not renew the whole list's age from a read of only one filter.
            if (requestStartedAt >= this._filtersRequestStartedAt) {
                this._filtersRequestStartedAt = requestStartedAt;
                if (this._filtersLoaded) {
                    this._filters = this._filters.filter(function (f) { return String(f.id) !== String(id); });
                    if (row && row.is_active !== false && !row.deleted_at && !row.is_deleted) this._filters.push(row);
                    await this._writeFiltersCache(this._filters);
                    if (scopeVersion === this._scopeVersion) this._notifyFilters();
                }
            }
            return row;
        } catch (err) {
            this._log('warn', 'getFilterById failed', { id: id, error: err.message });
            return null;
        }
    }

    /**
     * Count of currently active filters.
     * @returns {Promise<number>}
     */
    async getActiveFilterCount() {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true&select=id' + this._clientQuery();
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var arr = await response.json();
            return Array.isArray(arr) ? arr.length : 0;
        } catch (err) {
            return 0;
        }
    }

    // ============================================================
    // FILTER STATUS (debounced — coalesces rapid calls)
    // ============================================================
    /**
     * Mark all active filters as running/not-running.
     * Debounced: rapid calls within 5s collapse into a single PATCH.
     * @param {boolean} isRunning
     * @returns {Promise<boolean>}
     */
    async updateFilterStatus(isRunning) {
        var now = Date.now();
        this._filterStatusPending = isRunning;

        // If a call was made < 5s ago with the same value, skip entirely
        if (this._filterStatusLastPushed &&
            (now - this._filterStatusLastPushed) < 5000 &&
            this._filterStatusLastPushed_value === isRunning) {
            return true;
        }

        // Coalesce: if we just fired, debounce
        if (this._filterStatusLastPushed && (now - this._filterStatusLastPushed) < 5000) {
            var self = this;
            if (this._filterStatusDebounceTimer) clearTimeout(this._filterStatusDebounceTimer);
            this._filterStatusDebounceTimer = setTimeout(function() {
                self._filterStatusDebounceTimer = null;
                self._doFilterStatusPush(self._filterStatusPending);
            }, 5000 - (now - this._filterStatusLastPushed));
            return false; // queued, not yet acknowledged
        }

        return this._doFilterStatusPush(isRunning);
    }

    async _doFilterStatusPush(isRunning) {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true' + this._clientQuery();
            var body = {
                is_running: isRunning,
                last_poll_time: new Date().toISOString()
            };
            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._filterStatusLastPushed = Date.now();
            this._filterStatusLastPushed_value = isRunning;
            this._log('debug', '📡 Filter status updated', { isRunning: isRunning });
            return true;
        } catch (err) {
            this._log('warn', 'Failed to update filter status', { error: err.message });
            return false;
        }
    }

    /** Temporarily disable only the observed active revision; return its persisted revision. */
    async deactivateFilter(filterId) {
        if (!filterId) return false;
        try {
            var current = this._filters.find(function (f) { return String(f.id) === String(filterId); });
            var url = this.url + '/rest/v1/filters?id=eq.' + encodeURIComponent(filterId) + '&is_active=eq.true' + this._clientQuery();
            if (current && current.updated_at) url += '&updated_at=eq.' + encodeURIComponent(current.updated_at);
            var body = { is_active: false, is_running: false, updated_at: new Date().toISOString() };
            var response = await this._fetchWithTimeout(url, { method: 'PATCH', headers: this.headers, body: JSON.stringify(body) }, TIMEOUT_WRITE);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var rows = await response.json();
            if (!Array.isArray(rows) || !rows[0] || !rows[0].updated_at) return false;
            if (current) Object.assign(current, rows[0]);
            return { success: true, updatedAt: rows[0].updated_at };
        } catch (err) {
            this._log('warn', 'Filter auto-deactivation not acknowledged', { filterId: filterId, error: err.message });
            return false;
        }
    }

    /** Never re-enable a deleted, edited, or manually disabled CRM revision. */
    async reactivateFilter(filterId, deactivationVersion) {
        if (!filterId) return false;
        try {
            // No recorded acknowledgement (including an old-extension migration): only accept
            // an already-active current row. Never guess that an inactive row was our own change.
            if (!deactivationVersion) {
                var current = await this.getFilterById(filterId);
                return !!current && current.is_active === true && !current.deleted_at && !current.is_deleted;
            }
            var url = this.url + '/rest/v1/filters?id=eq.' + encodeURIComponent(filterId) + '&is_active=eq.false&updated_at=eq.' + encodeURIComponent(deactivationVersion) + this._clientQuery();
            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH', headers: this.headers,
                body: JSON.stringify({ is_active: true, is_running: true, updated_at: new Date().toISOString() })
            }, TIMEOUT_WRITE);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var rows = await response.json();
            if (!Array.isArray(rows) || !rows.length) {
                // A newer active row is a manual re-enable; a newer inactive/deleted row is not.
                var latest = await this.getFilterById(filterId);
                return !!latest && latest.is_active === true && !latest.deleted_at && !latest.is_deleted;
            }
            var cached = this._filters.find(function (f) { return String(f.id) === String(filterId); });
            if (cached) Object.assign(cached, rows[0]);
            return true;
        } catch (err) {
            this._log('warn', 'Filter remains disabled pending CRM refresh', { filterId: filterId, error: err.message });
            return false;
        }
    }

    // ============================================================
    // LEADS - Check if exists
    // ============================================================
    /**
     * @param {string} uniqueQueryId
     * @returns {Promise<Object|null>}
     */
    async leadExists(uniqueQueryId, throwOnError) {
        try {
            var url = this.url + '/rest/v1/leads?unique_query_id=eq.' +
                encodeURIComponent(uniqueQueryId) +
                '&select=id,status,is_contacted,is_matched&limit=1';
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();
            if (!Array.isArray(data)) throw new Error('Invalid lead lookup representation');
            return data.length > 0 ? data[0] : null;
        } catch (err) {
            if (throwOnError) throw err;
            this._log('warn', 'Failed to check lead existence', { error: err.message, uniqueQueryId: uniqueQueryId });
            return null;
        }
    }

    // ============================================================
    // LEADS - Insert (409-aware)
    // ============================================================
    /**
     * Insert a lead. On 409 conflict, returns the existing row instead of throwing.
     * @param {Object} lead
     * @returns {Promise<{data: Object|null, conflict: boolean, existingId: number|string|null}>}
     */
    async insertLead(lead) {
        var body = {
            unique_query_id: lead.uniqueQueryId,
            query_type: lead.queryType || 'BUY_LEAD',
            query_time: lead.queryTime && !isNaN(Date.parse(lead.queryTime)) ? new Date(lead.queryTime).toISOString() : new Date().toISOString(),
            sender_name: lead.senderName || null,
            sender_mobile: lead.senderMobile || null,
            sender_mobile_alt: lead.senderMobileAlt || null,
            sender_phone: lead.senderPhone || null,
            sender_phone_alt: lead.senderPhoneAlt || null,
            sender_email: lead.senderEmail || null,
            sender_email_alt: lead.senderEmailAlt || null,
            sender_company: lead.senderCompany || null,
            sender_address: lead.senderAddress || null,
            sender_city: lead.senderCity || null,
            sender_state: lead.senderState || null,
            sender_pincode: lead.senderPincode || null,
            sender_country_iso: lead.senderCountryIso || null,
            subject: lead.subject || null,
            query_product_name: lead.queryProductName || null,
            query_message: lead.queryMessage || null,
            query_mcat_name: lead.queryMcatName || null,
            call_duration: lead.callDuration || null,
            receiver_mobile: lead.receiverMobile || null,
            is_matched: lead.isMatched || false,
            is_contacted: false,
            status: 'new'
        };

        var crmOpId = 'op_crm_' + Date.now().toString(36);
        var tCrm0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._log('info', 'crm.write.started', {
            operationId: crmOpId,
            traceId: lead.traceId || null,
            context: { uniqueQueryId: lead.uniqueQueryId }
        });

        try {
            var url = this.url + '/rest/v1/leads';
            var response = await this._fetchWithTimeout(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            var crmDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tCrm0;

            if (response.status === 409) {
                // Conflict — fetch existing row so caller can recover id
                this._log('debug', '🔁 Lead already exists (409)', { uniqueQueryId: lead.uniqueQueryId });
                var existing = await this.leadExists(lead.uniqueQueryId);
                if (!existing || !existing.id) throw new Error('Conflict row could not be recovered');
                this._log('info', 'crm.write.completed', {
                    operationId: crmOpId,
                    traceId: lead.traceId || null,
                    result: 'SUCCESS',
                    reasonCode: 'DUPLICATE_ROW_RECOVERED',
                    durationMs: crmDuration,
                    context: { uniqueQueryId: lead.uniqueQueryId, id: existing ? existing.id : null }
                });
                return {
                    data: existing,
                    conflict: true,
                    existingId: existing ? existing.id : null
                };
            }

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            var data = await response.json();
            var row = Array.isArray(data) ? data[0] : null;
            if (!row || !row.id) throw new Error('Lead insert returned no persisted row');
            this._log('info', 'crm.write.completed', {
                operationId: crmOpId,
                traceId: lead.traceId || null,
                result: 'SUCCESS',
                durationMs: crmDuration,
                context: { uniqueQueryId: lead.uniqueQueryId, id: row && row.id }
            });
            return { data: row, conflict: false, existingId: null };
        } catch (err) {
            var failDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tCrm0;
            this._log('error', 'crm.write.failed', {
                operationId: crmOpId,
                traceId: lead.traceId || null,
                result: 'FAILURE',
                reasonCode: err.message && err.message.indexOf('timeout') !== -1 ? 'CRM_TIMEOUT' : 'CRM_WRITE_ERROR',
                durationMs: failDuration,
                error: err
            });
            return { data: null, conflict: false, existingId: null, error: err.message };
        }
    }

    // ============================================================
    // LEADS - Update
    // ============================================================
    async updateLead(identifier, updates) {
        try {
            // Number = DB row PK; string = IndiaMART inquiry ID. Prefer explicit objects.
            var byRow = identifier && typeof identifier === 'object' && identifier.id != null;
            var rowId = byRow ? identifier.id : (typeof identifier === 'number' ? identifier : null);
            var queryId = identifier && typeof identifier === 'object' ? identifier.uniqueQueryId : identifier;
            if (rowId == null && !queryId) throw new Error('Missing lead identifier');
            var url = this.url + '/rest/v1/leads?' + (rowId != null ? 'id=eq.' + encodeURIComponent(rowId) : 'unique_query_id=eq.' + encodeURIComponent(queryId));
            // Confirmed success is monotonic, including concurrent/out-of-order PATCHes.
            var downgrade = updates.is_contacted !== true;
            if (downgrade) url += '&is_contacted=not.is.true&or=(status.is.null,status.neq.contacted)';
            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH', headers: this.headers,
                body: JSON.stringify(Object.assign({}, updates, { updated_at: new Date().toISOString() }))
            }, TIMEOUT_WRITE);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var rows = await response.json();
            if (!Array.isArray(rows) || !rows.length) {
                // An empty representation is not a successful write (RLS and no-row matches included).
                return false;
            }
            return true;
        } catch (err) {
            this._log('error', 'crm.write.failed', { error: err.message });
            return false;
        }
    }

    async markLeadMatched(identifier) { return this.updateLead(identifier, { is_matched: true, status: 'matched' }); }
    async markLeadContacted(identifier) { return this.updateLead(identifier, { is_contacted: true, is_matched: true, status: 'contacted' }); }

    async syncLead(lead, outcome) {
        // Durable write acceptance != database success. The MV3 worker owns retries after tab closure.
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage({ action: 'CRM_SYNC_LEAD', lead: lead, outcome: outcome || null }, function (response) {
                    var err = chrome.runtime.lastError;
                    resolve(err ? { queued: false, error: err.message } : (response || { queued: false, error: 'No worker acknowledgement' }));
                });
            } catch (e) { resolve({ queued: false, error: e.message }); }
        });
    }

    // ============================================================
    // LEAD HISTORY
    // ============================================================
    /**
     * Insert a lead_history row. Non-blocking wrapper is provided by caller.
     * @returns {Promise<boolean>}
     */
    async insertLeadHistory(leadId, action, details, contactedAt) {
        try {
            var url = this.url + '/rest/v1/lead_history';
            var body = {
                lead_id: leadId,
                action: action,
                action_details: typeof details === 'string' ? details : JSON.stringify(details || {}),
                contacted_at: contactedAt || null
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);
            var rows = await response.json();
            if (!Array.isArray(rows) || !rows[0] || rows[0].id == null) throw new Error('History write returned no persisted row');

            this._log('debug', '📝 History added', { leadId: leadId, action: action });
            return true;
        } catch (err) {
            this._log('warn', 'Failed to add history', { error: err.message });
            return false;
        }
    }

    // ============================================================
    // STATS - Buffered updates
    // ============================================================
    /**
     * Update filter stats. Buffered for 10s to avoid PATCH storms.
     */
    async updateFilterStats(scanned, matched, clicked) {
        this._statsBuffer.scanned = scanned;
        this._statsBuffer.matched = matched;
        this._statsBuffer.clicked = clicked;

        if (this._statsFlushTimer) return;
        if (this._statsPending) return;

        var self = this;
        this._statsFlushTimer = setTimeout(function() {
            self._statsFlushTimer = null;
            self._flushStats();
        }, 10000);
    }

    async _flushStats() {
        // Skip if no filters cached — PATCH would match zero rows
        if (!this._filters || this._filters.length === 0) {
            this._statsPending = false;
            return false;
        }

        this._statsPending = true;
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true' + this._clientQuery();
            var body = {
                stats_scanned: this._statsBuffer.scanned,
                stats_matched: this._statsBuffer.matched,
                stats_clicked: this._statsBuffer.clicked
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (response.ok) {
                var rows = await response.json();
                if (!Array.isArray(rows) || !rows.length) return false;
                this._log('debug', '📊 Stats flushed to DB', this._statsBuffer);
                return true;
            }
            if (!response.ok) {
                var errBody = '';
                try { errBody = await response.text(); } catch (e) { }
                this._log('debug', 'Stats flush non-OK response: HTTP ' + response.status + ' ' + errBody);
            }
            return false;
        } catch (err) {
            var errMsg = (err && err.message) ? err.message : String(err);
            this._log('warn', 'Stats flush failed: ' + errMsg, { error: errMsg });
            return false;
        } finally {
            this._statsPending = false;
        }
    }

    // ============================================================
    // BATCH - Fetch recent leads (for dedup cache)
    // ============================================================
    /**
     * Fetch recent leads. Optionally filter by status.
     * @param {number} limit
     * @param {string[]} [statuses] - e.g. ['rejected','skipped']
     * @returns {Promise<Array>}
     */
    async getRecentLeads(limit, statuses) {
        limit = limit || 100;
        try {
            var url = this.url + '/rest/v1/leads?select=unique_query_id,status,is_contacted&order=created_at.desc&limit=' + limit;
            if (Array.isArray(statuses) && statuses.length > 0) {
                url += '&status=in.(' + statuses.map(function(s) { return encodeURIComponent(s); }).join(',') + ')';
            }
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch (err) {
            this._log('warn', 'Failed to fetch recent leads', { error: err.message });
            return [];
        }
    }

    // ============================================================
    // DATA MANAGEMENT — CLEAR OPERATIONS
    // ============================================================

    async clearAllLeads() {
        try {
            var url = this.url + '/rest/v1/leads?id=gte.0';
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ All leads deleted');
            return { success: true, message: 'All leads deleted' };
        } catch (err) {
            this._log('error', '❌ Failed to clear leads', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async clearAllHistory() {
        try {
            var url = this.url + '/rest/v1/lead_history?id=gte.0';
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ All history deleted');
            return { success: true, message: 'All history deleted' };
        } catch (err) {
            this._log('error', '❌ Failed to clear history', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async resetFilterStats() {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true' + this._clientQuery();
            var body = {
                stats_scanned: 0,
                stats_matched: 0,
                stats_clicked: 0,
                is_running: false,
                updated_at: new Date().toISOString()
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._log('warn', '🔄 Filter stats reset');
            return { success: true, message: 'Stats reset' };
        } catch (err) {
            this._log('error', 'Failed to reset stats', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async clearLeadsBefore(dateISO) {
        if (!dateISO || typeof dateISO !== 'string') {
            return { success: false, error: 'Missing date' };
        }
        if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateISO)) {
            return { success: false, error: 'Invalid date format (expected YYYY-MM-DD or ISO)' };
        }

        try {
            var url = this.url + '/rest/v1/leads?created_at=lt.' + encodeURIComponent(dateISO);
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ Old leads deleted before ' + dateISO);
            return { success: true, message: 'Old leads deleted' };
        } catch (err) {
            this._log('error', 'Failed to delete old leads', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async getTableCounts() {
        try {
            var countHeaders = {
                'apikey': this.key,
                'Authorization': 'Bearer ' + this.key,
                'Range': '0-0',
                'Prefer': 'count=exact'
            };

            var results = await Promise.all([
                this._fetchWithTimeout(this.url + '/rest/v1/leads?select=id',        { headers: countHeaders }, TIMEOUT_READ),
                this._fetchWithTimeout(this.url + '/rest/v1/lead_history?select=id', { headers: countHeaders }, TIMEOUT_READ),
                this._fetchWithTimeout(this.url + '/rest/v1/filters?select=id',      { headers: countHeaders }, TIMEOUT_READ)
            ]);

            return {
                success: true,
                leads:   this._extractCount(results[0]),
                history: this._extractCount(results[1]),
                filters: this._extractCount(results[2])
            };
        } catch (err) {
            this._log('warn', 'Failed to get table counts', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    /**
     * Extract count from a PostgREST response header.
     * Handles both `Range: 0-0` + `Prefer: count=exact` and plain `content-range`.
     * Returns '?' if header is missing/malformed.
     */
    _extractCount(response) {
        try {
            if (!response || !response.headers || typeof response.headers.get !== 'function') return '?';
            var range = response.headers.get('content-range') || response.headers.get('Content-Range');
            if (range) {
                // Format: "0-0/123" or "*/123" or "0-9/*"
                var parts = range.split('/');
                if (parts[1] && parts[1] !== '*') {
                    var n = parseInt(parts[1], 10);
                    return isNaN(n) ? '?' : n;
                }
            }
            return '?';
        } catch (e) {
            return '?';
        }
    }

    // ============================================================
    // HEALTH CHECK
    // ============================================================
    /**
     * Ping the REST endpoint. 5s timeout.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            var response = await this._fetchWithTimeout(
                this.url + '/rest/v1/filters?select=id&limit=1',
                { headers: this.headers },
                TIMEOUT_HEALTH
            );
            return response.ok;
        } catch (err) {
            return false;
        }
    }

    /**
     * Force-refresh filters cache.
     * @returns {Promise<Array>}
     */
    async refresh() {
        this._filtersLastFetch = 0;
        this._filtersLoaded = false;
        return await this.loadFilters(true);
    }
}

// Export to window for content-script consumption and module for Node testing
root.SupabaseService = SupabaseService;
if (typeof module !== 'undefined' && module.exports) module.exports = SupabaseService;
})(typeof globalThis !== 'undefined' ? globalThis : this);
