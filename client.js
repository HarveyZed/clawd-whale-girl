// Browser half: contributes a configurable tab to Settings -> Plugins.
// Registered into the list slot 'settings.plugins.tab' with this plugin's id,
// which is how dsh-client-ui-settings-plugins addresses the tab.
// Talks to the host half through /clawd-extras/params (GET/POST).
window.__ModuleLoader__.load({
  id: 'dsh-clawd-extras',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var inject = ['slots'];
    var NS = 'dsh-clawd-extras';
    var ROUTE = '/dsh-clawd-extras/params';

    var CSS = [
      '.cxp{display:flex;flex-direction:column;gap:14px;max-width:640px;padding:4px 0}',
      '.cxp-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.cxp-label{font-size:13px;color:var(--dsw-alias-label-primary,#222)}',
      '.cxp-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px}',
      '.cxp input[type=number],.cxp input[type=text],.cxp select{width:160px;padding:4px 6px;font:inherit;border:1px solid #ccc;border-radius:6px}',
      '.cxp input[type=checkbox]{width:16px;height:16px}',
      '.cxp button{padding:6px 14px;border:0;border-radius:6px;background:var(--dsw-static-deepseek-450,#4d6bfe);color:#fff;cursor:pointer;font:inherit}',
      '.cxp button[disabled]{opacity:.5;cursor:default}',
      '.cxp-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}',
    ].join('\n');

    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="dsh-clawd-extras/panel"]') === null) {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-clawd-extras';
      tag.dataset.pluginCss = 'clawd-extras/panel';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function label(text, hint) {
      return React.createElement('div', null,
        React.createElement('div', { className: 'cxp-label' }, text),
        hint ? React.createElement('div', { className: 'cxp-hint' }, hint) : null);
    }

    function numberRow(title, hint, value, onChange) {
      return React.createElement('div', { className: 'cxp-row', key: title },
        label(title, hint),
        React.createElement('input', {
          type: 'number', value: value == null ? '' : value,
          onChange: function (e) { onChange(e.target.value === '' ? null : Number(e.target.value)); },
        }));
    }

    function checkboxRow(title, hint, value, onChange) {
      return React.createElement('div', { className: 'cxp-row', key: title },
        label(title, hint),
        React.createElement('input', { type: 'checkbox', checked: !!value, onChange: function (e) { onChange(e.target.checked); } }));
    }

    function selectRow(title, hint, value, options, onChange) {
      return React.createElement('div', { className: 'cxp-row', key: title },
        label(title, hint),
        React.createElement('select', { value: value, onChange: function (e) { onChange(e.target.value); } },
          options.map(function (o) { return React.createElement('option', { key: o, value: o }, o); })));
    }

    function ConfigPanel() {
      var state = React.useState(null);
      var cfg = state[0];
      var setCfg = state[1];
      var statusState = React.useState('加载中…');
      var status = statusState[0];
      var setStatus = statusState[1];
      var savingState = React.useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];

      function load() {
        fetch(ROUTE, { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) { setCfg(data); setStatus(''); })
          .catch(function (e) { setStatus('读取失败：' + String(e && e.message || e)); });
      }
      React.useEffect(function () { load(); }, []);

      function update(path, value) {
        setCfg(function (prev) {
          var next = Object.assign({}, prev);
          next.balance = Object.assign({}, prev.balance);
          if (path.indexOf('balance.') === 0) next.balance[path.slice(8)] = value;
          else next[path] = value;
          return next;
        });
      }

      function save() {
        setSaving(true);
        setStatus('保存中…');
        fetch(ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.config) setCfg(data.config);
            setStatus(data && data.ok ? ('已生效' + (data.persisted ? '（已写入 params.json）' : '（仅内存）')) : '保存失败');
          })
          .catch(function (e) { setStatus('保存失败：' + String(e && e.message || e)); })
          .then(function () { setSaving(false); });
      }

      if (cfg === null) return React.createElement('div', { className: 'cxp' }, status || '加载中…');

      return React.createElement('div', { className: 'cxp' },
        numberRow('余额告警阈值', '余额低于它开始提醒；低于一半时升级为严重', cfg.balance.threshold,
          function (v) { update('balance.threshold', v); }),
        selectRow('告警模式', 'flash 闪一下；sticky 持续显示', cfg.balance.mode, ['flash', 'sticky'],
          function (v) { update('balance.mode', v); }),
        numberRow('flash 显示时长 (ms)', null, cfg.balance.flashMs, function (v) { update('balance.flashMs', v); }),
        numberRow('余额轮询间隔 (ms)', null, cfg.balance.refreshMs, function (v) { update('balance.refreshMs', v); }),
        numberRow('重复提醒间隔 (ms)', '0 = 关闭', cfg.balance.remindEveryMs, function (v) { update('balance.remindEveryMs', v); }),
        checkboxRow('余额告警总开关', null, cfg.balance.enabled, function (v) { update('balance.enabled', v); }),
        checkboxRow('上下文用量', '把 DSH 的 surfaceTokens/contextWindow 上报给 Clawd', cfg.contextUsage,
          function (v) { update('contextUsage', v); }),
        checkboxRow('等待审批动画', 'approval/asked -> notification', cfg.approvalNotification,
          function (v) { update('approvalNotification', v); }),
        checkboxRow('子代理动画', 'subagent/team -> juggling', cfg.subagentJuggling,
          function (v) { update('subagentJuggling', v); }),
        checkboxRow('压缩动画', 'compaction -> sweeping', cfg.compactionSweeping,
          function (v) { update('compactionSweeping', v); }),
        numberRow('上下文窗口兜底', 'request/context 收不到时使用', cfg.contextWindowFallback,
          function (v) { update('contextWindowFallback', v); }),
        React.createElement('div', { className: 'cxp-row' },
          React.createElement('span', { className: 'cxp-status' }, status),
          React.createElement('button', { type: 'button', disabled: saving, onClick: save }, saving ? '保存中…' : '保存并生效')));
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-clawd-extras',
          order: 50,
          label: 'Clawd 扩展',
        }, ConfigPanel);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
