// sdk/event-reporter.js

class EventReporter {
    constructor() {
      this.config = {
        endpoint: '',       // 事件上报接口
        userId: null,       // 用户 ID
        platform: 'miniprogram',
        debounceInterval: 500,  // 同一事件防抖间隔（毫秒）
        autoTrack: true,    // 是否自动化上报
      };
      this._lastEventTimestamps = {};
      this._inited = false;
    }
  
    init({ endpoint, userId, autoTrack = true }) {
      this.config.endpoint = endpoint;
      this.config.userId = userId || wx.getStorageSync('userId') || 'guest';
      this.config.autoTrack = autoTrack;
      if (autoTrack && !this._inited) {
        this._patchPage();
        this._patchComponent();
        this._inited = true;
      }
    }
  
    report(eventName, eventData = {}, options = {}) {
      const now = Date.now();
      // 简单防抖：阻止 500ms 内重复同一事件
      const lastTime = this._lastEventTimestamps[eventName] || 0;
      if (now - lastTime < this.config.debounceInterval) {
        console.warn(`[report] 忽略重复事件: ${eventName}`);
        return;
      }
      this._lastEventTimestamps[eventName] = now;
      const payload = {
        eventName,
        eventData,
        timestamp: now,
        userId: this.config.userId,
        platform: this.config.platform,
      };
      wx.request({
        url: this.config.endpoint,
        method: 'POST',
        data: payload,
        header: {
          'content-type': 'application/json'
        },
        success: res => {
          if (options.debug) {
            console.log(`[report] ${eventName} 上报成功`, res);
          }
        },
        fail: err => {
          console.error(`[report] ${eventName} 上报失败`, err);
        }
      });
    }
  
    _patchPage() {
      const originPage = Page;
      const self = this;
      Page = function (pageObj) {
        // 自动上报页面生命周期
        const lifeCycles = ['onShow', 'onHide', 'onUnload'];
        lifeCycles.forEach(life => {
          const origin = pageObj[life];
          pageObj[life] = function (...args) {
            self.report(`page_${life}`, { route: this.route });
            if (typeof origin === 'function') {
              return origin.apply(this, args);
            }
          };
        });
        // 自动上报点击事件
        Object.keys(pageObj).forEach(key => {
          if (typeof pageObj[key] === 'function' && key.startsWith('on')) {
            const origin = pageObj[key];
            pageObj[key] = function (...args) {
              if (key.toLowerCase().includes('tap') || key.toLowerCase().includes('click')) {
                self.report('ui_click', { handler: key, route: this.route });
              }
              return origin.apply(this, args);
            };
          }
        });
        return originPage(pageObj);
      };
    }
  
    _patchComponent() {
      if (typeof Component !== 'function') return;
      const originComponent = Component;
      const self = this;
      Component = function (compObj) {
        // 自动上报组件生命周期
        const lifeCycles = ['attached', 'detached'];
        if (!compObj.lifetimes) compObj.lifetimes = {};
        lifeCycles.forEach(life => {
          const origin = compObj.lifetimes[life];
          compObj.lifetimes[life] = function (...args) {
            self.report(`component_${life}`, { is: this.is });
            if (typeof origin === 'function') {
              return origin.apply(this, args);
            }
          };
        });
        // 自动上报组件点击事件
        Object.keys(compObj.methods || {}).forEach(key => {
          if (typeof compObj.methods[key] === 'function' && (key.toLowerCase().includes('tap') || key.toLowerCase().includes('click'))) {
            const origin = compObj.methods[key];
            compObj.methods[key] = function (...args) {
              self.report('ui_click', { handler: key, is: this.is });
              return origin.apply(this, args);
            };
          }
        });
        return originComponent(compObj);
      };
    }
  }
  
  const reporter = new EventReporter();
  module.exports = reporter;
  