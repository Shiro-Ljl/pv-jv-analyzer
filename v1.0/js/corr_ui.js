/* V2 · P3 相关性矩阵 + 散点 UI（P3 界面层）
 * 职责：工具栏「🔗 相关性分析」→ 模态内
 *   ① 8×8 Pearson 相关性矩阵热图（r 两位 + 星号，divergent 配色 + visualMap）
 *   ② 点击矩阵格 → 散点联动（点色按条件，tooltip「条件 · 器件 #n」，最小二乘拟合线 + R²/p/星号）
 *   ③ 条件选择栏（t4-4）：每个已勾选条件一个 checkbox + 全选/清空；
 *      选择子集变化 → 重跑 buildRows/buildMatrix 重渲矩阵与散点、重算结论；选择状态跨格保持
 *   ④ 「参考性结论」区（t4-5）：基于 JVCorr.summarize(rows, matrix) 按 level 着色渲染，随选择/矩阵更新
 * 依赖：JVParser / JVFit / JVCorr（js/corr.js）、JVChart（paletteColor）、echarts。
 * 无算法：corr.js / fit.js / parser.js / analysis.js 为队长维护，本文件只做界面。
 * 产品代码风格：var/function（ES5）、中文注释。挂 globalThis.JVCorrUI。
 */
