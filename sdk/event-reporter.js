// sdk/event-reporter.js

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EventReporter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SDK_VERSION = '1.0.0';
  const STORAGE_ANONYMOUS_ID = 'event_tracking_anonymous_id';
  const STORAGE_SESSION_ID = 'event_tracking_session_id';

  class EventReporter {
    constructor() {
      this.config = {
        endpoint: '',
        batchEndpoint: '',
        userId: null,
        appId: '',
        deviceId: '',
        platform: detectPlatform(),
        debounceInterval: 500,
        scrollInterval: 1000,
        batchSize: 10,
        flushInterval: 5000,
        autoTrack: true,
        debug: false,
      };
      this._lastEventTimestamps = {};
      this._queue = [];
      this._timer = null;
      this._inited = false;
      this._lastScrollTime = 0;
      this._reportedScrollDepths = {};
      this._anonymousId = '';
      this._sessionId = '';
    }

    init(options = {}) {
      if (!options.endpoint && !this.config.endpoint) {
        throw new Error('[EventReporter] endpoint is required');
      }

      this.config = {
        ...this.config,
        ...options,
      };
      this.config.batchEndpoint = options.batchEndpoint
        || (options.endpoint ? appendBatchPath(options.endpoint) : this.config.batchEndpoint)
        || appendBatchPath(this.config.endpoint);
      this._anonymousId = options.anonymousId || getStoredId(STORAGE_ANONYMOUS_ID);
      this._sessionId = options.sessionId || getStoredId(STORAGE_SESSION_ID);
      this.config.userId = options.userId || this.config.userId || readStorage('userId') || 'guest';

      if (this.config.autoTrack && !this._inited) {
        if (isMiniProgram()) {
          this._patchPage();
          this._patchComponent();
        } else if (isBrowser()) {
          this._bindWebAutoTrack();
        }
        this._inited = true;
      }

      this._startTimer();
      return this;
    }

    setUser(userId) {
      this.config.userId = userId || 'guest';
      writeStorage('userId', this.config.userId);
    }

    report(eventName, eventData = {}, options = {}) {
      if (!eventName) {
        return;
      }

      const now = Date.now();
      const debounceKey = options.debounceKey || eventName;
      const lastTime = this._lastEventTimestamps[debounceKey] || 0;
      if (!options.bypassDebounce && now - lastTime < this.config.debounceInterval) {
        this._debug('[report] 忽略重复事件', eventName);
        return;
      }
      this._lastEventTimestamps[debounceKey] = now;

      const payload = this._buildPayload(eventName, eventData, now);
      if (options.immediate) {
        this._sendBatch([payload]);
        return;
      }

      this._queue.push(payload);
      if (this._queue.length >= this.config.batchSize) {
        this.flush();
      }
    }

    flush() {
      if (this._queue.length === 0) {
        return;
      }

      const events = this._queue.splice(0, this._queue.length);
      this._sendBatch(events);
    }

    _buildPayload(eventName, eventData, now) {
      const context = getPageContext();
      return {
        eventId: createId('evt'),
        eventName,
        eventData,
        timestamp: new Date(now).toISOString(),
        userId: this.config.userId,
        anonymousId: this._anonymousId,
        sessionId: this._sessionId,
        platform: this.config.platform,
        pageUrl: context.pageUrl,
        route: context.route,
        referrer: context.referrer,
        sdkVersion: SDK_VERSION,
        appId: this.config.appId,
        deviceId: this.config.deviceId,
      };
    }

    _sendBatch(events) {
      if (!this.config.batchEndpoint || events.length === 0) {
        return;
      }

      const body = { events };
      if (isMiniProgram()) {
        wx.request({
          url: this.config.batchEndpoint,
          method: 'POST',
          data: body,
          header: {
            'content-type': 'application/json',
          },
          success: (res) => this._debug('[report] 上报成功', res),
          fail: (err) => {
            this._queue.unshift(...events);
            this._debug('[report] 上报失败', err);
          },
        });
        return;
      }

      const serialized = JSON.stringify(body);
      if (isBrowser() && navigator.sendBeacon && serialized.length < 60000) {
        const sent = navigator.sendBeacon(
          this.config.batchEndpoint,
          new Blob([serialized], { type: 'application/json' })
        );
        if (sent) {
          this._debug('[report] beacon 上报成功', events.length);
          return;
        }
      }

      if (typeof fetch === 'function') {
        fetch(this.config.batchEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: serialized,
          keepalive: events.length <= 10,
        }).catch((err) => {
          this._queue.unshift(...events);
          this._debug('[report] fetch 上报失败', err);
        });
        return;
      }

      this._queue.unshift(...events);
      this._debug('[report] 当前运行时没有可用的上报传输');
    }

    _bindWebAutoTrack() {
      const onReady = () => {
        this.report('page_view', getPageContext(), { immediate: true, bypassDebounce: true });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
      } else {
        onReady();
      }

      document.addEventListener('click', (event) => {
        this.report('ui_click', describeElement(event.target, event), {
          debounceKey: `click:${event.clientX}:${event.clientY}`,
        });
      }, true);

      window.addEventListener('scroll', () => {
        this._reportWebScroll();
      }, { passive: true });

      window.addEventListener('beforeunload', () => {
        this.report('page_leave', getPageContext(), { immediate: true, bypassDebounce: true });
        this.flush();
      });
    }

    _reportWebScroll() {
      const now = Date.now();
      if (now - this._lastScrollTime < this.config.scrollInterval) {
        return;
      }
      this._lastScrollTime = now;

      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const fullHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
        viewportHeight
      );
      const depth = Math.min(100, Math.round(((scrollTop + viewportHeight) / fullHeight) * 100));
      const bucket = [25, 50, 75, 100].find((value) => depth <= value) || 100;
      if (this._reportedScrollDepths[bucket]) {
        return;
      }
      this._reportedScrollDepths[bucket] = true;
      this.report('scroll', { depth, scrollTop, viewportHeight, fullHeight }, {
        debounceKey: `scroll:${bucket}`,
        bypassDebounce: true,
      });
    }

    _patchPage() {
      if (typeof Page !== 'function' || Page.__eventReporterPatched) {
        return;
      }

      const originPage = Page;
      const self = this;
      Page = function (pageObj) {
        const originShow = pageObj.onShow;
        pageObj.onShow = function (...args) {
          self.report('page_view', { route: this.route }, { immediate: true, bypassDebounce: true });
          if (typeof originShow === 'function') {
            return originShow.apply(this, args);
          }
        };

        const originHide = pageObj.onHide;
        pageObj.onHide = function (...args) {
          self.report('page_leave', { route: this.route }, { immediate: true, bypassDebounce: true });
          if (typeof originHide === 'function') {
            return originHide.apply(this, args);
          }
        };

        const originUnload = pageObj.onUnload;
        pageObj.onUnload = function (...args) {
          self.report('page_unload', { route: this.route }, { immediate: true, bypassDebounce: true });
          if (typeof originUnload === 'function') {
            return originUnload.apply(this, args);
          }
        };

        const originScroll = pageObj.onPageScroll;
        pageObj.onPageScroll = function (event = {}) {
          self._reportMiniProgramScroll(this.route, event.scrollTop || 0);
          if (typeof originScroll === 'function') {
            return originScroll.apply(this, arguments);
          }
        };

        Object.keys(pageObj).forEach((key) => {
          if (typeof pageObj[key] === 'function' && isClickHandler(key)) {
            const origin = pageObj[key];
            pageObj[key] = function (event) {
              self.report('ui_click', {
                handler: key,
                route: this.route,
                dataset: event && event.currentTarget ? event.currentTarget.dataset : {},
              });
              return origin.apply(this, arguments);
            };
          }
        });

        return originPage(pageObj);
      };
      Page.__eventReporterPatched = true;
    }

    _patchComponent() {
      if (typeof Component !== 'function' || Component.__eventReporterPatched) {
        return;
      }

      const originComponent = Component;
      const self = this;
      Component = function (compObj) {
        if (!compObj.lifetimes) {
          compObj.lifetimes = {};
        }

        ['attached', 'detached'].forEach((life) => {
          const origin = compObj.lifetimes[life];
          compObj.lifetimes[life] = function (...args) {
            self.report(`component_${life}`, { is: this.is });
            if (typeof origin === 'function') {
              return origin.apply(this, args);
            }
          };
        });

        Object.keys(compObj.methods || {}).forEach((key) => {
          if (typeof compObj.methods[key] === 'function' && isClickHandler(key)) {
            const origin = compObj.methods[key];
            compObj.methods[key] = function (event) {
              self.report('ui_click', {
                handler: key,
                is: this.is,
                dataset: event && event.currentTarget ? event.currentTarget.dataset : {},
              });
              return origin.apply(this, arguments);
            };
          }
        });

        return originComponent(compObj);
      };
      Component.__eventReporterPatched = true;
    }

    _reportMiniProgramScroll(route, scrollTop) {
      const now = Date.now();
      if (now - this._lastScrollTime < this.config.scrollInterval) {
        return;
      }
      this._lastScrollTime = now;
      this.report('scroll', { route, scrollTop }, { debounceKey: `scroll:${route}`, bypassDebounce: true });
    }

    _startTimer() {
      if (this._timer) {
        return;
      }
      this._timer = setInterval(() => this.flush(), this.config.flushInterval);
      if (this._timer && typeof this._timer.unref === 'function') {
        this._timer.unref();
      }
    }

    _debug(...args) {
      if (this.config.debug && typeof console !== 'undefined') {
        console.log(...args);
      }
    }
  }

  function isMiniProgram() {
    return typeof wx !== 'undefined' && typeof wx.request === 'function';
  }

  function isBrowser() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }

  function detectPlatform() {
    return isMiniProgram() ? 'miniprogram' : 'web';
  }

  function appendBatchPath(endpoint) {
    if (!endpoint) {
      return '';
    }
    return endpoint.endsWith('/batch') ? endpoint : `${endpoint.replace(/\/$/, '')}/batch`;
  }

  function createId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function readStorage(key) {
    try {
      if (isMiniProgram()) {
        return wx.getStorageSync(key);
      }
      if (isBrowser()) {
        return window.localStorage.getItem(key);
      }
    } catch (err) {
      return '';
    }
    return '';
  }

  function writeStorage(key, value) {
    try {
      if (isMiniProgram()) {
        wx.setStorageSync(key, value);
      } else if (isBrowser()) {
        window.localStorage.setItem(key, value);
      }
    } catch (err) {
      // Storage can be unavailable in private browsing or restricted mini program contexts.
    }
  }

  function getStoredId(key) {
    const current = readStorage(key);
    if (current) {
      return current;
    }
    const next = createId(key.includes('session') ? 'ses' : 'anon');
    writeStorage(key, next);
    return next;
  }

  function getPageContext() {
    if (isMiniProgram() && typeof getCurrentPages === 'function') {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      return {
        route: current ? current.route : '',
        pageUrl: current ? current.route : '',
        referrer: '',
      };
    }

    if (isBrowser()) {
      return {
        route: window.location.pathname,
        pageUrl: window.location.href,
        referrer: document.referrer || '',
      };
    }

    return {
      route: '',
      pageUrl: '',
      referrer: '',
    };
  }

  function describeElement(target, event) {
    const element = target && target.closest ? target.closest('a,button,[role="button"],input,select,textarea,[data-track-id]') || target : target;
    return {
      tag: element && element.tagName ? element.tagName.toLowerCase() : '',
      id: element && element.id ? element.id : '',
      className: element && element.className && typeof element.className === 'string' ? element.className : '',
      text: element && element.innerText ? element.innerText.trim().slice(0, 120) : '',
      trackId: element && element.dataset ? element.dataset.trackId || '' : '',
      x: event ? event.clientX : undefined,
      y: event ? event.clientY : undefined,
    };
  }

  function isClickHandler(name) {
    const lowerName = name.toLowerCase();
    return lowerName.includes('tap') || lowerName.includes('click');
  }

  return new EventReporter();
});
