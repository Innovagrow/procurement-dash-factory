/* UpBid operator console. Zero build: plain ES2020, no framework, no CDN. */
(function () {
  'use strict';

  /* =============================================================== constants */

  var API = '/api';
  var LS_KEY = 'upbid.apiKey';
  var LS_PREFS = 'upbid.prefs';
  var FEED_MAX = 200;
  var QUEUE_PAGE = 50;
  var JOBS_PAGE = 50;
  var HYDRATE_CONCURRENCY = 3;
  var POLL_MS = 15000;
  var REFRESH_MS = 30000;

  var ROUTES = ['#/live', '#/queue', '#/jobs', '#/profiles', '#/settings'];
  var DEFAULT_ROUTE = '#/live';

  /* Every event name the API is known to publish, plus the short aliases the
     dispatcher understands. EventSource only delivers events it is subscribed
     to by name, so the list has to be explicit. */
  var SSE_EVENTS = [
    'connected',
    'shutdown',
    'job',
    'job.new',
    'job.discovered',
    'job.updated',
    'job.rescore',
    'match',
    'match.scored',
    'match.created',
    'proposal',
    'proposal.created',
    'proposal.drafted',
    'proposal.updated',
    'proposal.approved',
    'proposal.rejected',
    'proposal.regenerate',
    'submission',
    'submission.created',
    'submission.result',
    'alert',
    'alert.raised',
    'oauth.connected',
    'oauth.disconnected',
    'profile.created',
    'profile.updated',
    'profile.deleted',
    'profile.toggled',
    'inbox.received',
    'heartbeat'
  ];

  var JOB_TYPES = ['HOURLY', 'FIXED', 'UNKNOWN'];
  var EXPERIENCE_LEVELS = ['ENTRY', 'INTERMEDIATE', 'EXPERT'];
  var FIXED_BID_STRATEGIES = ['PERCENT_OF_BUDGET', 'FLAT', 'HOURLY_ESTIMATE'];
  var PROPOSAL_TONES = ['professional', 'friendly', 'expert', 'concise'];
  var WEIGHT_KEYS = [
    'keywordMatch',
    'skillMatch',
    'budgetFit',
    'clientQuality',
    'competition',
    'freshness',
    'descriptionQuality',
    'categoryFit',
    'experienceFit',
    'llmRerank'
  ];
  var DEFAULT_WEIGHTS = {
    keywordMatch: 18,
    skillMatch: 18,
    budgetFit: 14,
    clientQuality: 16,
    competition: 10,
    freshness: 8,
    descriptionQuality: 6,
    categoryFit: 5,
    experienceFit: 5,
    llmRerank: 20
  };

  /* ================================================================= helpers */

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (character) {
      return ESCAPES[character];
    });
  }

  function nodeFromHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  function setHtml(node, html) {
    if (node) node.innerHTML = html;
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  function readStore(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return key === LS_PREFS ? JSON.parse(raw) : raw;
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      if (value === null || value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch (err) {
      /* Private mode or a full quota: preferences simply do not persist. */
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toTime(value) {
    if (!value) return null;
    var time = typeof value === 'number' ? value : Date.parse(value);
    return isNaN(time) ? null : time;
  }

  function relTime(value) {
    var time = toTime(value);
    if (time === null) return null;
    var seconds = Math.round((Date.now() - time) / 1000);
    var ahead = seconds < 0;
    seconds = Math.abs(seconds);
    var text;
    if (seconds < 60) text = seconds + 's';
    else if (seconds < 3600) text = Math.floor(seconds / 60) + 'm';
    else if (seconds < 86400) {
      var hours = Math.floor(seconds / 3600);
      var minutes = Math.floor((seconds % 3600) / 60);
      text = minutes > 0 ? hours + 'h ' + minutes + 'm' : hours + 'h';
    } else text = Math.floor(seconds / 86400) + 'd';
    return ahead ? 'in ' + text : text;
  }

  function absTime(value) {
    var time = toTime(value);
    if (time === null) return '';
    try {
      return new Date(time).toLocaleString();
    } catch (err) {
      return new Date(time).toISOString();
    }
  }

  function num(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    try {
      return value.toLocaleString();
    } catch (err) {
      return String(value);
    }
  }

  function money(value, currency) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var code = currency || 'USD';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        maximumFractionDigits: value % 1 === 0 ? 0 : 2
      }).format(value);
    } catch (err) {
      return '$' + Math.round(value).toLocaleString();
    }
  }

  function compactMoney(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    if (value >= 1000000) return '$' + (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (value >= 1000) return '$' + (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '$' + Math.round(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var candidate = arguments[i];
      if (typeof candidate === 'number' && isFinite(candidate)) return candidate;
    }
    return null;
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i += 1) {
      var candidate = arguments[i];
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function backoffDelay(attempt, base, cap) {
    var raw = Math.min(cap, base * Math.pow(2, attempt));
    return Math.round(raw / 2 + Math.random() * (raw / 2));
  }

  function mapLimit(items, limit, worker) {
    var index = 0;
    var runners = [];
    var size = Math.min(limit, items.length);
    for (var i = 0; i < size; i += 1) {
      runners.push(
        (function run() {
          if (index >= items.length) return Promise.resolve();
          var current = items[index];
          index += 1;
          return Promise.resolve(worker(current)).then(run, run);
        })()
      );
    }
    return Promise.all(runners);
  }

  /* =================================================================== store */

  var prefs = (function () {
    var stored = readStore(LS_PREFS, null) || {};
    return {
      sound: stored.sound === true,
      notify: stored.notify === true,
      paused: stored.paused === true,
      queueProfile: typeof stored.queueProfile === 'string' ? stored.queueProfile : ''
    };
  })();

  function savePrefs() {
    writeStore(LS_PREFS, prefs);
  }

  var state = {
    apiKey: readStore(LS_KEY, '') || '',
    authed: false,
    authRequired: true,
    route: DEFAULT_ROUTE,
    conn: 'offline',
    health: null,
    stats: null,
    profiles: [],
    feed: [],
    feedBuffer: [],
    queue: { ids: [], byId: {}, loading: false, error: null, focus: -1, loadedAt: 0 },
    jobs: {
      items: [],
      cursor: null,
      hasMore: false,
      loading: false,
      error: null,
      sort: { key: 'posted', dir: 'desc' },
      filters: { q: '', status: '', decision: '', profileId: '', minScore: 0 }
    },
    profileView: { selectedId: null, draft: null, formKey: '', saving: false, testing: false, test: null },
    pendingCount: 0
  };

  var dirty = {};
  var renderScheduled = false;

  function markDirty(section) {
    dirty[section] = true;
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      var sections = dirty;
      dirty = {};
      flushRender(sections);
    });
  }

  function flushRender(sections) {
    if (sections.chrome) renderChrome();
    if (sections.live) Live.render();
    if (sections.queue) Queue.render();
    if (sections.jobs) Jobs.render();
    if (sections.profiles) Profiles.render();
    if (sections.settings) Settings.render();
  }

  /* ===================================================================== api */

  function ApiError(status, message, payload) {
    this.name = 'ApiError';
    this.status = status;
    this.message = message || 'request failed';
    this.payload = payload || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function errorMessage(payload, fallback) {
    if (payload && payload.error && typeof payload.error.message === 'string') {
      var issues = asArray(payload.error.issues);
      return issues.length > 0 ? payload.error.message + ': ' + issues.join('; ') : payload.error.message;
    }
    if (payload && typeof payload.message === 'string' && payload.message !== '') return payload.message;
    return fallback;
  }

  function request(path, options) {
    var settings = options || {};
    var method = settings.method || 'GET';
    var idempotent = method === 'GET' || method === 'HEAD';
    var maxAttempts = settings.retries === undefined ? (idempotent ? 3 : 1) : settings.retries + 1;
    var timeout = settings.timeout || 20000;

    function attempt(count) {
      var controller = new AbortController();
      var timer = window.setTimeout(function () {
        controller.abort();
      }, timeout);

      var headers = { accept: 'application/json' };
      if (state.apiKey) headers['x-api-key'] = state.apiKey;
      if (settings.body !== undefined) headers['content-type'] = 'application/json';

      return window
        .fetch(API + path, {
          method: method,
          headers: headers,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          body: settings.body === undefined ? undefined : JSON.stringify(settings.body)
        })
        .then(
          function (response) {
            window.clearTimeout(timer);
            return response.text().then(function (text) {
              var payload = null;
              if (text) {
                try {
                  payload = JSON.parse(text);
                } catch (err) {
                  payload = null;
                }
              }

              if (response.ok) return payload;

              var retryable = response.status === 429 || response.status >= 500;
              if (retryable && count + 1 < maxAttempts) {
                return sleep(backoffDelay(count, 400, 4000)).then(function () {
                  return attempt(count + 1);
                });
              }

              if (response.status === 401) onUnauthorized();
              throw new ApiError(
                response.status,
                errorMessage(payload, 'HTTP ' + response.status + ' on ' + path),
                payload
              );
            });
          },
          function (err) {
            window.clearTimeout(timer);
            var aborted = err && err.name === 'AbortError';
            if (count + 1 < maxAttempts) {
              return sleep(backoffDelay(count, 400, 4000)).then(function () {
                return attempt(count + 1);
              });
            }
            throw new ApiError(0, aborted ? 'request timed out' : 'network error, the API is unreachable');
          }
        );
    }

    return attempt(0);
  }

  function query(params) {
    var search = new URLSearchParams();
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '' || value === false) return;
      search.set(key, String(value));
    });
    var text = search.toString();
    return text ? '?' + text : '';
  }

  var api = {
    session: function () {
      return request('/session', { retries: 1 });
    },
    login: function (apiKey) {
      return request('/login', { method: 'POST', body: { apiKey: apiKey } });
    },
    logout: function () {
      return request('/logout', { method: 'POST' });
    },
    health: function () {
      return request('/health', { retries: 1 });
    },
    stats: function () {
      return request('/stats');
    },
    jobs: function (params) {
      return request('/jobs' + query(params));
    },
    job: function (id) {
      return request('/jobs/' + encodeURIComponent(id));
    },
    rescore: function (id) {
      return request('/jobs/' + encodeURIComponent(id) + '/rescore', { method: 'POST', body: {} });
    },
    proposals: function (params) {
      return request('/proposals' + query(params));
    },
    proposal: function (id) {
      return request('/proposals/' + encodeURIComponent(id));
    },
    patchProposal: function (id, body) {
      return request('/proposals/' + encodeURIComponent(id), { method: 'PATCH', body: body });
    },
    approve: function (id) {
      return request('/proposals/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} });
    },
    reject: function (id, reason) {
      return request('/proposals/' + encodeURIComponent(id) + '/reject', {
        method: 'POST',
        body: reason ? { reason: reason } : {}
      });
    },
    regenerate: function (id) {
      return request('/proposals/' + encodeURIComponent(id) + '/regenerate', { method: 'POST', body: {} });
    },
    profiles: function () {
      return request('/profiles');
    },
    createProfile: function (body) {
      return request('/profiles', { method: 'POST', body: body });
    },
    updateProfile: function (id, body) {
      return request('/profiles/' + encodeURIComponent(id), { method: 'PUT', body: body });
    },
    deleteProfile: function (id) {
      return request('/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    toggleProfile: function (id, isActive) {
      return request('/profiles/' + encodeURIComponent(id) + '/toggle', {
        method: 'POST',
        body: isActive === undefined ? {} : { isActive: isActive }
      });
    },
    testProfile: function (id, body) {
      return request('/profiles/' + encodeURIComponent(id) + '/test', {
        method: 'POST',
        body: body,
        timeout: 45000
      });
    },
    oauthDisconnect: function () {
      return request('/oauth/upwork/disconnect', { method: 'POST' });
    }
  };

  function reportError(err, context) {
    var message = err && err.message ? err.message : String(err);
    if (err instanceof ApiError && err.status === 401) return;
    toast((context ? context + ': ' : '') + message, 'error');
  }

  /* ================================================================== toasts */

  var toastHost = null;

  function toast(message, kind, ttl) {
    if (!toastHost) toastHost = $('#toasts');
    if (!toastHost) return;
    var node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('data-kind', kind || 'info');
    node.textContent = message;
    toastHost.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, ttl || (kind === 'error' ? 7000 : 3800));
  }

  /* ==================================================== sound and desktop alerts */

  var audioContext = null;

  function beep(frequency) {
    if (!prefs.sound) return;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audioContext) audioContext = new Ctor();
      if (audioContext.state === 'suspended') audioContext.resume();
      var oscillator = audioContext.createOscillator();
      var gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency || 880;
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.24);
    } catch (err) {
      /* Audio is a nicety; never let it break the feed. */
    }
  }

  function desktopNotify(title, body) {
    if (!prefs.notify) return;
    if (!('Notification' in window) || window.Notification.permission !== 'granted') return;
    try {
      var notification = new window.Notification(title, { body: body, tag: 'upbid', renotify: false });
      window.setTimeout(function () {
        notification.close();
      }, 8000);
    } catch (err) {
      /* Some browsers refuse constructor notifications outside a service worker. */
    }
  }

  function requestNotifyPermission() {
    if (!('Notification' in window)) {
      toast('this browser has no desktop notifications', 'warn');
      return Promise.resolve(false);
    }
    if (window.Notification.permission === 'granted') return Promise.resolve(true);
    if (window.Notification.permission === 'denied') {
      toast('notifications are blocked in the browser settings', 'warn');
      return Promise.resolve(false);
    }
    return window.Notification.requestPermission().then(function (result) {
      return result === 'granted';
    });
  }

  /* ================================================================== chrome */

  function renderChrome() {
    var dot = $('#conn-dot');
    var label = $('#conn-label');
    if (dot) dot.setAttribute('data-state', state.conn);
    if (label) {
      label.textContent =
        state.conn === 'live'
          ? 'live'
          : state.conn === 'polling'
            ? 'polling'
            : state.conn === 'connecting'
              ? 'connecting'
              : 'offline';
    }

    var config = state.health && state.health.config ? state.health.config : null;
    var submitter = state.health ? state.health.submitter : null;

    var autoBadge = $('#badge-autosubmit');
    if (autoBadge) {
      var autoOn = config ? config.autoSubmit === true : null;
      var capable = submitter ? submitter.canAutoSubmit === true : false;
      autoBadge.textContent = autoOn === null ? 'AUTO_SUBMIT —' : autoOn ? 'AUTO_SUBMIT on' : 'AUTO_SUBMIT off';
      autoBadge.setAttribute('data-state', autoOn === null ? 'unknown' : autoOn ? (capable ? 'hot' : 'off') : 'off');
      autoBadge.title = autoOn
        ? capable
          ? 'A capable submitter is configured; high scores can go out without a tap.'
          : 'Enabled but no capable submitter: everything falls back to this review queue.'
        : 'Every proposal waits for a human tap in the queue.';
    }

    var dryBadge = $('#badge-dryrun');
    if (dryBadge) {
      var dryOn = config ? config.dryRun === true : null;
      dryBadge.textContent = dryOn === null ? 'DRY_RUN —' : dryOn ? 'DRY_RUN on' : 'DRY_RUN off';
      dryBadge.setAttribute('data-state', dryOn === null ? 'unknown' : dryOn ? 'hot' : 'off');
      dryBadge.title = dryOn ? 'Submissions are simulated and never leave the box.' : 'Submissions are real.';
    }

    var pending = $('#pending-count');
    if (pending) pending.textContent = String(state.pendingCount);
    var tabCount = $('#tab-queue-count');
    if (tabCount) {
      tabCount.textContent = String(state.pendingCount);
      tabCount.hidden = state.pendingCount === 0;
    }
    document.title = state.pendingCount > 0 ? '(' + state.pendingCount + ') UpBid Console' : 'UpBid Console';

    $$('.tab').forEach(function (tab) {
      if (tab.getAttribute('data-route') === state.route) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
  }

  /* ============================================================ shared render */

  function decisionOf(item) {
    var decision = item && item.decision;
    return decision === 'BID' || decision === 'REVIEW' || decision === 'SKIP' ? decision : null;
  }

  function scoreBadge(score, decision, small) {
    var value = typeof score === 'number' && isFinite(score) ? Math.round(score) : null;
    var klass = 'score-badge' + (small ? ' sm' : '') + (decision ? ' d-' + decision : '');
    return (
      '<span class="' +
      klass +
      '" title="' +
      esc(decision ? decision + ' at score ' + (value === null ? 'unknown' : value) : 'not scored yet') +
      '">' +
      (value === null ? '–' : value) +
      '</span>'
    );
  }

  function ageSpan(value, label, className) {
    var text = relTime(value);
    return (
      '<span class="' +
      (className || 'fi-age') +
      '" data-ago="' +
      esc(value || '') +
      '" data-ago-label="' +
      esc(label || '') +
      '" title="' +
      esc(absTime(value)) +
      '">' +
      esc(text === null ? 'time unknown' : (label ? label + ' ' : '') + text + ' ago') +
      '</span>'
    );
  }

  function tickAges() {
    if (document.hidden) return;
    $$('[data-ago]').forEach(function (node) {
      var value = node.getAttribute('data-ago');
      var label = node.getAttribute('data-ago-label') || '';
      var text = relTime(value);
      if (text === null) return;
      node.textContent = (label ? label + ' ' : '') + text + ' ago';
    });
  }

  function budgetLabel(job) {
    if (!job) return null;
    if (job.jobType === 'HOURLY' || (job.hourlyMin !== null && job.hourlyMin !== undefined)) {
      var low = money(job.hourlyMin, job.currency);
      var high = money(job.hourlyMax, job.currency);
      if (low && high && low !== high) return low + '–' + high + '/hr';
      if (low) return low + '/hr';
      if (high) return 'up to ' + high + '/hr';
      return 'hourly';
    }
    var fixed = money(job.budgetAmount, job.currency);
    return fixed ? fixed + ' fixed' : job.jobType === 'FIXED' ? 'fixed, no budget' : null;
  }

  function clientChips(job) {
    var chips = [];
    if (job.clientPaymentVerified === true) chips.push('<span class="chip ok">payment verified</span>');
    else if (job.clientPaymentVerified === false) chips.push('<span class="chip warn">unverified</span>');
    if (job.clientCountry) chips.push('<span class="chip">' + esc(job.clientCountry) + '</span>');
    var spend = compactMoney(job.clientTotalSpent);
    if (spend) chips.push('<span class="chip">' + esc(spend) + ' spent</span>');
    if (typeof job.clientAvgRating === 'number')
      chips.push('<span class="chip">' + esc(job.clientAvgRating.toFixed(2)) + ' rating</span>');
    if (typeof job.clientHireRate === 'number')
      chips.push('<span class="chip">' + Math.round(job.clientHireRate * 100) + '% hire rate</span>');
    return chips;
  }

  function redFlagsOf(value) {
    var flags = [];
    asArray(value).forEach(function (flag) {
      if (!flag || typeof flag !== 'object') return;
      flags.push({
        code: typeof flag.code === 'string' ? flag.code : 'flag',
        severity: flag.severity === 'HIGH' || flag.severity === 'MEDIUM' || flag.severity === 'LOW' ? flag.severity : 'LOW',
        message: typeof flag.message === 'string' ? flag.message : ''
      });
    });
    return flags;
  }

  function flagChips(flags) {
    return flags
      .map(function (flag) {
        return (
          '<span class="flag" data-sev="' +
          esc(flag.severity) +
          '" title="' +
          esc(flag.message) +
          '">' +
          esc(flag.code.replace(/_/g, ' ').toLowerCase()) +
          '</span>'
        );
      })
      .join('');
  }

  function breakdownHtml(items) {
    var rows = asArray(items);
    if (rows.length === 0) return '<p class="muted">No breakdown was stored for this match.</p>';
    return (
      '<div class="bd">' +
      rows
        .map(function (row) {
          var max = typeof row.max === 'number' && row.max > 0 ? row.max : 0;
          var points = typeof row.points === 'number' ? row.points : 0;
          var ratio = max > 0 ? clamp(points / max, 0, 1) : 0;
          var tone = ratio >= 0.66 ? 'high' : ratio >= 0.33 ? 'mid' : 'low';
          return (
            '<div class="bd-row">' +
            '<div class="bd-label"><span>' +
            esc(row.label || row.key || 'factor') +
            '</span><span class="bd-num">' +
            (Math.round(points * 10) / 10) +
            (max > 0 ? ' / ' + max : '') +
            '</span></div>' +
            '<div class="bd-bar"><div class="bd-fill" data-tone="' +
            tone +
            '" style="width:' +
            (ratio * 100).toFixed(1) +
            '%"></div></div>' +
            (row.detail ? '<div class="bd-detail">' + esc(row.detail) + '</div>' : '') +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  /* ================================================================ popover */

  var popover = null;

  function openPopover(anchor, html) {
    if (!popover) popover = $('#popover');
    if (!popover) return;
    popover.innerHTML = html;
    popover.hidden = false;
    var rect = anchor.getBoundingClientRect();
    var width = popover.offsetWidth;
    var left = clamp(rect.left + window.scrollX, 8, window.scrollX + window.innerWidth - width - 8);
    var top = rect.bottom + window.scrollY + 6;
    if (rect.bottom + popover.offsetHeight + 16 > window.innerHeight) {
      top = Math.max(window.scrollY + 8, rect.top + window.scrollY - popover.offsetHeight - 6);
    }
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  function closePopover() {
    if (popover) popover.hidden = true;
  }

  /* ================================================================== drawer */

  var drawerReturnFocus = null;

  function openDrawer(title, html, focusSource) {
    var drawer = $('#drawer');
    var scrim = $('#drawer-scrim');
    if (!drawer || !scrim) return;
    drawerReturnFocus = focusSource || document.activeElement;
    $('#drawer-title').textContent = title;
    setHtml($('#drawer-body'), html);
    scrim.hidden = false;
    drawer.hidden = false;
    drawer.focus();
  }

  function closeDrawer() {
    var drawer = $('#drawer');
    var scrim = $('#drawer-scrim');
    if (drawer) drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    if (drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
    drawerReturnFocus = null;
  }

  function jobDrawerHtml(job) {
    var matches = asArray(job.matches);
    var proposals = asArray(job.proposals);
    var best = matches[0] || null;

    var head =
      '<div class="row spread">' +
      '<div class="row">' +
      (best ? scoreBadge(best.score, best.decision) : scoreBadge(null, null)) +
      '<div><div class="q-title">' +
      esc(job.title) +
      '</div><div class="td-sub">' +
      esc(job.source) +
      ' · ' +
      esc(job.status) +
      ' · ' +
      esc(job.externalId) +
      '</div></div></div>' +
      '</div>' +
      '<div class="fi-meta">' +
      (budgetLabel(job) ? '<span class="chip strong">' + esc(budgetLabel(job)) + '</span>' : '') +
      (typeof job.proposalsCount === 'number' ? '<span class="chip">' + job.proposalsCount + ' proposals</span>' : '') +
      (typeof job.interviewingCount === 'number' ? '<span class="chip">' + job.interviewingCount + ' interviewing</span>' : '') +
      (typeof job.connectsRequired === 'number' ? '<span class="chip">' + job.connectsRequired + ' connects</span>' : '') +
      (job.experienceLevel ? '<span class="chip">' + esc(job.experienceLevel) + '</span>' : '') +
      (job.durationLabel ? '<span class="chip">' + esc(job.durationLabel) + '</span>' : '') +
      clientChips(job).join('') +
      '</div>' +
      '<div class="row mt2">' +
      ageSpan(job.postedAt || job.firstSeenAt, 'posted', 'muted') +
      '<a href="' +
      esc(job.url) +
      '" target="_blank" rel="noopener noreferrer">open on Upwork</a>' +
      '<button class="btn btn-xs" type="button" data-action="rescore" data-id="' +
      esc(job.id) +
      '">Rescore</button>' +
      '</div>';

    var skills = asArray(job.skills);
    var skillsHtml = skills.length
      ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">Skills</h3></div><div class="fi-meta">' +
        skills
          .map(function (skill) {
            return '<span class="chip">' + esc(skill) + '</span>';
          })
          .join('') +
        '</div></div>'
      : '';

    var questions = asArray(job.screeningQuestions);
    var questionsHtml = questions.length
      ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">Screening questions</h3></div><ul class="list-plain">' +
        questions
          .map(function (question) {
            return '<li>' + esc(question) + '</li>';
          })
          .join('') +
        '</ul></div>'
      : '';

    var matchHtml = matches.length
      ? matches
          .map(function (match) {
            var flags = redFlagsOf(match.redFlags);
            return (
              '<div class="panel"><div class="panel-head">' +
              scoreBadge(match.score, match.decision, true) +
              '<h3 class="panel-title">' +
              esc(match.profile ? match.profile.name : match.profileId) +
              '</h3>' +
              (typeof match.llmScore === 'number' ? '<span class="pill">LLM ' + match.llmScore + '</span>' : '') +
              '</div>' +
              (flags.length ? '<div class="fi-flags">' + flagChips(flags) + '</div>' : '') +
              (asArray(match.reasons).length
                ? '<ul class="list-plain mt2">' +
                  match.reasons
                    .map(function (reason) {
                      return '<li>' + esc(reason) + '</li>';
                    })
                    .join('') +
                  '</ul>'
                : '') +
              '<div class="mt3">' +
              breakdownHtml(match.breakdown) +
              '</div>' +
              (match.llmRationale ? '<p class="muted mt2">' + esc(match.llmRationale) + '</p>' : '') +
              '</div>'
            );
          })
          .join('')
      : '<div class="panel"><p class="muted">This job has not been scored against any profile yet.</p></div>';

    var proposalsHtml = proposals.length
      ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">Proposals</h3></div>' +
        proposals
          .map(function (proposal) {
            var submissions = asArray(proposal.submissions);
            return (
              '<div class="kv mt2"><div class="kv-row"><span class="kv-k">' +
              esc(proposal.profile ? proposal.profile.name : proposal.profileId) +
              '</span><span class="kv-v"><span class="pill ' +
              (proposal.status === 'SUBMITTED' ? 'ok' : proposal.status === 'REJECTED' ? 'bad' : 'warn') +
              '">' +
              esc(proposal.status) +
              '</span></span></div>' +
              '<div class="kv-row"><span class="kv-k">bid</span><span class="kv-v">' +
              esc(money(proposal.bidAmount) || money(proposal.hourlyRate) || '–') +
              '</span></div>' +
              '<div class="kv-row"><span class="kv-k">created</span><span class="kv-v">' +
              esc(absTime(proposal.createdAt)) +
              '</span></div>' +
              submissions
                .map(function (submission) {
                  return (
                    '<div class="kv-row"><span class="kv-k">' +
                    esc(submission.submitter) +
                    '</span><span class="kv-v">' +
                    esc(submission.status) +
                    (submission.message ? ' · ' + esc(submission.message) : '') +
                    '</span></div>'
                  );
                })
                .join('') +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      : '';

    return (
      '<div class="panel">' +
      head +
      '</div>' +
      skillsHtml +
      '<div class="panel"><div class="panel-head"><h3 class="panel-title">Description</h3></div><div class="desc">' +
      esc(job.description || '') +
      '</div></div>' +
      questionsHtml +
      matchHtml +
      proposalsHtml
    );
  }

  function openJobDrawer(jobId, source) {
    openDrawer('Loading job…', '<p class="muted">Fetching the job…</p>', source);
    api
      .job(jobId)
      .then(function (data) {
        if (!data || !data.job) throw new ApiError(404, 'job not found');
        $('#drawer-title').textContent = data.job.title;
        setHtml($('#drawer-body'), jobDrawerHtml(data.job));
      })
      .catch(function (err) {
        setHtml($('#drawer-body'), '<p class="form-error">' + esc(err.message) + '</p>');
        reportError(err, 'job details');
      });
  }

  /* ================================================================ live view */

  var Live = {
    host: null,
    empty: null,
    nodes: {},

    init: function () {
      Live.host = $('#feed');
      Live.empty = $('#feed-empty');

      $('#live-pause').addEventListener('click', function () {
        prefs.paused = !prefs.paused;
        savePrefs();
        if (!prefs.paused) Live.flushBuffer();
        Live.syncToggles();
      });

      $('#live-sound').addEventListener('click', function () {
        prefs.sound = !prefs.sound;
        savePrefs();
        Live.syncToggles();
        if (prefs.sound) beep(760);
      });

      $('#live-notify').addEventListener('click', function () {
        if (prefs.notify) {
          prefs.notify = false;
          savePrefs();
          Live.syncToggles();
          return;
        }
        requestNotifyPermission().then(function (granted) {
          prefs.notify = granted;
          savePrefs();
          Live.syncToggles();
          if (granted) desktopNotify('UpBid', 'Desktop alerts are on.');
        });
      });

      $('#live-clear').addEventListener('click', function () {
        state.feed = [];
        state.feedBuffer = [];
        Live.nodes = {};
        markDirty('live');
      });

      $('#live-flush').addEventListener('click', function () {
        Live.flushBuffer();
      });

      Live.host.addEventListener('click', function (event) {
        var button = event.target.closest('[data-action]');
        if (!button) return;
        var action = button.getAttribute('data-action');
        var id = button.getAttribute('data-id');
        if (action === 'why') Live.showWhy(button, id);
        else if (action === 'open-job') openJobDrawer(id, button);
      });

      Live.syncToggles();
    },

    syncToggles: function () {
      var pause = $('#live-pause');
      pause.textContent = prefs.paused ? 'Resume' : 'Pause';
      pause.setAttribute('aria-pressed', prefs.paused ? 'true' : 'false');
      var sound = $('#live-sound');
      sound.textContent = prefs.sound ? 'Sound on' : 'Sound off';
      sound.setAttribute('aria-pressed', prefs.sound ? 'true' : 'false');
      var notify = $('#live-notify');
      notify.textContent = prefs.notify ? 'Alerts on' : 'Alerts off';
      notify.setAttribute('aria-pressed', prefs.notify ? 'true' : 'false');
    },

    /** Merges an event or a polled job row into the feed, keyed by job id. */
    upsert: function (item, options) {
      if (!item || !item.jobId) return;
      var quiet = options && options.quiet;
      var existingIndex = -1;
      for (var i = 0; i < state.feed.length; i += 1) {
        if (state.feed[i].jobId === item.jobId) {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex >= 0) {
        var merged = Object.assign({}, state.feed[existingIndex]);
        Object.keys(item).forEach(function (key) {
          var value = item[key];
          if (value === null || value === undefined) return;
          if (Array.isArray(value) && value.length === 0) return;
          merged[key] = value;
        });
        state.feed[existingIndex] = merged;
        markDirty('live');
        return;
      }

      if (prefs.paused && !quiet) {
        state.feedBuffer.unshift(item);
        if (state.feedBuffer.length > FEED_MAX) state.feedBuffer.length = FEED_MAX;
        markDirty('live');
        return;
      }

      state.feed.unshift(item);
      if (state.feed.length > FEED_MAX) state.feed.length = FEED_MAX;

      if (!quiet && item.decision === 'BID') {
        beep(880);
        desktopNotify('BID ' + (item.score === null ? '' : item.score) + ' · ' + item.title, budgetLabel(item) || '');
      } else if (!quiet && item.decision === 'REVIEW') {
        beep(620);
      }

      markDirty('live');
    },

    flushBuffer: function () {
      if (state.feedBuffer.length === 0) return;
      state.feed = state.feedBuffer.concat(state.feed).slice(0, FEED_MAX);
      state.feedBuffer = [];
      markDirty('live');
    },

    itemHtml: function (item) {
      var chips = [];
      var budget = budgetLabel(item);
      if (budget) chips.push('<span class="chip strong">' + esc(budget) + '</span>');
      if (item.jobType && item.jobType !== 'UNKNOWN') chips.push('<span class="chip">' + esc(item.jobType) + '</span>');
      if (typeof item.proposalsCount === 'number') chips.push('<span class="chip">' + item.proposalsCount + ' bids</span>');
      if (typeof item.connectsRequired === 'number')
        chips.push('<span class="chip">' + item.connectsRequired + ' connects</span>');
      chips = chips.concat(clientChips(item));
      if (item.source) chips.push('<span class="chip">' + esc(item.source) + '</span>');
      if (item.profileName) chips.push('<span class="chip">' + esc(item.profileName) + '</span>');

      var flags = redFlagsOf(item.redFlags);

      return (
        scoreBadge(item.score, item.decision) +
        '<div class="fi-main">' +
        '<div class="fi-top">' +
        (item.url
          ? '<a class="fi-title" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.title) + '</a>'
          : '<span class="fi-title">' + esc(item.title) + '</span>') +
        ageSpan(item.postedAt || item.at, 'posted') +
        '</div>' +
        '<div class="fi-meta">' +
        chips.join('') +
        '</div>' +
        (flags.length ? '<div class="fi-flags">' + flagChips(flags) + '</div>' : '') +
        '<div class="fi-actions">' +
        '<button class="btn btn-xs" type="button" data-action="why" data-id="' + esc(item.jobId) + '">why</button>' +
        '<button class="btn btn-xs btn-ghost" type="button" data-action="open-job" data-id="' + esc(item.jobId) + '">details</button>' +
        '</div>' +
        '</div>'
      );
    },

    render: function () {
      if (!Live.host) return;

      var counts = { BID: 0, REVIEW: 0, SKIP: 0 };
      state.feed.forEach(function (item) {
        if (counts[item.decision] !== undefined) counts[item.decision] += 1;
      });
      $('#live-count').textContent = String(state.feed.length);
      $('#live-bid').textContent = String(counts.BID);
      $('#live-review').textContent = String(counts.REVIEW);
      $('#live-skip').textContent = String(counts.SKIP);

      var buffered = $('#live-buffered');
      buffered.hidden = state.feedBuffer.length === 0;
      $('#live-buffer-count').textContent = String(state.feedBuffer.length);

      show(Live.empty, state.feed.length === 0);

      var seen = {};
      var previous = Live.nodes;
      var next = {};
      var fragment = document.createDocumentFragment();

      state.feed.forEach(function (item) {
        var version = [item.score, item.decision, item.title, item.proposalsCount, (redFlagsOf(item.redFlags)).length].join('|');
        var node = previous[item.jobId];
        if (!node || node.getAttribute('data-version') !== version) {
          node = document.createElement('article');
          node.className = 'feed-item';
          node.setAttribute('data-id', item.jobId);
          node.setAttribute('data-version', version);
          node.innerHTML = Live.itemHtml(item);
        }
        node.setAttribute('data-decision', item.decision || 'NONE');
        next[item.jobId] = node;
        seen[item.jobId] = true;
        fragment.appendChild(node);
      });

      Live.nodes = next;
      Live.host.textContent = '';
      Live.host.appendChild(fragment);
    },

    showWhy: function (button, jobId) {
      var item = null;
      state.feed.forEach(function (entry) {
        if (entry.jobId === jobId) item = entry;
      });

      if (item && asArray(item.breakdown).length > 0) {
        openPopover(button, Live.whyHtml(item));
        return;
      }

      openPopover(button, '<p class="muted">Loading the score breakdown…</p>');
      api
        .job(jobId)
        .then(function (data) {
          var match = data && data.job ? asArray(data.job.matches)[0] : null;
          if (!match) {
            openPopover(button, '<p class="muted">This job has not been scored yet.</p>');
            return;
          }
          if (item) {
            item.breakdown = match.breakdown;
            item.redFlags = match.redFlags;
            item.reasons = match.reasons;
            item.score = match.score;
            item.decision = match.decision;
            markDirty('live');
          }
          openPopover(
            button,
            Live.whyHtml({
              score: match.score,
              decision: match.decision,
              breakdown: match.breakdown,
              redFlags: match.redFlags,
              reasons: match.reasons
            })
          );
        })
        .catch(function (err) {
          openPopover(button, '<p class="form-error">' + esc(err.message) + '</p>');
        });
    },

    whyHtml: function (item) {
      var flags = redFlagsOf(item.redFlags);
      var reasons = asArray(item.reasons);
      return (
        '<h3>Why ' +
        esc(item.decision || 'unscored') +
        (typeof item.score === 'number' ? ' at ' + item.score : '') +
        '</h3>' +
        breakdownHtml(item.breakdown) +
        (flags.length ? '<div class="fi-flags mt2">' + flagChips(flags) + '</div>' : '') +
        (reasons.length
          ? '<ul class="list-plain mt2">' +
            reasons
              .map(function (reason) {
                return '<li>' + esc(reason) + '</li>';
              })
              .join('') +
            '</ul>'
          : '')
      );
    }
  };

  /** Turns any known event payload into a feed row. */
  function feedItemFromEvent(name, data, at) {
    if (!data || typeof data !== 'object') return null;
    var job = data.job && typeof data.job === 'object' ? data.job : data;
    var match = data.match && typeof data.match === 'object' ? data.match : data;

    var jobId = firstString(data.jobId, job.id, job.jobId, data.id);
    if (!jobId) return null;

    return {
      jobId: jobId,
      title: firstString(data.title, job.title) || 'job ' + jobId,
      url: firstString(data.url, job.url),
      source: firstString(data.source, job.source),
      jobType: firstString(job.jobType, data.jobType),
      budgetAmount: firstNumber(job.budgetAmount, data.budgetAmount),
      hourlyMin: firstNumber(job.hourlyMin, data.hourlyMin),
      hourlyMax: firstNumber(job.hourlyMax, data.hourlyMax),
      currency: firstString(job.currency, data.currency),
      proposalsCount: firstNumber(job.proposalsCount, data.proposalsCount),
      connectsRequired: firstNumber(job.connectsRequired, data.connectsRequired),
      clientCountry: firstString(job.clientCountry, data.clientCountry),
      clientPaymentVerified:
        typeof job.clientPaymentVerified === 'boolean' ? job.clientPaymentVerified : null,
      clientTotalSpent: firstNumber(job.clientTotalSpent, data.clientTotalSpent),
      clientAvgRating: firstNumber(job.clientAvgRating, data.clientAvgRating),
      clientHireRate: firstNumber(job.clientHireRate, data.clientHireRate),
      postedAt: firstString(job.postedAt, data.postedAt, job.firstSeenAt, data.firstSeenAt),
      score: firstNumber(data.score, match.score),
      decision: decisionOf(data) || decisionOf(match),
      profileName: firstString(data.profileName, data.profile && data.profile.name),
      redFlags: asArray(data.redFlags || match.redFlags),
      reasons: asArray(data.reasons || match.reasons),
      breakdown: asArray(data.breakdown || match.breakdown),
      kind: name,
      at: at || new Date().toISOString()
    };
  }

  function feedItemFromJobRow(row) {
    var best = row.bestMatch || null;
    return {
      jobId: row.id,
      title: row.title,
      url: row.url,
      source: row.source,
      jobType: row.jobType,
      budgetAmount: row.budgetAmount,
      hourlyMin: row.hourlyMin,
      hourlyMax: row.hourlyMax,
      currency: row.currency,
      proposalsCount: row.proposalsCount,
      connectsRequired: row.connectsRequired,
      clientCountry: row.clientCountry,
      clientPaymentVerified: row.clientPaymentVerified,
      clientTotalSpent: row.clientTotalSpent,
      clientAvgRating: row.clientAvgRating,
      clientHireRate: row.clientHireRate,
      postedAt: row.postedAt || row.firstSeenAt,
      score: best ? best.score : null,
      decision: best ? best.decision : null,
      profileName: best && best.profile ? best.profile.name : null,
      redFlags: best ? best.redFlags : [],
      reasons: best ? best.reasons : [],
      breakdown: [],
      kind: 'poll',
      at: row.firstSeenAt
    };
  }

  /* =============================================================== queue view */

  var Queue = {
    host: null,
    nodes: {},

    init: function () {
      Queue.host = $('#queue');

      $('#queue-reload').addEventListener('click', function () {
        Queue.load(true);
      });

      $('#queue-profile').addEventListener('change', function (event) {
        prefs.queueProfile = event.target.value;
        savePrefs();
        Queue.load(true);
      });

      Queue.host.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-action]');
        if (!button) return;
        var card = button.closest('.q-card');
        if (!card) return;
        var id = card.getAttribute('data-id');
        var action = button.getAttribute('data-action');
        if (action === 'approve') Queue.approve(id);
        else if (action === 'reject') Queue.reject(id);
        else if (action === 'regenerate') Queue.regenerate(id);
        else if (action === 'save') Queue.save(id, true);
        else if (action === 'why') Queue.showWhy(button, id);
        else if (action === 'details') {
          var entry = state.queue.byId[id];
          if (entry && entry.jobId) openJobDrawer(entry.jobId, button);
        }
      });

      Queue.host.addEventListener('input', function (event) {
        var field = event.target;
        var card = field.closest ? field.closest('.q-card') : null;
        if (!card) return;
        var entry = state.queue.byId[card.getAttribute('data-id')];
        if (!entry) return;
        var role = field.getAttribute('data-role');
        if (role === 'cover') {
          entry.text = field.value;
          entry.dirty = true;
          Queue.updateCounter(card, entry);
        } else if (role === 'bid') {
          entry.bid = field.value;
          entry.dirty = true;
        } else if (role === 'reason') {
          entry.reason = field.value;
        }
      });

      Queue.host.addEventListener(
        'focusin',
        function (event) {
          var card = event.target.closest ? event.target.closest('.q-card') : null;
          if (!card) return;
          var index = state.queue.ids.indexOf(card.getAttribute('data-id'));
          if (index >= 0 && index !== state.queue.focus) {
            state.queue.focus = index;
            Queue.paintFocus();
          }
        },
        true
      );

      Queue.host.addEventListener(
        'blur',
        function (event) {
          var field = event.target;
          if (!field.getAttribute || field.getAttribute('data-role') !== 'cover') return;
          var card = field.closest('.q-card');
          if (!card) return;
          var entry = state.queue.byId[card.getAttribute('data-id')];
          if (entry && entry.dirty) Queue.save(card.getAttribute('data-id'), false);
        },
        true
      );
    },

    profileFor: function (profileId) {
      var found = null;
      state.profiles.forEach(function (profile) {
        if (profile.id === profileId) found = profile;
      });
      return found;
    },

    load: function (force) {
      if (state.queue.loading) return Promise.resolve();
      if (!force && Date.now() - state.queue.loadedAt < 2000) return Promise.resolve();
      state.queue.loading = true;
      state.queue.error = null;
      markDirty('queue');

      return api
        .proposals({
          status: 'PENDING_APPROVAL',
          limit: QUEUE_PAGE,
          profileId: prefs.queueProfile || undefined
        })
        .then(function (data) {
          var items = asArray(data && data.items);
          var ids = [];
          var byId = {};
          items.forEach(function (row) {
            var previous = state.queue.byId[row.id];
            ids.push(row.id);
            byId[row.id] = {
              id: row.id,
              jobId: row.jobId,
              profileId: row.profileId,
              list: row,
              detail: previous ? previous.detail : null,
              match: previous ? previous.match : null,
              loaded: previous ? previous.loaded : false,
              busy: false,
              text: previous && previous.dirty ? previous.text : previous ? previous.text : '',
              bid: previous && previous.dirty ? previous.bid : previous ? previous.bid : '',
              reason: previous ? previous.reason : '',
              dirty: previous ? previous.dirty === true : false,
              version: previous ? previous.version : 0
            };
          });

          state.queue.ids = ids;
          state.queue.byId = byId;
          state.queue.loading = false;
          state.queue.loadedAt = Date.now();
          state.queue.focus = ids.length > 0 ? clamp(state.queue.focus, 0, ids.length - 1) : -1;
          state.pendingCount = ids.length;
          markDirty('queue');
          markDirty('chrome');

          return Queue.hydrate(
            ids.filter(function (id) {
              return !byId[id].loaded;
            })
          );
        })
        .catch(function (err) {
          state.queue.loading = false;
          state.queue.error = err.message;
          markDirty('queue');
          reportError(err, 'approval queue');
        });
    },

    hydrate: function (ids) {
      if (ids.length === 0) return Promise.resolve();
      return mapLimit(ids, HYDRATE_CONCURRENCY, function (id) {
        return api
          .proposal(id)
          .then(function (data) {
            var entry = state.queue.byId[id];
            if (!entry || !data || !data.proposal) return;
            entry.detail = data.proposal;
            entry.match = data.match || null;
            entry.loaded = true;
            entry.version += 1;
            if (!entry.dirty) {
              entry.text = typeof data.proposal.coverLetter === 'string' ? data.proposal.coverLetter : '';
              var amount = data.proposal.bidAmount !== null && data.proposal.bidAmount !== undefined
                ? data.proposal.bidAmount
                : data.proposal.hourlyRate;
              entry.bid = amount === null || amount === undefined ? '' : String(amount);
            }
            markDirty('queue');
          })
          .catch(function (err) {
            var entry = state.queue.byId[id];
            if (entry) {
              entry.loaded = true;
              entry.error = err.message;
              entry.version += 1;
            }
            markDirty('queue');
          });
      });
    },

    cardHtml: function (entry) {
      var list = entry.list;
      var job = list.job || {};
      var detail = entry.detail;
      var profile = Queue.profileFor(entry.profileId);
      var maxChars = profile && typeof profile.proposalMaxChars === 'number' ? profile.proposalMaxChars : 1500;
      var score = entry.match ? entry.match.score : null;
      var decision = entry.match ? entry.match.decision : null;
      var hourly = job.jobType === 'HOURLY';
      var connects =
        list.connectsCost !== null && list.connectsCost !== undefined
          ? list.connectsCost
          : job.connectsRequired;

      var tags = [];
      var budget = budgetLabel(job);
      if (budget) tags.push('<span class="chip strong">' + esc(budget) + '</span>');
      if (typeof connects === 'number') tags.push('<span class="chip">' + connects + ' connects</span>');
      if (list.profile) tags.push('<span class="chip">' + esc(list.profile.name) + '</span>');
      if (job.source) tags.push('<span class="chip">' + esc(job.source) + '</span>');
      if (list.model) tags.push('<span class="chip">' + esc(list.model) + '</span>');
      if (list.editedByHuman) tags.push('<span class="chip warn">edited</span>');

      var flags = entry.match ? redFlagsOf(entry.match.redFlags) : [];
      var warnings = asArray(list.warnings);

      if (!entry.loaded) {
        return (
          '<div class="q-head">' +
          scoreBadge(score, decision) +
          '<div class="q-headmain">' +
          '<a class="q-title" href="' + esc(job.url || '#') + '" target="_blank" rel="noopener noreferrer">' + esc(job.title || 'Loading…') + '</a>' +
          '<div class="q-tags">' + tags.join('') + '</div>' +
          '</div></div>' +
          '<div class="q-skeleton" style="width:100%"></div>' +
          '<div class="q-skeleton" style="width:88%"></div>' +
          '<div class="q-skeleton" style="width:94%"></div>' +
          '<div class="q-skeleton" style="width:60%"></div>'
        );
      }

      if (entry.error) {
        return (
          '<div class="q-head">' +
          scoreBadge(score, decision) +
          '<div class="q-headmain"><div class="q-title">' + esc(job.title || entry.id) + '</div></div></div>' +
          '<p class="form-error">Could not load this proposal: ' + esc(entry.error) + '</p>'
        );
      }

      var answers = asArray(detail && detail.questionAnswers).filter(function (row) {
        return row && typeof row === 'object';
      });

      var length = (entry.text || '').length;
      var counterClass = length > maxChars ? 'counter over' : length > maxChars * 0.9 ? 'counter near' : 'counter';

      return (
        '<div class="q-head">' +
        scoreBadge(score, decision) +
        '<div class="q-headmain">' +
        '<a class="q-title" href="' + esc(job.url || '#') + '" target="_blank" rel="noopener noreferrer">' + esc(job.title || entry.id) + '</a>' +
        '<div class="q-tags">' + tags.join('') + '</div>' +
        (flags.length ? '<div class="fi-flags">' + flagChips(flags) + '</div>' : '') +
        '<div class="row mt2">' +
        ageSpan(job.postedAt, 'posted', 'muted') +
        '<button class="btn btn-xs" type="button" data-action="why">why</button>' +
        '<button class="btn btn-xs btn-ghost" type="button" data-action="details">job details</button>' +
        '</div>' +
        '</div></div>' +
        '<div class="q-body">' +
        '<label class="field-label" for="cl-' + esc(entry.id) + '">Cover letter</label>' +
        '<textarea class="textarea q-letter" id="cl-' + esc(entry.id) + '" data-role="cover" spellcheck="true">' +
        esc(entry.text) +
        '</textarea>' +
        '<div class="' + counterClass + '"><span><b data-role="count">' + length + '</b> / ' + maxChars + ' characters</span>' +
        '<span data-role="dirty">' + (entry.dirty ? 'unsaved' : 'saved') + '</span></div>' +
        '<div class="q-grid">' +
        '<label class="field"><span class="field-label" for="bid-' + esc(entry.id) + '">' +
        (hourly ? 'Hourly rate' : 'Bid amount') +
        '</span><input class="input" id="bid-' + esc(entry.id) + '" data-role="bid" type="number" min="0" step="1" value="' +
        esc(entry.bid) +
        '" inputmode="decimal" /></label>' +
        '<label class="field"><span class="field-label" for="reason-' + esc(entry.id) + '">Reject reason (optional)</span>' +
        '<input class="input" id="reason-' + esc(entry.id) + '" data-role="reason" type="text" maxlength="500" value="' +
        esc(entry.reason || '') +
        '" /></label>' +
        '</div>' +
        (answers.length
          ? '<div class="qa-list">' +
            answers
              .map(function (row) {
                return (
                  '<div class="qa-item"><div class="qa-q">' +
                  esc(row.question || 'question') +
                  '</div><div class="qa-a">' +
                  esc(row.answer || '') +
                  '</div></div>'
                );
              })
              .join('') +
            '</div>'
          : '') +
        (warnings.length
          ? '<div class="q-warnings">' +
            warnings
              .map(function (warning) {
                return '<span class="flag" data-sev="MEDIUM">' + esc(warning) + '</span>';
              })
              .join('') +
            '</div>'
          : '') +
        '</div>' +
        '<div class="q-actions">' +
        '<button class="btn btn-primary" type="button" data-action="approve">Approve</button>' +
        '<button class="btn btn-danger" type="button" data-action="reject">Reject</button>' +
        '<button class="btn btn-wide btn-ghost" type="button" data-action="regenerate">Regenerate</button>' +
        '<button class="btn btn-wide btn-ghost" type="button" data-action="save">Save draft</button>' +
        '</div>'
      );
    },

    updateCounter: function (card, entry) {
      var profile = Queue.profileFor(entry.profileId);
      var maxChars = profile && typeof profile.proposalMaxChars === 'number' ? profile.proposalMaxChars : 1500;
      var counter = card.querySelector('.counter');
      var count = card.querySelector('[data-role="count"]');
      var dirtyMark = card.querySelector('[data-role="dirty"]');
      var length = (entry.text || '').length;
      if (count) count.textContent = String(length);
      if (dirtyMark) dirtyMark.textContent = entry.dirty ? 'unsaved' : 'saved';
      if (counter) {
        counter.className = length > maxChars ? 'counter over' : length > maxChars * 0.9 ? 'counter near' : 'counter';
      }
    },

    render: function () {
      if (!Queue.host) return;

      var select = $('#queue-profile');
      if (select && select.options.length - 1 !== state.profiles.length) {
        select.innerHTML =
          '<option value="">All profiles</option>' +
          state.profiles
            .map(function (profile) {
              return '<option value="' + esc(profile.id) + '">' + esc(profile.name) + '</option>';
            })
            .join('');
        select.value = prefs.queueProfile;
      }

      var empty = $('#queue-empty');
      show(empty, !state.queue.loading && state.queue.ids.length === 0);

      var previous = Queue.nodes;
      var next = {};
      var order = [];

      state.queue.ids.forEach(function (id) {
        var entry = state.queue.byId[id];
        if (!entry) return;
        var version = entry.version + ':' + (entry.loaded ? 'y' : 'n') + ':' + (entry.busy ? 'b' : '-');
        var node = previous[id];
        if (!node || node.getAttribute('data-version') !== version) {
          node = document.createElement('article');
          node.className = 'q-card';
          node.setAttribute('data-id', id);
          node.setAttribute('data-version', version);
          node.innerHTML = Queue.cardHtml(entry);
        }
        node.classList.toggle('is-busy', entry.busy === true);
        next[id] = node;
        order.push(node);
      });

      Queue.nodes = next;

      var current = Array.prototype.slice.call(Queue.host.children);
      var same = current.length === order.length;
      if (same) {
        for (var i = 0; i < order.length; i += 1) {
          if (current[i] !== order[i]) {
            same = false;
            break;
          }
        }
      }
      if (!same) {
        var fragment = document.createDocumentFragment();
        order.forEach(function (node) {
          fragment.appendChild(node);
        });
        Queue.host.textContent = '';
        Queue.host.appendChild(fragment);
      }

      Queue.paintFocus();
    },

    paintFocus: function () {
      var focusId = state.queue.ids[state.queue.focus];
      Object.keys(Queue.nodes).forEach(function (id) {
        Queue.nodes[id].classList.toggle('is-focused', id === focusId);
      });
    },

    move: function (delta) {
      if (state.queue.ids.length === 0) return;
      var next = state.queue.focus < 0 ? 0 : clamp(state.queue.focus + delta, 0, state.queue.ids.length - 1);
      state.queue.focus = next;
      Queue.paintFocus();
      var node = Queue.nodes[state.queue.ids[next]];
      if (node) node.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    },

    focusedId: function () {
      return state.queue.ids[state.queue.focus] || null;
    },

    focusEditor: function () {
      var id = Queue.focusedId();
      if (!id) return;
      var node = Queue.nodes[id];
      if (!node) return;
      var textarea = node.querySelector('[data-role="cover"]');
      if (textarea) textarea.focus();
    },

    save: function (id, loud) {
      var entry = state.queue.byId[id];
      if (!entry || !entry.dirty || entry.busy) return Promise.resolve();
      var body = { coverLetter: entry.text };
      var amount = parseFloat(entry.bid);
      var hourly = entry.list && entry.list.job && entry.list.job.jobType === 'HOURLY';
      if (!isNaN(amount)) {
        if (hourly) body.hourlyRate = amount;
        else body.bidAmount = amount;
      }

      return api
        .patchProposal(id, body)
        .then(function () {
          entry.dirty = false;
          var node = Queue.nodes[id];
          if (node) Queue.updateCounter(node, entry);
          if (loud) toast('draft saved', 'success');
        })
        .catch(function (err) {
          reportError(err, 'saving the draft');
        });
    },

    /** Optimistic: the card leaves at once and comes back if the API refuses. */
    withdraw: function (id) {
      var index = state.queue.ids.indexOf(id);
      if (index < 0) return null;
      var entry = state.queue.byId[id];
      state.queue.ids.splice(index, 1);
      delete state.queue.byId[id];
      state.pendingCount = state.queue.ids.length;
      if (state.queue.focus >= state.queue.ids.length) state.queue.focus = state.queue.ids.length - 1;
      markDirty('queue');
      markDirty('chrome');
      return { index: index, entry: entry };
    },

    restore: function (snapshot) {
      if (!snapshot || !snapshot.entry) return;
      state.queue.ids.splice(snapshot.index, 0, snapshot.entry.id);
      state.queue.byId[snapshot.entry.id] = snapshot.entry;
      snapshot.entry.busy = false;
      snapshot.entry.version += 1;
      state.pendingCount = state.queue.ids.length;
      markDirty('queue');
      markDirty('chrome');
    },

    approve: function (id) {
      var entry = state.queue.byId[id];
      if (!entry || entry.busy) return;
      var pre = entry.dirty ? Queue.save(id, false) : Promise.resolve();

      pre.then(function () {
        var snapshot = Queue.withdraw(id);
        if (!snapshot) return;
        api
          .approve(id)
          .then(function (outcome) {
            if (outcome && outcome.ok === false) {
              Queue.restore(snapshot);
              toast(outcome.message || 'approval refused', 'warn');
              return;
            }
            toast('approved: ' + (outcome && outcome.message ? outcome.message : 'sent to the submitter'), 'success');
            refreshStats();
          })
          .catch(function (err) {
            Queue.restore(snapshot);
            reportError(err, 'approve');
          });
      });
    },

    reject: function (id) {
      var entry = state.queue.byId[id];
      if (!entry || entry.busy) return;
      var reason = entry.reason || '';
      var snapshot = Queue.withdraw(id);
      if (!snapshot) return;
      api
        .reject(id, reason)
        .then(function (outcome) {
          if (outcome && outcome.ok === false) {
            Queue.restore(snapshot);
            toast(outcome.message || 'rejection refused', 'warn');
            return;
          }
          toast('rejected', 'success');
          refreshStats();
        })
        .catch(function (err) {
          Queue.restore(snapshot);
          reportError(err, 'reject');
        });
    },

    regenerate: function (id) {
      var entry = state.queue.byId[id];
      if (!entry || entry.busy) return;
      var snapshot = Queue.withdraw(id);
      if (!snapshot) return;
      api
        .regenerate(id)
        .then(function () {
          toast('a fresh draft was queued; it reappears when the worker finishes', 'success');
          window.setTimeout(function () {
            Queue.load(true);
          }, 6000);
        })
        .catch(function (err) {
          Queue.restore(snapshot);
          reportError(err, 'regenerate');
        });
    },

    showWhy: function (button, id) {
      var entry = state.queue.byId[id];
      if (!entry || !entry.match) {
        openPopover(button, '<p class="muted">No stored match for this proposal.</p>');
        return;
      }
      openPopover(button, Live.whyHtml(entry.match));
    }
  };

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ================================================================ jobs view */

  var Jobs = {
    init: function () {
      var form = $('#jobs-filters');

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        Jobs.readFilters();
        Jobs.load(true);
      });

      form.addEventListener('reset', function () {
        window.setTimeout(function () {
          $('#f-minscore-out').textContent = '0';
          Jobs.readFilters();
          Jobs.load(true);
        }, 0);
      });

      $('#f-minscore').addEventListener('input', function (event) {
        $('#f-minscore-out').textContent = event.target.value;
      });

      $('#jobs-more').addEventListener('click', function () {
        Jobs.load(false);
      });

      $$('.th-sort').forEach(function (header) {
        header.addEventListener('click', function () {
          var key = header.getAttribute('data-sort');
          var sort = state.jobs.sort;
          if (sort.key === key) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
          else {
            sort.key = key;
            sort.dir = 'desc';
          }
          markDirty('jobs');
        });
      });

      $('#jobs-body').addEventListener('click', function (event) {
        var row = event.target.closest('tr[data-id]');
        if (!row) return;
        if (event.target.closest('a')) return;
        openJobDrawer(row.getAttribute('data-id'), row);
      });

      $('#jobs-body').addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var row = event.target.closest('tr[data-id]');
        if (!row) return;
        event.preventDefault();
        openJobDrawer(row.getAttribute('data-id'), row);
      });
    },

    readFilters: function () {
      state.jobs.filters = {
        q: $('#f-q').value.trim(),
        status: $('#f-status').value,
        decision: $('#f-decision').value,
        profileId: $('#f-profile').value,
        minScore: parseInt($('#f-minscore').value, 10) || 0
      };
    },

    load: function (reset) {
      if (state.jobs.loading) return Promise.resolve();
      state.jobs.loading = true;
      state.jobs.error = null;
      if (reset) {
        state.jobs.items = [];
        state.jobs.cursor = null;
      }
      markDirty('jobs');

      var filters = state.jobs.filters;
      return api
        .jobs({
          q: filters.q,
          status: filters.status,
          decision: filters.decision,
          profileId: filters.profileId,
          minScore: filters.minScore > 0 ? filters.minScore : undefined,
          limit: JOBS_PAGE,
          cursor: state.jobs.cursor || undefined
        })
        .then(function (data) {
          state.jobs.items = state.jobs.items.concat(asArray(data && data.items));
          state.jobs.cursor = data ? data.nextCursor : null;
          state.jobs.hasMore = Boolean(data && data.hasMore);
          state.jobs.loading = false;
          markDirty('jobs');
        })
        .catch(function (err) {
          state.jobs.loading = false;
          state.jobs.error = err.message;
          markDirty('jobs');
          reportError(err, 'jobs');
        });
    },

    sortValue: function (row, key) {
      if (key === 'score') return row.bestMatch ? row.bestMatch.score : -1;
      if (key === 'budget') {
        var value = firstNumber(row.budgetAmount, row.hourlyMax, row.hourlyMin);
        return value === null ? -1 : value;
      }
      if (key === 'proposals') return typeof row.proposalsCount === 'number' ? row.proposalsCount : -1;
      var time = toTime(row.postedAt || row.firstSeenAt);
      return time === null ? 0 : time;
    },

    render: function () {
      var body = $('#jobs-body');
      if (!body) return;

      var sort = state.jobs.sort;
      $$('.th-sort').forEach(function (header) {
        if (header.getAttribute('data-sort') === sort.key) {
          header.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
        } else header.removeAttribute('aria-sort');
      });

      var rows = state.jobs.items.slice().sort(function (left, right) {
        var a = Jobs.sortValue(left, sort.key);
        var b = Jobs.sortValue(right, sort.key);
        return sort.dir === 'desc' ? b - a : a - b;
      });

      if (rows.length === 0) {
        body.innerHTML =
          '<tr><td colspan="7" class="muted">' +
          (state.jobs.loading ? 'Loading…' : state.jobs.error ? esc(state.jobs.error) : 'No job matches these filters.') +
          '</td></tr>';
      } else {
        body.innerHTML = rows
          .map(function (row) {
            var match = row.bestMatch;
            var client = [];
            if (row.clientCountry) client.push(esc(row.clientCountry));
            if (row.clientPaymentVerified === true) client.push('verified');
            var spend = compactMoney(row.clientTotalSpent);
            if (spend) client.push(esc(spend));
            return (
              '<tr data-id="' +
              esc(row.id) +
              '" tabindex="0">' +
              '<td>' +
              scoreBadge(match ? match.score : null, match ? match.decision : null, true) +
              '</td>' +
              '<td class="td-title"><div>' +
              esc(row.title) +
              '</div><div class="td-sub">' +
              esc(row.source) +
              (match && match.profile ? ' · ' + esc(match.profile.name) : '') +
              '</div></td>' +
              '<td class="num">' +
              esc(budgetLabel(row) || '–') +
              '</td>' +
              '<td class="num hide-sm">' +
              (typeof row.proposalsCount === 'number' ? row.proposalsCount : '–') +
              '</td>' +
              '<td class="hide-sm">' +
              (client.length ? client.join(' · ') : '–') +
              '</td>' +
              '<td class="num">' +
              ageSpan(row.postedAt || row.firstSeenAt, '', 'nowrap') +
              '</td>' +
              '<td class="hide-sm"><span class="pill">' +
              esc(row.status) +
              '</span></td>' +
              '</tr>'
            );
          })
          .join('');
      }

      $('#jobs-summary').textContent =
        state.jobs.items.length + ' loaded' + (state.jobs.hasMore ? ', more available' : '');
      var more = $('#jobs-more');
      more.hidden = !state.jobs.hasMore;
      more.textContent = state.jobs.loading ? 'Loading…' : 'Load more';
      more.disabled = state.jobs.loading;
      $('#jobs-pager-note').textContent = state.jobs.hasMore ? '' : 'end of results';
    },

    syncProfileOptions: function () {
      var select = $('#f-profile');
      if (!select) return;
      var current = select.value;
      select.innerHTML =
        '<option value="">Any</option>' +
        state.profiles
          .map(function (profile) {
            return '<option value="' + esc(profile.id) + '">' + esc(profile.name) + '</option>';
          })
          .join('');
      select.value = current;
    }
  };

  /* ============================================================ profiles view */

  var PROFILE_GROUPS = [
    {
      legend: 'Identity',
      fields: [
        { key: 'name', type: 'text', label: 'Name', span: true, required: true },
        { key: 'isActive', type: 'bool', label: 'Active (polled by the workers)' }
      ]
    },
    {
      legend: 'Matching',
      fields: [
        { key: 'includeKeywords', type: 'list', label: 'Include keywords', span: true },
        { key: 'excludeKeywords', type: 'list', label: 'Exclude keywords', span: true },
        { key: 'requiredSkills', type: 'list', label: 'Required skills', span: true },
        { key: 'niceToHaveSkills', type: 'list', label: 'Nice to have skills', span: true },
        { key: 'categories', type: 'list', label: 'Categories', span: true },
        { key: 'searchQueries', type: 'lines', label: 'Search queries (one per line)', span: true }
      ]
    },
    {
      legend: 'Hard filters',
      fields: [
        { key: 'jobTypes', type: 'multi', label: 'Job types', options: JOB_TYPES },
        { key: 'experienceLevels', type: 'multi', label: 'Experience levels', options: EXPERIENCE_LEVELS },
        { key: 'minFixedBudget', type: 'number', label: 'Min fixed budget', nullable: true },
        { key: 'maxFixedBudget', type: 'number', label: 'Max fixed budget', nullable: true },
        { key: 'minHourlyRate', type: 'number', label: 'Min hourly rate', nullable: true },
        { key: 'maxProposals', type: 'number', label: 'Max proposals already sent', nullable: true, step: 1 },
        { key: 'maxJobAgeMinutes', type: 'number', label: 'Max job age (minutes)', step: 1 },
        { key: 'requirePaymentVerified', type: 'bool', label: 'Require payment verified' },
        { key: 'minClientSpend', type: 'number', label: 'Min client spend', nullable: true },
        { key: 'minClientRating', type: 'number', label: 'Min client rating (0-5)', nullable: true, step: 0.1 },
        { key: 'minClientHireRate', type: 'number', label: 'Min hire rate (0-1)', nullable: true, step: 0.05 },
        { key: 'minClientReviews', type: 'number', label: 'Min client reviews', nullable: true, step: 1 },
        { key: 'allowedCountries', type: 'list', label: 'Allowed countries', span: true },
        { key: 'blockedCountries', type: 'list', label: 'Blocked countries', span: true },
        { key: 'blockedClients', type: 'list', label: 'Blocked clients', span: true }
      ]
    },
    {
      legend: 'Scoring',
      fields: [
        { key: 'autoBidThreshold', type: 'range', label: 'Auto-bid threshold', min: 0, max: 100 },
        { key: 'reviewThreshold', type: 'range', label: 'Review threshold', min: 0, max: 100 },
        { key: 'useLlmRerank', type: 'bool', label: 'Use the LLM re-rank' }
      ]
    },
    {
      legend: 'Bidding',
      fields: [
        { key: 'fixedBidStrategy', type: 'select', label: 'Fixed bid strategy', options: FIXED_BID_STRATEGIES },
        { key: 'autoSubmit', type: 'bool', label: 'Auto-submit this profile (needs AUTO_SUBMIT too)' },
        { key: 'hourlyRate', type: 'number', label: 'Your hourly rate', nullable: true },
        { key: 'fixedBidPercent', type: 'number', label: 'Fixed bid percent of budget', step: 0.05 },
        { key: 'minBid', type: 'number', label: 'Min bid', nullable: true },
        { key: 'maxBid', type: 'number', label: 'Max bid', nullable: true },
        { key: 'maxDailySubmissions', type: 'number', label: 'Max submissions per day', step: 1 },
        { key: 'maxHourlySubmissions', type: 'number', label: 'Max submissions per hour', step: 1 },
        { key: 'maxDailyConnects', type: 'number', label: 'Max connects per day', step: 1 }
      ]
    },
    {
      legend: 'Drafting',
      fields: [
        { key: 'proposalTone', type: 'select', label: 'Tone', options: PROPOSAL_TONES },
        { key: 'proposalMaxChars', type: 'number', label: 'Cover letter character limit', step: 10 },
        { key: 'proposalLanguage', type: 'text', label: 'Language code' },
        { key: 'freelancerProfile', type: 'textarea', label: 'Your profile (fed to the drafter)', span: true },
        { key: 'portfolioHighlights', type: 'lines', label: 'Portfolio highlights (one per line)', span: true },
        { key: 'customInstructions', type: 'textarea', label: 'Custom drafting instructions', span: true }
      ]
    }
  ];

  function defaultProfile() {
    return {
      name: '',
      isActive: true,
      includeKeywords: [],
      excludeKeywords: [],
      requiredSkills: [],
      niceToHaveSkills: [],
      categories: [],
      searchQueries: [],
      jobTypes: [],
      experienceLevels: [],
      minFixedBudget: null,
      maxFixedBudget: null,
      minHourlyRate: null,
      maxProposals: null,
      maxJobAgeMinutes: 180,
      requirePaymentVerified: true,
      minClientSpend: null,
      minClientRating: null,
      minClientHireRate: null,
      minClientReviews: null,
      allowedCountries: [],
      blockedCountries: [],
      blockedClients: [],
      autoBidThreshold: 85,
      reviewThreshold: 60,
      weights: Object.assign({}, DEFAULT_WEIGHTS),
      useLlmRerank: true,
      fixedBidStrategy: 'PERCENT_OF_BUDGET',
      autoSubmit: false,
      hourlyRate: null,
      fixedBidPercent: 0.9,
      minBid: null,
      maxBid: null,
      maxDailySubmissions: 15,
      maxHourlySubmissions: 5,
      maxDailyConnects: 120,
      freelancerProfile: '',
      portfolioHighlights: [],
      proposalTone: 'professional',
      proposalMaxChars: 1500,
      proposalLanguage: 'en',
      customInstructions: ''
    };
  }

  function draftFromProfile(profile) {
    var draft = defaultProfile();
    if (!profile) return draft;
    Object.keys(draft).forEach(function (key) {
      var value = profile[key];
      if (value === undefined) return;
      if (key === 'weights') {
        draft.weights = Object.assign({}, DEFAULT_WEIGHTS, value && typeof value === 'object' ? value : {});
        return;
      }
      draft[key] = value === null && (key === 'freelancerProfile' || key === 'customInstructions') ? '' : value;
    });
    return draft;
  }

  var Profiles = {
    init: function () {
      $('#profile-new').addEventListener('click', function () {
        state.profileView.selectedId = null;
        state.profileView.draft = defaultProfile();
        state.profileView.formKey = 'new:' + Date.now();
        state.profileView.test = null;
        markDirty('profiles');
      });

      $('#profile-list').addEventListener('click', function (event) {
        var button = event.target.closest('button[data-id]');
        if (!button) return;
        var id = button.getAttribute('data-id');
        if (button.getAttribute('data-action') === 'toggle') {
          Profiles.toggle(id);
          return;
        }
        Profiles.select(id);
      });

      var host = $('#profile-form-host');
      host.addEventListener('submit', function (event) {
        event.preventDefault();
        Profiles.save();
      });

      host.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-action]');
        if (!button) return;
        var action = button.getAttribute('data-action');
        if (action === 'test') Profiles.test();
        else if (action === 'delete') Profiles.remove();
        else if (action === 'revert') {
          state.profileView.draft = draftFromProfile(Profiles.selected());
          state.profileView.formKey = 'revert:' + Date.now();
          markDirty('profiles');
        }
      });

      host.addEventListener('input', function (event) {
        var field = event.target;
        var key = field.getAttribute('data-key');
        if (!key) return;
        Profiles.readField(field, key);
        if (field.type === 'range') {
          var output = host.querySelector('[data-out="' + key + '"]');
          if (output) output.textContent = field.value;
        }
      });

      host.addEventListener('change', function (event) {
        var field = event.target;
        var key = field.getAttribute('data-key');
        if (key) Profiles.readField(field, key);
      });
    },

    selected: function () {
      var found = null;
      state.profiles.forEach(function (profile) {
        if (profile.id === state.profileView.selectedId) found = profile;
      });
      return found;
    },

    select: function (id) {
      state.profileView.selectedId = id;
      state.profileView.draft = draftFromProfile(Profiles.selected());
      state.profileView.formKey = 'edit:' + id;
      state.profileView.test = null;
      markDirty('profiles');
    },

    readField: function (field, key) {
      var draft = state.profileView.draft;
      if (!draft) return;
      var weightKey = field.getAttribute('data-weight');
      if (weightKey) {
        var weight = parseFloat(field.value);
        draft.weights[weightKey] = isNaN(weight) ? 0 : weight;
        return;
      }
      var type = field.getAttribute('data-type');
      if (type === 'bool') draft[key] = field.checked;
      else if (type === 'multi') {
        var values = [];
        $$('[data-key="' + key + '"]', $('#profile-form-host')).forEach(function (box) {
          if (box.checked) values.push(box.value);
        });
        draft[key] = values;
      } else if (type === 'list') {
        draft[key] = field.value
          .split(/[,\n]/)
          .map(function (part) {
            return part.trim();
          })
          .filter(function (part) {
            return part !== '';
          });
      } else if (type === 'lines') {
        draft[key] = field.value
          .split('\n')
          .map(function (part) {
            return part.trim();
          })
          .filter(function (part) {
            return part !== '';
          });
      } else if (type === 'number' || type === 'range') {
        var raw = field.value.trim();
        if (raw === '') draft[key] = field.getAttribute('data-nullable') === 'true' ? null : 0;
        else {
          var parsed = parseFloat(raw);
          draft[key] = isNaN(parsed) ? null : parsed;
        }
      } else draft[key] = field.value;
    },

    fieldHtml: function (field, draft) {
      var value = draft[field.key];
      var id = 'pf-' + field.key;
      var span = field.span ? ' span-2' : '';

      if (field.type === 'bool') {
        return (
          '<div class="field' + span + '"><label class="check"><input type="checkbox" data-key="' +
          field.key +
          '" data-type="bool" id="' +
          id +
          '"' +
          (value ? ' checked' : '') +
          ' /><span>' +
          esc(field.label) +
          '</span></label></div>'
        );
      }

      if (field.type === 'multi') {
        var chosen = asArray(value);
        return (
          '<div class="field' + span + '"><span class="field-label">' +
          esc(field.label) +
          '</span><div class="checks">' +
          field.options
            .map(function (option) {
              return (
                '<label class="check"><input type="checkbox" data-key="' +
                field.key +
                '" data-type="multi" value="' +
                esc(option) +
                '"' +
                (chosen.indexOf(option) >= 0 ? ' checked' : '') +
                ' /><span>' +
                esc(option) +
                '</span></label>'
              );
            })
            .join('') +
          '</div></div>'
        );
      }

      if (field.type === 'select') {
        return (
          '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
          esc(field.label) +
          '</span><select class="input" id="' + id + '" data-key="' + field.key + '" data-type="select">' +
          field.options
            .map(function (option) {
              return (
                '<option value="' + esc(option) + '"' + (value === option ? ' selected' : '') + '>' + esc(option) + '</option>'
              );
            })
            .join('') +
          '</select></label>'
        );
      }

      if (field.type === 'range') {
        return (
          '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
          esc(field.label) +
          ' <b data-out="' + field.key + '">' + esc(value) + '</b></span>' +
          '<input class="range" type="range" id="' + id + '" data-key="' + field.key + '" data-type="range" min="' +
          field.min +
          '" max="' +
          field.max +
          '" step="1" value="' +
          esc(value) +
          '" /></label>'
        );
      }

      if (field.type === 'textarea') {
        return (
          '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
          esc(field.label) +
          '</span><textarea class="textarea" id="' + id + '" data-key="' + field.key + '" data-type="text">' +
          esc(value === null || value === undefined ? '' : value) +
          '</textarea></label>'
        );
      }

      if (field.type === 'list' || field.type === 'lines') {
        var text = asArray(value).join(field.type === 'lines' ? '\n' : ', ');
        return (
          '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
          esc(field.label) +
          '</span><textarea class="textarea" style="min-height:64px" id="' + id + '" data-key="' + field.key + '" data-type="' +
          field.type +
          '">' +
          esc(text) +
          '</textarea></label>'
        );
      }

      if (field.type === 'number') {
        return (
          '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
          esc(field.label) +
          '</span><input class="input" type="number" inputmode="decimal" step="' +
          (field.step || 'any') +
          '" id="' + id + '" data-key="' + field.key + '" data-type="number" data-nullable="' +
          (field.nullable ? 'true' : 'false') +
          '" value="' +
          esc(value === null || value === undefined ? '' : value) +
          '" /></label>'
        );
      }

      return (
        '<label class="field' + span + '"><span class="field-label" for="' + id + '">' +
        esc(field.label) +
        '</span><input class="input" type="text" id="' + id + '" data-key="' + field.key + '" data-type="text" value="' +
        esc(value === null || value === undefined ? '' : value) +
        '"' +
        (field.required ? ' required' : '') +
        ' /></label>'
      );
    },

    formHtml: function () {
      var draft = state.profileView.draft;
      if (!draft) {
        return '<p class="empty">Pick a profile on the left, or create one. A profile is what the detector polls for and what the drafter writes as.</p>';
      }

      var groups = PROFILE_GROUPS.map(function (group) {
        return (
          '<fieldset class="fieldset"><legend class="legend">' +
          esc(group.legend) +
          '</legend><div class="form-grid">' +
          group.fields
            .map(function (field) {
              return Profiles.fieldHtml(field, draft);
            })
            .join('') +
          '</div></fieldset>'
        );
      }).join('');

      var weights =
        '<fieldset class="fieldset"><legend class="legend">Scoring weights</legend><div class="form-grid">' +
        WEIGHT_KEYS.map(function (key) {
          return (
            '<label class="field"><span class="field-label" for="pw-' + key + '">' +
            esc(key) +
            '</span><input class="input" type="number" min="0" step="1" id="pw-' + key + '" data-key="weights" data-weight="' +
            key +
            '" value="' +
            esc(draft.weights[key]) +
            '" /></label>'
          );
        }).join('') +
        '</div></fieldset>';

      var isNew = state.profileView.selectedId === null;

      return (
        '<form id="profile-form" autocomplete="off">' +
        groups +
        weights +
        '<p class="form-error" id="profile-error" hidden></p>' +
        '<div class="form-actions">' +
        '<button class="btn btn-primary" type="submit"' + (state.profileView.saving ? ' disabled' : '') + '>' +
        (isNew ? 'Create profile' : 'Save changes') +
        '</button>' +
        '<button class="btn" type="button" data-action="test"' + (isNew || state.profileView.testing ? ' disabled' : '') + '>' +
        (state.profileView.testing ? 'Scoring…' : 'Test against recent jobs') +
        '</button>' +
        (isNew ? '' : '<button class="btn btn-ghost" type="button" data-action="revert">Revert</button>') +
        (isNew ? '' : '<button class="btn btn-danger" type="button" data-action="delete">Delete</button>') +
        '</div>' +
        '</form>' +
        (isNew ? '<p class="hint">Save the profile before testing: the test scores stored jobs against this profile id.</p>' : '')
      );
    },

    listHtml: function () {
      if (state.profiles.length === 0) return '<p class="muted">No profile yet.</p>';
      return state.profiles
        .map(function (profile) {
          var counts = profile._count || {};
          return (
            '<div class="p-item' + (profile.id === state.profileView.selectedId ? ' is-active' : '') + '">' +
            '<button class="p-name" type="button" data-id="' + esc(profile.id) + '" style="background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer">' +
            esc(profile.name) +
            '<div class="p-sub">' +
            (typeof counts.proposals === 'number' ? counts.proposals + ' proposals · ' : '') +
            'bid ' + esc(profile.autoBidThreshold) + ' / review ' + esc(profile.reviewThreshold) +
            (profile.autoSubmit ? ' · auto' : '') +
            '</div></button>' +
            '<button class="pill ' + (profile.isActive ? 'ok' : '') + '" type="button" data-id="' + esc(profile.id) + '" data-action="toggle" title="Toggle polling">' +
            (profile.isActive ? 'on' : 'off') +
            '</button>' +
            '</div>'
          );
        })
        .join('');
    },

    render: function () {
      setHtml($('#profile-list'), Profiles.listHtml());

      var host = $('#profile-form-host');
      var key = state.profileView.formKey + '|' + (state.profileView.saving ? 's' : '-') + '|' + (state.profileView.testing ? 't' : '-');
      if (host.getAttribute('data-key') !== key) {
        host.setAttribute('data-key', key);
        setHtml(host, Profiles.formHtml());
      }

      setHtml($('#profile-test-host'), Profiles.testHtml());
    },

    payload: function () {
      var draft = state.profileView.draft;
      var body = {};
      Object.keys(defaultProfile()).forEach(function (key) {
        var value = draft[key];
        if (key === 'freelancerProfile' || key === 'customInstructions') {
          body[key] = value === '' ? null : value;
          return;
        }
        body[key] = value;
      });
      return body;
    },

    validate: function () {
      var draft = state.profileView.draft;
      if (!draft.name || draft.name.trim() === '') return 'a profile needs a name';
      if (draft.reviewThreshold > draft.autoBidThreshold)
        return 'the review threshold must be lower than or equal to the auto-bid threshold';
      return null;
    },

    save: function () {
      var problem = Profiles.validate();
      var errorNode = $('#profile-error');
      if (problem) {
        if (errorNode) {
          errorNode.textContent = problem;
          errorNode.hidden = false;
        }
        return;
      }
      if (errorNode) errorNode.hidden = true;

      state.profileView.saving = true;
      markDirty('profiles');

      var body = Profiles.payload();
      var id = state.profileView.selectedId;
      var work = id ? api.updateProfile(id, body) : api.createProfile(body);

      work
        .then(function (data) {
          state.profileView.saving = false;
          toast(id ? 'profile saved' : 'profile created', 'success');
          return loadProfiles().then(function () {
            if (!id && data && data.profile) Profiles.select(data.profile.id);
            else markDirty('profiles');
          });
        })
        .catch(function (err) {
          state.profileView.saving = false;
          markDirty('profiles');
          var node = $('#profile-error');
          if (node) {
            node.textContent = err.message;
            node.hidden = false;
          }
          reportError(err, 'saving the profile');
        });
    },

    remove: function () {
      var id = state.profileView.selectedId;
      if (!id) return;
      var profile = Profiles.selected();
      var name = profile ? profile.name : id;
      if (!window.confirm('Delete the profile "' + name + '"? Its jobs, matches and proposals go with it.')) return;

      api
        .deleteProfile(id)
        .then(function () {
          toast('profile deleted', 'success');
          state.profileView.selectedId = null;
          state.profileView.draft = null;
          state.profileView.formKey = 'none';
          state.profileView.test = null;
          return loadProfiles();
        })
        .catch(function (err) {
          reportError(err, 'deleting the profile');
        });
    },

    toggle: function (id) {
      api
        .toggleProfile(id)
        .then(function (data) {
          if (data && data.profile) toast(data.profile.name + ' is now ' + (data.profile.isActive ? 'active' : 'paused'), 'success');
          return loadProfiles();
        })
        .catch(function (err) {
          reportError(err, 'toggling the profile');
        });
    },

    test: function () {
      var id = state.profileView.selectedId;
      if (!id || state.profileView.testing) return;
      state.profileView.testing = true;
      markDirty('profiles');

      api
        .testProfile(id, { limit: 100, overrides: Profiles.payload() })
        .then(function (data) {
          state.profileView.testing = false;
          state.profileView.test = data;
          markDirty('profiles');
        })
        .catch(function (err) {
          state.profileView.testing = false;
          markDirty('profiles');
          reportError(err, 'test run');
        });
    },

    testHtml: function () {
      var test = state.profileView.test;
      if (!test) return '';

      var buckets = asArray(test.histogram);
      var peak = 1;
      buckets.forEach(function (bucket) {
        if (bucket.count > peak) peak = bucket.count;
      });
      var autoBid = test.thresholds ? test.thresholds.autoBid : 85;
      var review = test.thresholds ? test.thresholds.review : 60;

      var columns = buckets
        .map(function (bucket, index) {
          var lower = index * 10;
          var tone = lower >= autoBid ? 'BID' : lower >= review ? 'REVIEW' : 'SKIP';
          var height = Math.round((bucket.count / peak) * 100);
          return (
            '<div class="hist-col" title="' +
            esc(bucket.bucket + ': ' + bucket.count + ' jobs') +
            '"><span class="hist-n">' +
            bucket.count +
            '</span><div class="hist-bar" data-tone="' +
            tone +
            '" style="height:' +
            Math.max(2, height) +
            '%"></div><span class="hist-x">' +
            esc(bucket.bucket) +
            '</span></div>'
          );
        })
        .join('');

      var scores = test.scores || {};
      var decisions = test.decisions || {};
      var hardFilters = asArray(test.hardFilters);
      var top = asArray(test.top);

      return (
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Test run</h3>' +
        '<span class="muted">' + esc(test.sampleSize) + ' recent jobs, nothing written</span></div>' +
        '<div class="tiles mt2">' +
        '<div class="tile"><div class="tile-n">' + esc(decisions.BID || 0) + '</div><div class="tile-l">bid</div></div>' +
        '<div class="tile"><div class="tile-n">' + esc(decisions.REVIEW || 0) + '</div><div class="tile-l">review</div></div>' +
        '<div class="tile"><div class="tile-n">' + esc(decisions.SKIP || 0) + '</div><div class="tile-l">skip</div></div>' +
        '<div class="tile"><div class="tile-n">' + esc(scores.median === null || scores.median === undefined ? '–' : scores.median) + '</div><div class="tile-l">median score</div></div>' +
        '<div class="tile"><div class="tile-n">' + esc(scores.p90 === null || scores.p90 === undefined ? '–' : scores.p90) + '</div><div class="tile-l">p90</div></div>' +
        '</div>' +
        '<div class="hist mt3">' + columns + '</div>' +
        '<div class="hist-legend">' +
        '<span><i class="swatch" style="background:var(--bid)"></i>at or above ' + esc(autoBid) + ' (auto-bid)</span>' +
        '<span><i class="swatch" style="background:var(--review)"></i>at or above ' + esc(review) + ' (review)</span>' +
        '<span><i class="swatch" style="background:var(--skip)"></i>below the review threshold</span>' +
        '</div>' +
        (hardFilters.length
          ? '<div class="mt3"><h4 class="panel-title">Hard filters that rejected jobs</h4><ul class="list-plain mt2">' +
            hardFilters
              .map(function (row) {
                return '<li>' + esc(row.reason) + ' <span class="muted">(' + row.count + ')</span></li>';
              })
              .join('') +
            '</ul></div>'
          : '') +
        (top.length
          ? '<div class="mt3"><h4 class="panel-title">Top scoring in the sample</h4><ul class="list-plain mt2">' +
            top
              .map(function (row) {
                return (
                  '<li>' +
                  scoreBadge(row.score, row.decision, true) +
                  ' <a href="' + esc(row.url) + '" target="_blank" rel="noopener noreferrer">' + esc(row.title) + '</a>' +
                  (row.previousScore !== null && row.previousScore !== undefined && row.previousScore !== row.score
                    ? ' <span class="muted">was ' + esc(row.previousScore) + '</span>'
                    : '') +
                  '</li>'
                );
              })
              .join('') +
            '</ul></div>'
          : '') +
        '</div>'
      );
    }
  };

  /* ============================================================ settings view */

  var Settings = {
    init: function () {
      $('#settings-reload').addEventListener('click', function () {
        refreshHealth();
        refreshStats();
      });

      $('#logout-btn').addEventListener('click', function () {
        api.logout().catch(function () {
          /* Clearing the local key is what matters. */
        });
        state.apiKey = '';
        writeStore(LS_KEY, null);
        state.authed = false;
        openLogin('signed out');
      });

      $('#settings-host').addEventListener('click', function (event) {
        var button = event.target.closest('button[data-action]');
        if (!button) return;
        if (button.getAttribute('data-action') === 'oauth-disconnect') {
          if (!window.confirm('Disconnect the Upwork account? Detection through the API stops until it is reconnected.')) return;
          api
            .oauthDisconnect()
            .then(function () {
              toast('Upwork account disconnected', 'success');
              refreshHealth();
            })
            .catch(function (err) {
              reportError(err, 'disconnect');
            });
        }
      });
    },

    windowTiles: function (label, window_) {
      if (!window_) return '';
      return (
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">' +
        esc(label) +
        '</h3><span class="muted">since ' +
        esc(absTime(window_.since)) +
        '</span></div><div class="tiles">' +
        [
          ['jobsSeen', 'jobs seen'],
          ['jobsScored', 'scored'],
          ['bid', 'bid'],
          ['review', 'review'],
          ['drafted', 'drafted'],
          ['approved', 'approved'],
          ['rejected', 'rejected'],
          ['submitted', 'submitted'],
          ['connectsSpent', 'connects']
        ]
          .map(function (pair) {
            return (
              '<div class="tile"><div class="tile-n">' +
              esc(num(window_[pair[0]]) === null ? '–' : num(window_[pair[0]])) +
              '</div><div class="tile-l">' +
              esc(pair[1]) +
              '</div></div>'
            );
          })
          .join('') +
        '<div class="tile"><div class="tile-n">' +
        esc(window_.avgScore === null || window_.avgScore === undefined ? '–' : window_.avgScore) +
        '</div><div class="tile-l">avg score</div></div>' +
        '<div class="tile"><div class="tile-n">' +
        esc(window_.approvalRate === null || window_.approvalRate === undefined ? '–' : Math.round(window_.approvalRate * 100) + '%') +
        '</div><div class="tile-l">approval rate</div><div class="tile-sub">' +
        esc(
          window_.medianTimeToDraftSeconds === null || window_.medianTimeToDraftSeconds === undefined
            ? 'draft latency unknown'
            : 'median ' + Math.round(window_.medianTimeToDraftSeconds) + 's to draft'
        ) +
        '</div></div>' +
        '</div></div>'
      );
    },

    render: function () {
      var host = $('#settings-host');
      if (!host) return;

      var health = state.health;
      var stats = state.stats;

      if (!health) {
        setHtml(host, '<p class="empty">Reading the health endpoint…</p>');
        return;
      }

      var config = health.config || {};
      var submitter = health.submitter || null;
      var oauth = health.upworkOAuth || null;

      var statusPill =
        health.status === 'ok'
          ? '<span class="pill ok">ok</span>'
          : health.status === 'degraded'
            ? '<span class="pill warn">degraded</span>'
            : '<span class="pill bad">down</span>';

      var routing =
        '<div class="panel"><div class="panel-head">' +
        '<h3 class="panel-title">Submission routing</h3>' +
        (submitter && submitter.canAutoSubmit ? '<span class="pill warn">auto capable</span>' : '<span class="pill">review queue</span>') +
        '</div><div class="kv">' +
        '<div class="kv-row"><span class="kv-k">AUTO_SUBMIT</span><span class="kv-v">' + (config.autoSubmit ? 'on' : 'off') + '</span></div>' +
        '<div class="kv-row"><span class="kv-k">DRY_RUN</span><span class="kv-v">' + (config.dryRun ? 'on' : 'off') + '</span></div>' +
        '<div class="kv-row"><span class="kv-k">requested submitter</span><span class="kv-v">' + esc(submitter ? submitter.requested : '–') + '</span></div>' +
        '<div class="kv-row"><span class="kv-k">effective submitter</span><span class="kv-v">' + esc(submitter ? submitter.effective : '–') + '</span></div>' +
        (submitter && submitter.fellBack
          ? '<div class="kv-row"><span class="kv-k">fell back</span><span class="kv-v">' + esc(submitter.detail || 'yes') + '</span></div>'
          : '') +
        '</div>' +
        '<p class="hint mt2">Detection, scoring and drafting always run. Submission goes out only through a configured submitter; otherwise every draft waits for a tap in the queue.</p>' +
        '</div>';

      var connect =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Upwork account</h3>' +
        (oauth && oauth.connected ? '<span class="pill ok">connected</span>' : '<span class="pill">not connected</span>') +
        '</div><div class="kv">' +
        '<div class="kv-row"><span class="kv-k">OAuth configured</span><span class="kv-v">' + (oauth && oauth.configured ? 'yes' : 'no') + '</span></div>' +
        (oauth && oauth.expiresAt
          ? '<div class="kv-row"><span class="kv-k">token expires</span><span class="kv-v">' + esc(absTime(oauth.expiresAt)) + '</span></div>'
          : '') +
        (oauth && oauth.scope ? '<div class="kv-row"><span class="kv-k">scope</span><span class="kv-v">' + esc(oauth.scope) + '</span></div>' : '') +
        '</div><div class="row mt3">' +
        '<a class="btn btn-primary" href="' + API + '/oauth/upwork/start">' +
        (oauth && oauth.connected ? 'Reconnect Upwork account' : 'Connect Upwork account') +
        '</a>' +
        (oauth && oauth.connected
          ? '<button class="btn btn-ghost" type="button" data-action="oauth-disconnect">Disconnect</button>'
          : '') +
        '</div></div>';

      var checks =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Health</h3>' +
        statusPill +
        '<span class="muted">v' + esc(health.version) + ' · up ' + esc(num(health.uptime)) + 's</span></div>' +
        '<div class="kv">' +
        '<div class="kv-row"><span class="kv-k">database</span><span class="kv-v">' +
        (health.db && health.db.ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">' + esc(health.db && health.db.detail ? health.db.detail : 'down') + '</span>') +
        (health.db && typeof health.db.latencyMs === 'number' ? ' <span class="muted">' + health.db.latencyMs + 'ms</span>' : '') +
        '</span></div>' +
        '<div class="kv-row"><span class="kv-k">redis</span><span class="kv-v">' +
        (health.redis && health.redis.ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">' + esc(health.redis && health.redis.detail ? health.redis.detail : 'down') + '</span>') +
        (health.redis && typeof health.redis.latencyMs === 'number' ? ' <span class="muted">' + health.redis.latencyMs + 'ms</span>' : '') +
        '</span></div>' +
        asArray(health.notes)
          .map(function (note) {
            return '<div class="kv-row"><span class="kv-k">note</span><span class="kv-v">' + esc(note) + '</span></div>';
          })
          .join('') +
        '</div></div>';

      var heartbeats =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Heartbeats</h3></div><div class="kv">' +
        asArray(health.heartbeats)
          .map(function (beat) {
            return (
              '<div class="kv-row"><span class="kv-k">' +
              esc(beat.component) +
              '</span><span class="kv-v">' +
              (beat.healthy ? '<span class="pill ok">' + esc(beat.status) + '</span>' : '<span class="pill bad">' + esc(beat.status) + '</span>') +
              ' <span class="muted">' +
              esc(beat.ageSeconds === null || beat.ageSeconds === undefined ? 'never' : beat.ageSeconds + 's ago') +
              '</span></span></div>'
            );
          })
          .join('') +
        '</div></div>';

      var sources =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Detection sources</h3></div><div class="kv">' +
        asArray(health.sources)
          .map(function (source) {
            return (
              '<div class="kv-row"><span class="kv-k">' +
              esc(source.name) +
              '</span><span class="kv-v">' +
              (source.enabled ? '<span class="pill ok">enabled</span>' : source.selected ? '<span class="pill warn">selected, unconfigured</span>' : '<span class="pill">off</span>') +
              ' <span class="muted">breaker ' +
              esc(source.breaker) +
              (source.failures ? ', ' + source.failures + ' failures' : '') +
              '</span></span></div>'
            );
          })
          .join('') +
        '</div></div>';

      var queues =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Queues</h3></div><div class="kv">' +
        Object.keys(health.queues || {})
          .map(function (name) {
            var counts = health.queues[name] || {};
            var parts = Object.keys(counts).map(function (key) {
              return key + ' ' + counts[key];
            });
            return (
              '<div class="kv-row"><span class="kv-k">' +
              esc(name) +
              '</span><span class="kv-v muted">' +
              esc(parts.length ? parts.join(' · ') : 'no counts') +
              '</span></div>'
            );
          })
          .join('') +
        '</div></div>';

      var configPanel =
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">Runtime</h3></div><div class="kv">' +
        [
          ['model', config.model],
          ['sources', asArray(config.sources).join(', ')],
          ['poll interval', config.pollIntervalSeconds ? config.pollIntervalSeconds + 's' : null],
          ['fast poll', config.fastPollIntervalSeconds ? config.fastPollIntervalSeconds + 's' : null],
          ['worker concurrency', config.workerConcurrency],
          ['anthropic configured', config.anthropicConfigured === undefined ? null : config.anthropicConfigured ? 'yes' : 'no'],
          ['notify channels', asArray(config.notifyChannels).join(', ')],
          ['api key set', config.apiKeySet === undefined ? null : config.apiKeySet ? 'yes' : 'no'],
          ['node env', config.nodeEnv]
        ]
          .filter(function (pair) {
            return pair[1] !== null && pair[1] !== undefined && pair[1] !== '';
          })
          .map(function (pair) {
            return '<div class="kv-row"><span class="kv-k">' + esc(pair[0]) + '</span><span class="kv-v">' + esc(pair[1]) + '</span></div>';
          })
          .join('') +
        '</div></div>';

      var windows = stats && stats.windows ? stats.windows : null;
      var statsHtml = windows
        ? Settings.windowTiles('Today', windows.today) +
          Settings.windowTiles('Last 7 days', windows['7d']) +
          Settings.windowTiles('Last 30 days', windows['30d'])
        : '<div class="panel"><p class="muted">Stats are loading…</p></div>';

      setHtml(
        host,
        '<div class="grid-2">' +
          '<div>' + routing + connect + checks + '</div>' +
          '<div>' + heartbeats + sources + queues + configPanel + '</div>' +
          '</div>' +
          statsHtml
      );
    }
  };

  /* ===================================================================== sse */

  var stream = {
    source: null,
    attempts: 0,
    timer: null,
    pollTimer: null,
    closed: false
  };

  function setConn(value) {
    if (state.conn === value) return;
    state.conn = value;
    markDirty('chrome');
  }

  function handleEnvelope(envelope) {
    var name = typeof envelope.event === 'string' ? envelope.event : 'message';
    var data = envelope.data;
    var head = name.split('.')[0];

    if (name === 'connected') {
      stream.attempts = 0;
      setConn('live');
      stopPolling();
      return;
    }
    if (name === 'shutdown') {
      setConn('offline');
      return;
    }

    if (head === 'job' || head === 'match') {
      var item = feedItemFromEvent(name, data, envelope.at);
      if (item) {
        Live.upsert(item);
        if (!item.title || item.title.indexOf('job ') === 0 || item.score === null) enrich(item.jobId);
      }
      return;
    }

    if (head === 'proposal') {
      if (name === 'proposal.created' || name === 'proposal.drafted' || name === 'proposal') {
        beep(700);
        var title = data && (data.title || (data.job && data.job.title));
        desktopNotify('Draft ready for approval', title || 'A proposal is waiting in the queue.');
      }
      if (state.route === '#/queue' || name === 'proposal.created' || name === 'proposal.drafted' || name === 'proposal') {
        Queue.load(true);
      } else {
        refreshPendingCount();
      }
      return;
    }

    if (head === 'submission') {
      refreshStats();
      var message = data && data.message ? String(data.message) : 'submission event';
      toast('submission: ' + message, 'info');
      return;
    }

    if (head === 'alert') {
      var text = data && (data.message || data.subject) ? String(data.message || data.subject) : 'alert';
      toast(text, 'warn', 9000);
      desktopNotify('UpBid alert', text);
      return;
    }

    if (head === 'profile' || head === 'oauth') {
      loadProfiles();
      refreshHealth();
    }
  }

  var enrichInFlight = {};

  function enrich(jobId) {
    if (!jobId || enrichInFlight[jobId]) return;
    if (Object.keys(enrichInFlight).length > 6) return;
    enrichInFlight[jobId] = true;
    api
      .job(jobId)
      .then(function (data) {
        if (!data || !data.job) return;
        var job = data.job;
        var match = asArray(job.matches)[0] || null;
        Live.upsert(
          {
            jobId: job.id,
            title: job.title,
            url: job.url,
            source: job.source,
            jobType: job.jobType,
            budgetAmount: job.budgetAmount,
            hourlyMin: job.hourlyMin,
            hourlyMax: job.hourlyMax,
            currency: job.currency,
            proposalsCount: job.proposalsCount,
            connectsRequired: job.connectsRequired,
            clientCountry: job.clientCountry,
            clientPaymentVerified: job.clientPaymentVerified,
            clientTotalSpent: job.clientTotalSpent,
            clientAvgRating: job.clientAvgRating,
            clientHireRate: job.clientHireRate,
            postedAt: job.postedAt || job.firstSeenAt,
            score: match ? match.score : null,
            decision: match ? match.decision : null,
            profileName: match && match.profile ? match.profile.name : null,
            redFlags: match ? match.redFlags : [],
            reasons: match ? match.reasons : [],
            breakdown: match ? match.breakdown : []
          },
          { quiet: true }
        );
      })
      .catch(function () {
        /* Enrichment is best effort; the row keeps whatever the event carried. */
      })
      .then(function () {
        delete enrichInFlight[jobId];
      });
  }

  function connectStream() {
    if (stream.closed) return;
    if (!('EventSource' in window)) {
      startPolling();
      return;
    }
    if (stream.source) {
      try {
        stream.source.close();
      } catch (err) {
        /* Already closed. */
      }
      stream.source = null;
    }

    setConn(stream.attempts === 0 ? 'connecting' : state.conn === 'polling' ? 'polling' : 'connecting');

    var source;
    try {
      source = new window.EventSource(API + '/stream', { withCredentials: true });
    } catch (err) {
      scheduleReconnect();
      return;
    }
    stream.source = source;

    source.onopen = function () {
      stream.attempts = 0;
      setConn('live');
      stopPolling();
    };

    source.onerror = function () {
      if (source.readyState === 2 || source.readyState === undefined) {
        try {
          source.close();
        } catch (err) {
          /* ignore */
        }
        stream.source = null;
        scheduleReconnect();
      } else {
        setConn(stream.attempts > 0 ? 'polling' : 'connecting');
      }
    };

    function onEvent(event) {
      var envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!envelope || typeof envelope !== 'object') return;
      if (!envelope.event) envelope.event = event.type;
      handleEnvelope(envelope);
    }

    source.onmessage = onEvent;
    SSE_EVENTS.forEach(function (name) {
      source.addEventListener(name, onEvent);
    });
  }

  function scheduleReconnect() {
    if (stream.closed) return;
    stream.attempts += 1;
    if (stream.attempts >= 3) startPolling();
    setConn(stream.pollTimer ? 'polling' : 'offline');
    var delay = backoffDelay(Math.min(stream.attempts, 6), 1000, 30000);
    if (stream.timer) window.clearTimeout(stream.timer);
    stream.timer = window.setTimeout(connectStream, delay);
  }

  function startPolling() {
    if (stream.pollTimer) return;
    setConn('polling');
    stream.pollTimer = window.setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stopPolling() {
    if (!stream.pollTimer) return;
    window.clearInterval(stream.pollTimer);
    stream.pollTimer = null;
  }

  function pollOnce() {
    if (document.hidden) return;
    api
      .jobs({ limit: 25 })
      .then(function (data) {
        asArray(data && data.items)
          .slice()
          .reverse()
          .forEach(function (row) {
            Live.upsert(feedItemFromJobRow(row), { quiet: true });
          });
      })
      .catch(function () {
        /* The connection banner already tells the operator. */
      });
    refreshPendingCount();
  }

  /* ================================================================= loaders */

  function loadProfiles() {
    return api
      .profiles()
      .then(function (data) {
        state.profiles = asArray(data && data.items);
        Jobs.syncProfileOptions();
        markDirty('profiles');
        markDirty('queue');
      })
      .catch(function (err) {
        reportError(err, 'profiles');
      });
  }

  function refreshHealth() {
    return api
      .health()
      .then(function (data) {
        state.health = data;
        markDirty('chrome');
        markDirty('settings');
      })
      .catch(function (err) {
        if (err instanceof ApiError && err.payload) {
          state.health = err.payload;
          markDirty('chrome');
          markDirty('settings');
          return;
        }
        markDirty('settings');
      });
  }

  function refreshStats() {
    return api
      .stats()
      .then(function (data) {
        state.stats = data;
        if (data && data.pipeline && typeof data.pipeline.pendingApproval === 'number') {
          state.pendingCount = data.pipeline.pendingApproval;
        }
        markDirty('chrome');
        markDirty('settings');
      })
      .catch(function () {
        /* Stats are informational; a failure must not interrupt the operator. */
      });
  }

  function refreshPendingCount() {
    return api
      .proposals({ status: 'PENDING_APPROVAL', limit: 1 })
      .then(function (data) {
        if (!data) return;
        var count = asArray(data.items).length;
        if (data.hasMore) {
          /* The list endpoint caps at the requested page size; the stats
             endpoint owns the exact number, so only grow the badge here. */
          state.pendingCount = Math.max(state.pendingCount, count);
        } else {
          state.pendingCount = count;
        }
        markDirty('chrome');
      })
      .catch(function () {
        /* ignore */
      });
  }

  function seedFeed() {
    return api
      .jobs({ limit: 40 })
      .then(function (data) {
        asArray(data && data.items)
          .slice()
          .reverse()
          .forEach(function (row) {
            Live.upsert(feedItemFromJobRow(row), { quiet: true });
          });
      })
      .catch(function () {
        /* An empty feed is a valid starting state. */
      });
  }

  /* ================================================================== router */

  function currentRoute() {
    var hash = window.location.hash;
    return ROUTES.indexOf(hash) >= 0 ? hash : DEFAULT_ROUTE;
  }

  function applyRoute() {
    var route = currentRoute();
    state.route = route;
    ROUTES.forEach(function (candidate) {
      var view = $('#view-' + candidate.replace('#/', ''));
      if (view) view.hidden = candidate !== route;
    });
    markDirty('chrome');

    if (route === '#/queue') Queue.load(false);
    else if (route === '#/jobs' && state.jobs.items.length === 0) Jobs.load(true);
    else if (route === '#/profiles') markDirty('profiles');
    else if (route === '#/settings') {
      refreshHealth();
      refreshStats();
    }
    markDirty(route.replace('#/', ''));
  }

  /* ================================================================== login */

  var loginPending = false;

  function openLogin(reason) {
    var modal = $('#login');
    if (!modal) return;
    modal.hidden = false;
    var error = $('#login-error');
    if (reason) {
      error.textContent = reason;
      error.hidden = false;
    } else error.hidden = true;
    var input = $('#login-key');
    input.value = '';
    window.setTimeout(function () {
      input.focus();
    }, 40);
  }

  function closeLogin() {
    var modal = $('#login');
    if (modal) modal.hidden = true;
  }

  function onUnauthorized() {
    if (state.authed) {
      state.authed = false;
      openLogin('the session expired, sign in again');
    }
  }

  function submitLogin(apiKey) {
    if (loginPending) return;
    loginPending = true;
    var button = $('#login-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';

    api
      .login(apiKey)
      .then(function () {
        state.apiKey = apiKey;
        writeStore(LS_KEY, apiKey);
        state.authed = true;
        closeLogin();
        start();
      })
      .catch(function (err) {
        var error = $('#login-error');
        error.textContent = err.message;
        error.hidden = false;
      })
      .then(function () {
        loginPending = false;
        button.disabled = false;
        button.textContent = 'Sign in';
      });
  }

  /* ================================================================ keyboard */

  function isTypingTarget(node) {
    if (!node) return false;
    var tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (!$('#popover').hidden) {
        closePopover();
        return;
      }
      if (!$('#drawer').hidden) {
        closeDrawer();
        return;
      }
      if (isTypingTarget(event.target)) event.target.blur();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (state.route !== '#/queue') return;

    var key = event.key.toLowerCase();
    if (key === 'j') {
      event.preventDefault();
      Queue.move(1);
    } else if (key === 'k') {
      event.preventDefault();
      Queue.move(-1);
    } else if (key === 'a') {
      var approveId = Queue.focusedId();
      if (approveId) {
        event.preventDefault();
        Queue.approve(approveId);
      }
    } else if (key === 'r') {
      var rejectId = Queue.focusedId();
      if (rejectId) {
        event.preventDefault();
        Queue.reject(rejectId);
      }
    } else if (key === 'e') {
      event.preventDefault();
      Queue.focusEditor();
    }
  }

  /* =================================================================== boot */

  var started = false;

  function start() {
    if (started) return;
    started = true;

    applyRoute();
    loadProfiles().then(function () {
      markDirty('queue');
    });
    refreshHealth();
    refreshStats();
    seedFeed();
    Queue.load(true);
    connectStream();

    window.setInterval(function () {
      if (document.hidden) return;
      refreshHealth();
      refreshStats();
    }, REFRESH_MS);
  }

  function bootstrap() {
    toastHost = $('#toasts');
    popover = $('#popover');

    Live.init();
    Queue.init();
    Jobs.init();
    Profiles.init();
    Settings.init();

    $('#refresh-btn').addEventListener('click', function () {
      refreshHealth();
      refreshStats();
      if (state.route === '#/queue') Queue.load(true);
      else if (state.route === '#/jobs') Jobs.load(true);
      else if (state.route === '#/profiles') loadProfiles();
      else pollOnce();
      toast('refreshed', 'info', 1500);
    });

    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-scrim').addEventListener('click', closeDrawer);

    $('#login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var value = $('#login-key').value.trim();
      if (value === '') return;
      submitLogin(value);
    });

    document.addEventListener('click', function (event) {
      if (!popover || popover.hidden) return;
      if (popover.contains(event.target)) return;
      if (event.target.closest && event.target.closest('[data-action="why"]')) return;
      closePopover();
    });

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('hashchange', applyRoute);
    window.addEventListener('scroll', closePopover, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      tickAges();
      if (state.conn !== 'live') connectStream();
      if (state.route === '#/queue') Queue.load(false);
    });

    window.addEventListener('online', function () {
      toast('back online', 'success', 2000);
      connectStream();
    });

    window.addEventListener('offline', function () {
      setConn('offline');
    });

    window.setInterval(tickAges, 1000);

    if (!window.location.hash) window.location.hash = DEFAULT_ROUTE;
    renderChrome();

    api
      .session()
      .then(function (data) {
        state.authRequired = !data || data.authRequired !== false;
        if (data && data.authenticated) {
          state.authed = true;
          start();
          return;
        }
        if (state.apiKey) {
          submitLogin(state.apiKey);
          return;
        }
        openLogin(null);
      })
      .catch(function (err) {
        if (state.apiKey) {
          submitLogin(state.apiKey);
          return;
        }
        openLogin(err.message);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
})();
