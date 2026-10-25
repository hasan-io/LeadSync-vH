/* Shared, side-effect-free contracts for the MAIN/isolated worlds and MV3 worker. */
(function (root) {
    'use strict';
    var ID_FIELDS = ['uniqueQueryId', 'unique_query_id', 'query_id', 'queryId', 'QUERY_ID', 'leadId', 'lead_id', 'LEAD_ID', 'ETO_OFR_DISPLAY_ID', 'eto_ofr_display_id', 'offerid', 'offer_id', 'offerId', 'blid', 'blId', 'queryid', 'enquiryId', 'enquiry_id', 'ENQUIRY_ID'];
    var CARD_SELECTOR = '[class*="BuyLdC_cont"], .BLbp_card, [class*="BuyLdC_Card"], div[id*="id_BLCard"], [class*="BLCard"], [class*="bl_card"], [class*="bl-card"], [class*="listing_card"]';
    function id(value) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
        if (typeof value !== 'string' && typeof value !== 'number') return '';
        var s = String(value).trim();
        if (/^(?:null|undefined|none|false|true|nan|0)$/i.test(s)) return '';
        return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(s) ? s : '';
    }
    function leadIds(obj, allowGeneric) {
        if (!obj || typeof obj !== 'object') return [];
        var ids = new Set();
        ID_FIELDS.forEach(function (key) { var found = id(obj[key]); if (found) ids.add(found); });
        if (!ids.size && allowGeneric) { var generic = id(obj.id || obj.ID); if (generic) ids.add(generic); }
        return Array.from(ids);
    }
    function leadId(obj, allowGeneric) {
        var ids = leadIds(obj, allowGeneric);
        return ids.length === 1 ? ids[0] : '';
    }
    function elementLeadId(el) {
        if (!el || typeof el.getAttribute !== 'function') return '';
        var attrs = ['data-lead-id', 'data-query-id', 'data-blid', 'data-uqid'];
        var nodes = [el];
        if (el.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(el.querySelectorAll('[data-lead-id], [data-query-id], [data-blid], [data-uqid], [data-click-data], [onclick], a[href]')));
        var ids = new Set();
        function add(value) { var key = id(value); if (key) ids.add(key); }
        for (var n = 0; n < nodes.length; n++) {
            var node = nodes[n];
            for (var a = 0; a < attrs.length; a++) add(node.getAttribute(attrs[a]));
            try { leadIds(JSON.parse(node.getAttribute('data-click-data') || 'null'), false).forEach(add); } catch (e) { }
            var handler = node.getAttribute('onclick') || '';
            var calls = /\b(?:blTxnController\.)?submitLead\(\s*['"]?(\d{6,30})['"]?\s*\)/g;
            var call;
            while ((call = calls.exec(handler))) add(call[1]);
            var href = node.getAttribute('href') || '';
            try {
                var url = new URL(href, 'https://seller.indiamart.com/');
                if (url.protocol !== 'https:' || !/(?:^|\.)indiamart\.com$/i.test(url.hostname)) continue;
                var keys = ID_FIELDS.concat(['leadid', 'uqid']);
                for (var k = 0; k < keys.length; k++) add(url.searchParams.get(keys[k]));
            } catch (e) { }
            if (ids.size > 1) return ''; // A container with two inquiries is not one exact acquisition target.
        }
        // data-id, GLUSR/buyer IDs, and id_BLCardN may be positional/customer keys.
        // Without an inquiry-named attribute, link or portal CTA contract, do not guess.
        return ids.size === 1 ? ids.values().next().value : '';
    }
    function visible(el) {
        if (!el || el.isConnected === false || el.hidden) return false;
        try {
            if (root.getComputedStyle) {
                for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
                    var style = root.getComputedStyle(node);
                    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
                }
            }
            if (el.getBoundingClientRect) {
                var r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
            }
        } catch (e) { return false; }
        return true;
    }
    function priorityCards(doc, limit) {
        var all = doc && doc.querySelectorAll ? doc.querySelectorAll(CARD_SELECTOR) : [];
        var out = [];
        for (var i = 0; i < all.length && out.length < (limit || 5); i++) {
            var el = all[i];
            if (!visible(el)) continue;
            if (out.some(function (parent) { return parent.contains && parent.contains(el); })) continue;
            out.push(el);
        }
        return out;
    }
    function findCard(doc, inquiryId) {
        inquiryId = id(inquiryId);
        if (!inquiryId || !doc || !doc.querySelectorAll) return null;
        // Exact ID lookup is targeting, not a full-feed discovery scan. No text/HTML substring matching.
        var selectors = ['data-lead-id', 'data-query-id', 'data-blid', 'data-uqid'].map(function (a) { return '[' + a + '="' + inquiryId + '"]'; }).join(',');
        var targets = doc.querySelectorAll(selectors);
        for (var i = 0; i < targets.length; i++) {
            var card = targets[i].closest ? targets[i].closest(CARD_SELECTOR) : targets[i];
            if (card && visible(card) && elementLeadId(card) === inquiryId) return card;
        }
        var top = priorityCards(doc, 5);
        for (var t = 0; t < top.length; t++) if (elementLeadId(top[t]) === inquiryId) return top[t];
        return null;
    }
    function available(value) {
        if (value === true || value === 1) return true;
        if (typeof value !== 'string') return false;
        var s = value.trim().toLowerCase();
        return !!s && !/^(?:0|false|no|n|n\/a|na|null|undefined|none|unknown|not provided|not available|unavailable|-+)$/.test(s);
    }
    var COUNTRY_ALIASES = {
        india: 'IN', ind: 'IN', bharat: 'IN', 'pan india': 'IN', 'all india': 'IN',
        usa: 'US', 'united states of america': 'US', america: 'US', uk: 'GB', gbr: 'GB', england: 'GB', 'great britain': 'GB',
        uae: 'AE', are: 'AE', dubai: 'AE', sharjah: 'AE', 'abu dhabi': 'AE', 'south korea': 'KR', korea: 'KR',
        'sri lanka': 'LK', 'saudi': 'SA', 'holland': 'NL', 'deutschland': 'DE', 'bangladesh': 'BD', 'canada': 'CA'
    };
    var ISO_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
    try {
        var names = new Intl.DisplayNames(['en'], { type: 'region' });
        ISO_CODES.forEach(function (code) { COUNTRY_ALIASES[names.of(code).toLowerCase()] = code; });
    } catch (e) { Object.assign(COUNTRY_ALIASES, { 'united states': 'US', 'united kingdom': 'GB', australia: 'AU', germany: 'DE', france: 'FR', 'saudi arabia': 'SA' }); }
    function country(value) {
        var s = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (COUNTRY_ALIASES[s]) return COUNTRY_ALIASES[s];
        return ISO_CODES.indexOf(s.toUpperCase()) !== -1 ? s.toUpperCase() : '';
    }
    function firstCountry(lead, keys) {
        for (var i = 0; i < keys.length; i++) { var code = country(lead[keys[i]]); if (code) return code; }
        return '';
    }
    function countryFromLead(lead) {
        var code = firstCountry(lead, ['countryIso', 'senderCountryIso', 'country', 'country_iso']);
        if (code) return code;
        var segments = String(lead.location || '').split(/[,;|]/);
        for (var i = segments.length - 1; i >= 0; i--) {
            code = country(segments[i]);
            if (code) return code;
        }
        return '';
    }
    function first(obj, keys) {
        for (var i = 0; i < keys.length; i++) if (obj[keys[i]] != null && obj[keys[i]] !== '') return obj[keys[i]];
        return '';
    }
    function normalizeLead(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        var out = {
            uniqueQueryId: leadId(item, false) || null,
            queryProductName: String(first(item, ['queryProductName', 'productName', 'PRD_NAME', 'prd_name', 'product_name', 'subject', 'SUBJECT', 'title', 'TITLE'])).slice(0, 1000),
            queryMessage: String(first(item, ['queryMessage', 'query_message', 'message', 'MESSAGE', 'desc', 'DESC', 'description', 'DESCRIPTION', 'requirement', 'REQUIREMENT'])).slice(0, 12000),
            queryMcatName: String(first(item, ['queryMcatName', 'mcat_name', 'mcatName', 'MCAT_NAME', 'category'])).slice(0, 1000),
            senderCity: String(first(item, ['senderCity', 'city', 'CITY', 'GLUSR_USR_CITY', 'glusr_usr_city'])).slice(0, 200),
            senderState: String(first(item, ['senderState', 'state', 'STATE', 'GLUSR_USR_STATE', 'glusr_usr_state'])).slice(0, 200),
            senderCountryIso: firstCountry(item, ['senderCountryIso', 'countryIso', 'country_iso', 'country', 'COUNTRY', 'GLUSR_USR_COUNTRY_ISO', 'glusr_usr_country_iso']) || null,
            hasMobile: ['hasMobile', 'has_mobile', 'senderMobile', 'sender_mobile', 'mobile', 'MOBILE', 'GLUSR_USR_PH_MOBILE', 'glusr_usr_ph_mobile', 'mobile_alt', 'senderMobileAlt'].some(function (k) { return available(item[k]); }),
            hasPhone: ['hasPhone', 'has_phone', 'senderPhone', 'sender_phone', 'phone', 'PHONE', 'phone_alt', 'senderPhoneAlt'].some(function (k) { return available(item[k]); }),
            hasEmail: ['hasEmail', 'has_email', 'senderEmail', 'sender_email', 'email', 'EMAIL', 'GLUSR_USR_EMAIL', 'glusr_usr_email', 'email_alt', 'senderEmailAlt'].some(function (k) { return available(item[k]); }),
            hasWhatsapp: ['hasWhatsapp', 'hasWhatsApp', 'has_whatsapp', 'whatsapp', 'WHATSAPP'].some(function (k) { return available(item[k]); }),
            quantity: item.quantity || item.QUANTITY || null,
            queryTime: first(item, ['queryTime', 'query_time', 'created_at']) || '',
            availability: String(first(item, ['availability', 'lead_status', 'status'])).slice(0, 100),
            source: 'NETWORK_PASSIVE'
        };
        return out;
    }
    function stable(value) {
        if (Array.isArray(value)) return value.map(stable).sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); });
        if (value && typeof value === 'object') {
            var obj = {};
            Object.keys(value).sort().forEach(function (k) {
                if (!/^(?:updated_at|created_at|last_poll_time|is_running|stats_scanned|stats_matched|stats_clicked)$/.test(k)) obj[k] = stable(value[k]);
            });
            return obj;
        }
        return value;
    }
    function signature(filters) { return JSON.stringify(stable(filters || [])); }
    function classifyResponse(payload, httpStatus) {
        var data = payload;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
        var objects = [];
        function visit(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 4) return;
            if (Array.isArray(obj)) { obj.slice(0, 10).forEach(function (o) { visit(o, depth + 1); }); return; }
            objects.push(obj);
            ['DATA', 'data', 'result', 'response', 'RESULT', 'Response'].forEach(function (k) { visit(obj[k], depth + 1); });
        }
        visit(data, 0);
        var messages = objects.map(function (o) { return [o.message, o.MESSAGE, o.msg, o.error, o.ERROR, o.reason, o.description].filter(function (v) { return typeof v === 'string'; }).join(' '); }).join(' ').toLowerCase();
        var result = { success: false, acquisitionSuccess: false, contactSuccess: false, ambiguous: true, action: 'unknown', message: 'Acquisition response is not authoritative' };
        if (httpStatus === 429 || /unusually high activity|request limit|please wait 15 minutes/.test(messages)) return Object.assign(result, { ambiguous: false, action: 'account_blocked', code: 'RATE_LIMITED', message: 'IndiaMART request limit' });
        if (httpStatus === 401 || httpStatus === 403) return Object.assign(result, { ambiguous: false, action: 'account_blocked', code: 'SESSION_OR_ELIGIBILITY', message: 'Session expired or acquisition not permitted' });
        if (/sold out|already sold|no longer available|quota exhausted|already consumed/.test(messages)) return Object.assign(result, { ambiguous: false, action: 'lost_race', message: 'Lead no longer available' });
        if (/insufficient balance|balance exhausted|recharge|buy points/.test(messages)) return Object.assign(result, { ambiguous: false, action: 'account_blocked', code: 'INSUFFICIENT_BALANCE', message: 'Insufficient BuyLead balance' });
        if (/subscription expired|subscription required|renew subscription|upgrade plan/.test(messages)) return Object.assign(result, { ambiguous: false, action: 'account_blocked', code: 'SUBSCRIPTION_REQUIRED', message: 'Subscription action required' });
        if (/already (?:acquired|contacted|purchased)(?: by you)?/.test(messages)) return Object.assign(result, { ambiguous: false, action: 'already_acquired', message: 'Lead already acquired' });
        var negative = objects.some(function (o) {
            return o.success === false || o.SUCCESS === false || o.acquired === false ||
                /^(?:failed|failure|error|unsuccessful|rejected|denied)$/i.test(String(o.status || o.STATUS || '')) ||
                (o.error != null && o.error !== false && o.error !== '' && o.error !== 0) ||
                (o.ERROR != null && o.ERROR !== false && o.ERROR !== '' && o.ERROR !== 0) ||
                (o.CODE != null && !/^(?:200|0|success)$/i.test(String(o.CODE)));
        });
        if (negative || /\b(?:not successful|unsuccessful|could not|failed|failure|denied|not eligible)\b/.test(messages) || (httpStatus && httpStatus >= 400 && httpStatus < 500)) return Object.assign(result, { ambiguous: false, action: 'failed', message: 'IndiaMART rejected acquisition' });
        if (httpStatus && httpStatus >= 500) return result;
        // An HTTP/CODE 200 or a field named "mobile" alone is NOT business confirmation.
        var positive = objects.some(function (o) { return o.success === true || o.SUCCESS === true || o.acquired === true || o.is_contacted === true || /^(?:success|acquired|purchased|contacted)$/i.test(String(o.status || o.STATUS || '')); });
        if (positive || /\b(?:lead|buylead|contact|enquiry|inquiry|message|interest)\b.{0,35}\b(?:acquired|purchased|contacted|sent|consumed) successfully\b|\bsuccessfully (?:acquired|purchased|contacted|sent|consumed)\b/.test(messages)) return Object.assign(result, { success: true, acquisitionSuccess: true, contactSuccess: /\bcontacted\b|\b(?:message|enquiry|inquiry|interest) (?:was )?sent\b|\bsuccessfully sent\b/.test(messages), ambiguous: false, action: 'confirmed', message: 'Acquisition confirmed by correlated IndiaMART transaction' });
        return result;
    }
    function buyerContact(payload) {
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { return {}; } }
        var out = {};
        function walk(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 4) return;
            if (Array.isArray(obj)) { if (obj.length === 1) walk(obj[0], depth + 1); return; }
            [['senderMobile', ['senderMobile', 'sender_mobile', 'mobile', 'MOBILE', 'GLUSR_USR_PH_MOBILE']],
             ['senderPhone', ['senderPhone', 'sender_phone', 'phone', 'PHONE']],
             ['senderEmail', ['senderEmail', 'sender_email', 'email', 'EMAIL', 'GLUSR_USR_EMAIL']]].forEach(function (field) {
                if (out[field[0]]) return;
                for (var i = 0; i < field[1].length; i++) {
                    var value = obj[field[1][i]];
                    if (typeof value !== 'string' || value.length > 200) continue;
                    if (field[0] === 'senderEmail' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : /^\+?[\d ()-]{7,30}$/.test(value) && value.replace(/\D/g, '').length >= 7) { out[field[0]] = value; break; }
                }
            });
            ['DATA', 'data', 'result', 'response', 'Response', 'buyer', 'sender', 'contact'].forEach(function (key) { walk(obj[key], depth + 1); });
        }
        walk(payload, 0);
        return out;
    }
    function activePage(location) {
        try {
            var url = new URL(location.href);
            return /^(seller|app)\.indiamart\.com$/.test(url.hostname) && /\/(?:bltxn|buyleads)(?:\/|$)/i.test(url.pathname) && !/pastleads|past_leads|consumed|(?:pref|tab)=past/i.test(url.href);
        } catch (e) { return false; }
    }
    var api = { id: id, leadIds: leadIds, leadId: leadId, elementLeadId: elementLeadId, visible: visible, priorityCards: priorityCards, findCard: findCard, cardSelector: CARD_SELECTOR, available: available, country: country, countryFromLead: countryFromLead, normalizeLead: normalizeLead, signature: signature, classifyResponse: classifyResponse, buyerContact: buyerContact, activePage: activePage };
    root.LeadSyncCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
