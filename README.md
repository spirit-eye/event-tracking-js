# Event Tracking JS

Universal tracking SDK for websites and WeChat mini programs.

## Features

- Auto page visit tracking: `page_view`, `page_leave`, `page_unload`.
- Auto click tracking: `ui_click`.
- Auto scroll tracking: `scroll`.
- Manual event reporting through `report(eventName, eventData)`.
- Batched upload to `verbose-tracking-spring`.

## Website Usage

```html
<script src="./sdk/event-reporter.js"></script>
<script>
  EventReporter.init({
    endpoint: 'http://localhost:8080/api/tracking/events',
    userId: 'user-1',
    appId: 'web-demo',
    platform: 'web',
    debug: true
  });

  EventReporter.report('purchase_submit', {
    orderId: 'order-1',
    amount: 199
  });
</script>
```

## WeChat Mini Program Usage

```js
// app.js
const EventReporter = require('./sdk/event-reporter');

EventReporter.init({
  endpoint: 'http://localhost:8080/api/tracking/events',
  userId: wx.getStorageSync('userId') || 'guest',
  appId: 'mini-demo',
  platform: 'miniprogram'
});
```

The SDK sends batches to `${endpoint}/batch` by default. Override `batchEndpoint`
if your gateway path is different.