(function (global) {
  'use strict';

  var CR = global.JVCorr;
  var C = global.JVChart;

  var instances = [];        // 模态内全部图表实例（关闭时统一 dispose）
  var lastConditions = [];   // 勾选条件（条件选择栏对照序列）
  var selNames = [];         // 当前选中的条件名（默认全选，t4-4）
  var lastBuilt = null;      // buildRows(选中子集) 结果 { rows, params }
  var curPair = null;        // 当前散点 { keyA, keyB }（跨格保持）

  var PALETTE = ['#4A78C8', '#E2574C', '#22A06B', '#E8912D', '#7C6BD9', '#2AA7B8', '#8D6E63', '#D4568F', '#8A8F98', '#7A9E42'];

  function $(id) { return document.getElementById(id); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function condNameOf(c) { return c.displayName || c.name; }

  /** 条件色：优先 chartStyle.condColors，否则按条件序号调色板 */
  function condColor(i, cond) {
    var ck = condNameOf(cond);
    if (C && C.chartStyle && C.chartStyle.condColors && C.chartStyle.condColors[ck]) {
      return C.chartStyle.condColors[ck];
    }
    return PALETTE[i % PALETTE.length];
  }

  function condIndex(name) {
    for (var i = 0; i < lastConditions.length; i++) {
      if (condNameOf(lastConditions[i]) === name) return i;
    }
    return 0;
  }

  /** 刻度精简 */
  function trimNum(v) {
    if (!isNum(v)) return '—';
    if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + 'k';
    if (v === Math.round(v)) return String(v);
    if (Math.abs(v) >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function paramName(p) {
    return p.label + (p.unit ? ' (' + p.unit + ')' : '');
  }

  /** t8：n/J₀ 取数口径（localStorage 持久化，默认 avg=正反扫平均主值） */
  function corrMode() {
    try {
      var m = localStorage.getItem('jv-corr-mode');
      if (m === 'rev' || m === 'fwd' || m === 'avg') return m;
    } catch (e) { /* 无 localStorage 用默认 */ }
    return 'avg';
  }
  function setCorrMode(m) {
    try { localStorage.setItem('jv-corr-mode', m); } catch (e) { /* 忽略 */ }
  }
  var MODE_LABEL = { avg: '汇总', rev: '反扫', fwd: '正扫' };
  var MODE_LABEL_EN = { avg: 'summary', rev: 'reverse', fwd: 'forward' }; // i18n：模式标签英文

  /** t4-4：按选中子集重建数据（rows/matrix）；选择状态跨格保持（不重置 curPair） */
  function buildView() {
    var conds = lastConditions.filter(function (c) { return selNames.indexOf(condNameOf(c)) >= 0; });
    lastBuilt = CR.buildRows(conds, { mode: corrMode() }); // t8：口径切换
    return CR.buildMatrix(lastBuilt.rows);
  }

  /* ================================================================
   * 条件选择栏（t4-4）
   * ================================================================ */
  function renderSelBar() {
    var box = $('corr-sel-box');
    if (!box) return;
    box.innerHTML = '';
    lastConditions.forEach(function (c, i) {
      var nm = condNameOf(c);
      var label = document.createElement('label');
      label.className = 'corr-sel-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selNames.indexOf(nm) >= 0;
      cb.setAttribute('data-cond', nm);
      var dot = document.createElement('span');
      dot.className = 'corr-sel-dot';
      dot.style.background = condColor(i, c);
      label.appendChild(cb);
      label.appendChild(dot);
      label.appendChild(document.createTextNode(nm));
      cb.addEventListener('change', function () {
        if (cb.checked) {
          if (selNames.indexOf(nm) < 0) selNames.push(nm);
        } else {
          var k = selNames.indexOf(nm);
          if (k >= 0) selNames.splice(k, 1);
        }
        if (!selNames.length) {
          selNames = [nm]; // 至少保留一个（条件内相关仍有意义）
          cb.checked = true;
          if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast('至少保留一个条件');
        }
        refreshView();
      });
      box.appendChild(label);
    });
  }

  function bindSelButtons() {
    var all = $('corr-sel-all');
    var none = $('corr-sel-none');
    if (all) all.addEventListener('click', function () {
      selNames = lastConditions.map(condNameOf);
      syncSelChecks();
      refreshView();
    });
    if (none) none.addEventListener('click', function () {
      // 清空后保留第一个已勾选条件（至少一个）
      var first = lastConditions.length ? condNameOf(lastConditions[0]) : '';
      selNames = first ? [first] : [];
      syncSelChecks();
      refreshView();
    });
  }

  function syncSelChecks() {
    var box = $('corr-sel-box');
    if (!box) return;
    var cbs = box.querySelectorAll('input[type="checkbox"]');
    Array.prototype.forEach.call(cbs, function (cb) {
      cb.checked = selNames.indexOf(cb.getAttribute('data-cond')) >= 0;
    });
  }

  /** 选择变化 → 矩阵 + 散点（保持 curPair）+ 结论重算 */
  function refreshView() {
    if (!lastBuilt) return;
    var m = buildView();
    renderMatrix($('corr-matrix'), lastBuilt, m);
    renderSummary(m);
    if (curPair) {
      selectPairByKeys(curPair.keyA, curPair.keyB);
    } else {
      var best = findBest(m);
      if (best) selectPairByKeys(lastBuilt.params[best.i].key, lastBuilt.params[best.j].key);
    }
  }

  /* ================================================================
   * 矩阵热图
   * ================================================================ */
  function renderMatrix(dom, built, m) {
    if (!dom) return;
    var params = built.params;
    var N = params.length;
    var data = [];
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < N; j++) {
        var cell = m[i][j];
        var r = cell && isNum(cell.r) ? cell.r : null;
        var txt;
        if (r === null) { txt = '—'; }
        else if (i === j) { txt = '1.00'; }
        else { txt = r.toFixed(2) + (cell.star || ''); }
        data.push({
          value: [i, j, r === null ? 0 : r],
          r: r,
          txt: txt,
          cell: cell
        });
      }
    }
    var names = params.map(function (p) { return p.label; });
    var chart = freshChart(dom);
    chart.setOption({
      backgroundColor: '#ffffff',
      animation: false,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#C6CFDC',
        textStyle: { color: '#1F2329', fontSize: 12 },
        formatter: function (p) {
          var it = p.data;
          var ca = params[it.value[0]], cb = params[it.value[1]];
          if (!it.cell || it.r === null) {
            return '<b>' + ca.label + ' × ' + cb.label + '</b><br/>数据不足（成对有效 n &lt; 3）';
          }
          var c = it.cell;
          return '<b>' + ca.label + ' × ' + cb.label + '</b><br/>' +
            'r = ' + c.r.toFixed(3) + '<br/>' +
            'p = ' + c.p.toExponential(1) + '<br/>' +
            'n = ' + c.n + '<br/>' +
            '显著性 ' + (c.star || 'ns');
        }
      },
      grid: { left: 58, right: 18, top: 38, bottom: 84, containLabel: false },
      xAxis: {
        type: 'category', data: names, position: 'top',
        axisLabel: { fontSize: 11, interval: 0 },
        axisLine: { onZero: false, lineStyle: { color: '#999' } },
        splitArea: { show: false }
      },
      yAxis: {
        type: 'category', data: names, inverse: true,
        axisLabel: { fontSize: 11, interval: 0 },
        axisLine: { onZero: false, lineStyle: { color: '#999' } }
      },
      visualMap: {
        min: -1, max: 1,
        orient: 'horizontal', left: 'center', bottom: 6,
        itemWidth: 12, itemHeight: 70,
        text: ['1', '-1'],
        inRange: { color: ['#d73027', '#fee08b', '#1a9850'] },
        textStyle: { fontSize: 10, color: '#666' }
      },
      series: [{
        type: 'heatmap',
        data: data,
        label: {
          show: true,
          fontSize: 9.5,
          formatter: function (p) {
            var it = p.data;
            return it ? it.txt : '';
          }
        },
        itemStyle: {
          borderColor: '#fff',
          borderWidth: 1
        }
      }]
    });
    chart.on('click', function (params) {
      var it = params.data;
      if (!it || it.r === null) return;
      var keys = lastBuilt.params;
      selectPairByKeys(keys[params.value[0]].key, keys[params.value[1]].key);
    });
  }

  /** 替换指定容器上的图表实例（t5 修复）：init 前先显式 dispose 旧实例——
   *  原因：echarts.init 对已初始化 dom 会「复用」旧实例引用，若之后再 dispose 会把刚
   *  复用的实例杀掉（把矩阵/散点弄成永久空白，尤其在多次切换条件子集后暴露）。
   *  这里先 dispose 再 init，保证每次都是干净的新实例。 */
  function freshChart(dom) {
    var old = global.echarts.getInstanceByDom(dom);
    if (old) {
      instances = instances.filter(function (c) { return c !== old; });
      try { old.dispose(); } catch (e) { /* 已释放忽略 */ }
    }
    var chart = global.echarts.init(dom, null, { renderer: 'svg' });
    instances.push(chart);
    return chart;
  }
  /** 释放指定容器实例（t5：换格/换数据前调用，避免旧实例残留） */
  function dropInstance(dom) {
    var old = global.echarts.getInstanceByDom(dom);
    if (old) {
      instances = instances.filter(function (c) { return c !== old; });
      try { old.dispose(); } catch (e) { /* 已释放忽略 */ }
    }
    if (dom) dom.innerHTML = '';
  }

  /* ================================================================
   * 散点 + 拟合线
   * ================================================================ */
  function lsFit(xs, ys) {
    var n = xs.length;
    if (n < 2) return { a: 0, b: 0, ok: false };
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0;
    for (var j = 0; j < n; j++) {
      num += (xs[j] - mx) * (ys[j] - my);
      dx += (xs[j] - mx) * (xs[j] - mx);
    }
    var b = dx > 0 ? num / dx : 0;
    return { a: my - b * mx, b: b, ok: true };
  }

  function renderScatter(built, keyA, keyB, titleEl) {
    var dom = $('corr-scatter');
    if (!dom) return;
    var rows = built.rows, params = built.params;
    var pA = params.filter(function (p) { return p.key === keyA; })[0] || params[0];
    var pB = params.filter(function (p) { return p.key === keyB; })[0] || params[1];
    var pts = CR.scatter(rows, keyA, keyB);
    var pr = CR.pair(rows, keyA, keyB);

    // t5 修复 b：子集下该参数对无有效器件 → 明确提示而非空白
    if (!pts.length) {
      dropInstance(dom);
      var msg = document.createElement('div');
      msg.className = 'corr-scatter-empty';
      var enMsg = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：无数据提示
      msg.textContent = enMsg
        ? 'No valid devices (or too few samples) for this parameter pair on the selected conditions (' + paramName(pA) + ' × ' + paramName(pB) + '); no scatter to plot.'
        : '所选条件下该参数对（' + paramName(pA) + ' × ' + paramName(pB) + '）无有效器件（或样本过少），暂无可视化的散点。';
      dom.appendChild(msg);
      if (titleEl) titleEl.textContent = enMsg ? (paramName(pA) + ' × ' + paramName(pB) + '    No valid data (n=0)') : (paramName(pA) + ' × ' + paramName(pB) + '    无有效数据（n=0）');
      return;
    }

    var groups = {};
    pts.forEach(function (pt) {
      if (!groups[pt.cond]) groups[pt.cond] = [];
      groups[pt.cond].push(pt);
    });
    var series = [];
    Object.keys(groups).forEach(function (nm) {
      var i = condIndex(nm);
      var col = condColor(i, { name: nm, displayName: nm });
      series.push({
        name: nm,
        type: 'scatter',
        data: groups[nm].map(function (pt) {
          return { value: [pt.x, pt.y], cond: pt.cond, dev: pt.dev };
        }),
        symbolSize: 7,
        itemStyle: { color: col }
      });
    });

    var fit = pr && isNum(pr.r) ? lsFit(pr.x, pr.y) : null;
    if (fit && fit.ok) {
      var xs = pr.x;
      var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
      series.push({
        name: (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Fit line' : '拟合线',
        type: 'line',
        data: [[xmin, fit.a + fit.b * xmin], [xmax, fit.a + fit.b * xmax]],
        symbol: 'none',
        lineStyle: { type: 'dashed', color: '#9AA4B2', width: 1.5 },
        silent: true
      });
    }

    if (titleEl) {
      var sub = (pr && isNum(pr.r)) ? ('r=' + pr.r.toFixed(3) + '  p=' + pr.p.toExponential(1) + '  ' + (pr.star || 'ns') + '  n=' + pr.n + '  R²=' + (pr.r * pr.r).toFixed(3)) : '数据不足';
      titleEl.textContent = paramName(pA) + ' × ' + paramName(pB) + '    ' + sub;
    }

    var chart = freshChart(dom);
    chart.setOption({
      backgroundColor: '#ffffff',
      animation: false,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#C6CFDC',
        textStyle: { color: '#1F2329', fontSize: 12 },
        formatter: function (p) {
          var d = p.data;
          if (p.seriesName === '拟合线' || p.seriesName === 'Fit line') return '';
          var enTt = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：tooltip
          return (enTt ? '<b>' + (d.cond || '') + ' · Device #' + (d.dev || '—') + '</b><br/>'
                       : '<b>' + (d.cond || '') + ' · 器件 #' + (d.dev || '—') + '</b><br/>') +
            pA.label + ' = ' + trimNum(d.value[0]) + '<br/>' +
            pB.label + ' = ' + trimNum(d.value[1]);
        }
      },
      grid: { left: 70, right: 24, top: 24, bottom: 50 },
      xAxis: {
        type: 'value', name: paramName(pA),
        nameLocation: 'middle', nameGap: 30,
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 10, formatter: trimNum },
        axisLine: { onZero: false, lineStyle: { color: '#999' } },
        splitLine: { lineStyle: { type: 'dashed', color: '#EBEEF3' } }
      },
      yAxis: {
        type: 'value', name: paramName(pB),
        nameLocation: 'middle', nameGap: 44,
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 10, formatter: trimNum },
        axisLine: { onZero: false, lineStyle: { color: '#999' } },
        splitLine: { lineStyle: { type: 'dashed', color: '#EBEEF3' } }
      },
      legend: {
        selectedMode: false, // t6：不可点击开关（上方已有条件勾选栏）
        top: 2, left: 4, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 10 }, type: 'scroll'
      },
      series: series
    });
  }

  /** 选格并刷新散点（按参数 key；选择状态跨格保持不重置） */
  function selectPairByKeys(keyA, keyB) {
    if (!lastBuilt) return;
    curPair = { keyA: keyA, keyB: keyB };
    renderScatter(lastBuilt, keyA, keyB, $('corr-scatter-title'));
  }
  /** 兼容入口：按矩阵索引选格 */
  function selectPair(i, j) {
    if (!lastBuilt || !lastBuilt.params[i] || !lastBuilt.params[j]) return;
    selectPairByKeys(lastBuilt.params[i].key, lastBuilt.params[j].key);
  }

  /** 最强非对角格 */
  function findBest(m) {
    var N = m.length;
    var best = null;
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) {
      var c = m[i][j];
      if (c && isNum(c.r) && (!best || Math.abs(c.r) > Math.abs(best.r))) best = { i: i, j: j, r: c.r };
    }
    return best;
  }

  /* ================================================================
   * 参考性结论（t4-5）
   * ================================================================ */
  function renderSummary(m) {
    var el = $('corr-summary');
    if (!el || !lastBuilt) return;
    var con = (CR.summarize && CR.summarize(lastBuilt.rows, m)) || [];
    el.innerHTML = '';
    con.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'corr-con ' + (c.level === 'warn' ? 'corr-con-warn' : 'corr-con-info');
      var tx = (typeof I18N !== 'undefined' && I18N.getLang() === 'en' && c.textEn) ? c.textEn : c.text; // i18n：参考结论
      row.innerHTML = '<span class="corr-con-ic">' + (c.level === 'warn' ? '⚠' : 'ℹ') + '</span>' +
        '<span class="corr-con-tx">' + esc(tx) + '</span>';
      el.appendChild(row);
    });
  }

  /** HTML 转义 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /** 打开模态：勾选条件 → 条件选择栏（默认全选）→ 矩阵/散点/结论 */
  function open() {
    var data = global.JVMain && global.JVMain.currentData ? global.JVMain.currentData() : null;
    if (!data || !data.conditions || !data.conditions.length) {
      if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast('请先加载数据');
      return;
    }
    var checked;
    if (global.JVMain && global.JVMain.checkedConditions) checked = global.JVMain.checkedConditions(data);
    else checked = data.conditions;
    if (!checked || !checked.length) {
      if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast('请先勾选至少一个条件');
      return;
    }
    var modal = $('corr-modal');
    if (!modal) return;
    dispose();
    lastConditions = checked;
    selNames = checked.length ? [condNameOf(checked[0])] : []; // t6：默认仅勾选第一个条件（Base）
    // t8：口径 select 初始化 + 绑定
    var modeSel = $('corr-mode');
    if (modeSel) {
      modeSel.value = corrMode();
      modeSel.onchange = function () {
        setCorrMode(modeSel.value);
        refreshView();
        updateModeTitle();
      };
    }
    var m = buildView();

    modal.hidden = false;
    renderSelBar();
    updateModeTitle();
    renderMatrix($('corr-matrix'), lastBuilt, m);
    renderSummary(m);

    var best = findBest(m);
    if (best) selectPairByKeys(lastBuilt.params[best.i].key, lastBuilt.params[best.j].key);
    else selectPairByKeys('ff', 'j0');
  }

  /** t8：矩阵标题标注当前 n/J₀ 口径 */
  function updateModeTitle() {
    var t = document.querySelector('.corr-matrix-col .corr-fig-title');
    if (t) {
      var en = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：矩阵标题
      var mode = (en ? MODE_LABEL_EN : MODE_LABEL)[corrMode()] || '平均';
      t.textContent = en ? ('Correlation matrix (n/J₀ basis: ' + mode + ')') : ('相关性矩阵（n/J₀ 口径：' + mode + '）');
    }
  }

  function close() {
    var modal = $('corr-modal');
    if (modal) modal.hidden = true;
    dispose();
  }

  function dispose() {
    instances.forEach(function (c) {
      try { c.dispose(); } catch (e) { /* 已释放忽略 */ }
    });
    instances = [];
  }

  function bind() {
    if (typeof document === 'undefined') return;
    var btn = $('btn-corr-analysis');
    if (btn) btn.addEventListener('click', open);
    var modal = $('corr-modal');
    if (modal) {
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    }
    var closeBtn = $('corr-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n:changed', function () {
        var m = $('corr-modal');
        if (m && !m.hidden) open(); // N6：同 equiv（open 重渲染前 dispose 释放旧 ECharts 实例，幂等）
      });
    }
    bindSelButtons();
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var lb = $('chart-lightbox');
      if (lb && !lb.hidden) return;
      var helpM = $('help-modal');
      if (helpM && !helpM.hidden) return; // help 的 Esc 由 equiv_ui 处理
      var em = $('equiv-modal');
      if (em && !em.hidden) return; // equiv 的 Esc 由 equiv_ui 处理
      if (modal && !modal.hidden) close();
    });
  }

  if (typeof document !== 'undefined') {
    bind();
  }

  global.JVCorrUI = {
    open: open,
    close: close,
    dispose: dispose,
    selectPair: selectPair,
    refreshView: refreshView
  };
})(typeof window !== 'undefined' ? window : globalThis);
