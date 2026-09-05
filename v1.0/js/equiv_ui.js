/* V2 · P1 等效电路分析 UI（等效电路参数提取的分析视图）
 * 职责：工具栏「⚡ 等效电路分析」→ 模态内展示
 *   ① 4 张参数分布图（Rs / Rsh(log 坐标) / n / log₁₀(J₀)，勾选条件箱线图）
 *      —— t4-2：4 图复用主图 JVChart.buildBoxplotOption（格式/标签/标题与 PCE/Voc/Jsc/FF 四图统一，
 *      随主图「⚙ 调整格式」chartStyle.single 联动；Rsh 用 logY 轴）
 *   ② 每条件诊断卡（summary + verdicts[level 着色] + advice + 参数迷你表）
 *   ③ Base 条件选择（默认第一个，变更后仅重渲染诊断卡，图不重建）
 *   ④ 「说明」按钮 → 共用 #help-modal（t4-3）
 *   ⑤ 供 PDF 导出复用：离屏渲染工厂 + 参数与诊断摘要表
 * 依赖：JVParser / JVFit / JVAnalysis（js/fit.js、js/analysis.js）、JVChart（buildBoxplotOption）与 echarts。
 * 无算法：fit.js / analysis.js / parser.js / charts.js 主逻辑为队长维护，本文件只做界面。
 * 产品代码风格：var/function（ES5）、中文注释。挂 globalThis.JVEquiv。
 */
(function (global) {
  'use strict';

  var P = global.JVParser;
  var A = global.JVAnalysis;
  var C = global.JVChart;

  var instances = [];        // 当前打开的图表实例（关闭时统一 dispose）
  var lastConditions = [];   // 最近一次渲染的勾选条件（Base 变更重渲染用）

  /* ---------- t5：4 图独立格式（localStorage 'jv_equiv_style' 持久化；与主图 ⚙ 格式并存） ----------
   * 通过 buildBoxplotOption 的 opts.styleNs 传入「主图 single 样式 + equiv 覆盖」合并对象，
   * 只覆盖字号/线宽/透明度等字段，不改主图 chartStyle；主题色随主图调色板。 */
  var DEF_STYLE = {
    tickFontSize: 14,      // 兼容回退（不直接用）
    xTickFontSize: 14,     // t6：X 刻度字号
    yTickFontSize: 14,     // t6：Y 刻度字号
    titleFontSize: 15,     // 轴标题字号(px)（箱线图仅 Y 标题）
    axisLineWidth: 1.5,    // 轴线宽
    boxWidthMin: 55, boxWidthMax: 68, // 箱体宽度
    boxFillAlpha: 0.45,    // 箱体填充透明度
    boxBorderWidth: 2,     // 箱体描边粗细(px)
    xLabelGap: 0, yLabelGap: 0, // 横纵标签间距（0=默认）
    xLabelRotate: 0,       // X 标签旋转（0=按条件数自动）
    xLabelOffset: 0        // X 轴横向偏移（旋转标签与箱体视觉对齐）
  };
  var equivStyle = Object.assign({}, DEF_STYLE);
  function loadStyle() {
    try {
      var s = JSON.parse(localStorage.getItem('jv_equiv_style'));
      if (s && typeof s === 'object') equivStyle = Object.assign({}, DEF_STYLE, s);
    } catch (e) { /* 忽略损坏存档 */ }
  }
  function saveStyle() {
    try { localStorage.setItem('jv_equiv_style', JSON.stringify(equivStyle)); } catch (e) {}
  }
  /** 主图 single 样式深拷贝 + equiv 覆盖 → buildBoxplotOption(styleNs) */
  function equivMergedStyle() {
    var base = {};
    var s = (C && C.chartStyle && C.chartStyle.single) ? C.chartStyle.single : {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      base[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? JSON.parse(JSON.stringify(v)) : v;
    });
    return Object.assign(base, equivStyle);
  }

  function $(id) { return document.getElementById(id); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** HTML 转义（条件名 / 解读文本可能含 <>& 等） */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /** 条件色（主图调色板/condColors，供图外元素用） */
  function condColor(i, cond) {
    var ck = cond.displayName || cond.name;
    if (C && C.chartStyle && C.chartStyle.condColors && C.chartStyle.condColors[ck]) {
      return C.chartStyle.condColors[ck];
    }
    if (C && C.paletteColor) return C.paletteColor(i);
    return '#4A78C8';
  }

  /** 取某条件的等效电路统计（JVAnalysis.conditionStats，诊断卡用）——透传 Rs 修正开关与温度 */
  function statsFor(cond) {
    return A.conditionStats(cond, { rsCorrect: rsCorrect(), temperatureK: tempK() });
  }

  /** t4-2：为 4 张分布图预处理每器件 _n / _j0（log₁₀）缓存，charts.paramOf 直接读取。
   *  已缓存则跳过；fit 失败置 NaN（对应参数不入统计）。
   *  t8/t9：Rs 修正开关或温度变化时清缓存重建（缓存挂在 device 上，必须随口径失效）。 */
  var cachedKey = '';
  function prepareDevices(conditions) {
    var want = rsCorrect();
    var wantT = tempK();
    var key = (want ? '1' : '0') + ':' + wantT;
    if (cachedKey !== key) {
      (conditions || []).forEach(function (c) {
        (c.devices || []).forEach(function (d) { d._n = undefined; d._j0 = undefined; });
      });
      cachedKey = key;
    }
    (conditions || []).forEach(function (c) {
      (c.devices || []).forEach(function (d) {
        if (d._n !== undefined && d._j0 !== undefined) return;
        var f = (global.JVFit && global.JVFit.fitDevice) ? global.JVFit.fitDevice(d, { rsCorrect: want, temperatureK: wantT }) : null;
        d._n = f && isNum(f.n) ? f.n : NaN;
        d._j0 = f && isNum(f.J0) && f.J0 > 0 ? Math.log10(f.J0) : NaN;
      });
    });
  }

  /* ================================================================
   * 4 张参数分布图（t4-2 复用主图 buildBoxplotOption）
   * ================================================================ */
  var CHART_KEYS = ['rs', 'rsh', 'n', 'j0'];
  var CHART_TITLES = {
    rs: { zh: 'Rs 分布', en: 'Rs distribution' },
    rsh: { zh: 'Rsh 分布（log）', en: 'Rsh distribution (log)' },
    n: { zh: '理想因子 n 分布', en: 'Ideality factor n distribution' },
    j0: { zh: 'log₁₀(J₀) 分布', en: 'log₁₀(J₀) distribution' }
  };
  /** i18n：PDF 4 图标题按当前语言取（zh 态中文 / EN 态英文） */
  function chartTitle(k) {
    var et = CHART_TITLES[k];
    if (!et) return k;
    return (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? (et.en || et.zh) : (et.zh || et.en);
  }

  function renderChart(dom, key, conditions) {
    if (!dom || !global.echarts) return;
    dom.innerHTML = '';
    var chart = global.echarts.init(dom, null, { renderer: 'svg' });
    chart.setOption(C.buildBoxplotOption(key, conditions, {
      axisTitlePos: 'left',
      logY: key === 'rsh', // t4-2：Rsh 跨数量级 → log 坐标
      styleNs: equivMergedStyle() // t5：4 图独立格式（覆盖主图 single 的字号/线宽/透明度）
    }));
    instances.push(chart);
  }

  function renderCharts(conditions) {
    prepareDevices(conditions);
    CHART_KEYS.forEach(function (k) {
      renderChart($('equiv-chart-' + k), k, conditions);
    });
    // 无 J₀ 拟合数据的条件提示（图上类目不消失，文字标注 N/A）
    var j0Na = [];
    conditions.forEach(function (c) {
      var has = false;
      (c.devices || []).forEach(function (d) { if (isNum(d._j0)) has = true; });
      if (!has) j0Na.push(c.displayName || c.name);
    });
    var hint = $('equiv-j0-na');
    if (hint) {
      var j0En = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：无 J₀ 拟合提示
      hint.textContent = j0Na.length ? ((j0En ? 'No J₀ fit data (N/A): ' : '无 J₀ 拟合数据（N/A）：') + j0Na.join(j0En ? ', ' : '、')) : '';
    }
  }

  /** Base 条件下拉（默认第一个条件） */
  function renderBaseSelect(conditions) {
    var sel = $('equiv-base');
    if (!sel) return;
    sel.innerHTML = '';
    conditions.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.displayName || c.name;
      o.textContent = c.displayName || c.name;
      sel.appendChild(o);
    });
    sel.selectedIndex = 0;
  }

  /** t7：迟滞差阈值（面板 slider 可调，持久化）——t10（P1-3）：拆分为 Δn 主阈值与 Δlog₁₀J₀ 辅助阈值 */
  function hystDelta() {
    try {
      var v = parseFloat(localStorage.getItem('jv-equiv-hyst-delta'));
      if (isFinite(v) && v > 0) return Math.round(v * 100) / 100;
    } catch (e) { /* 无 localStorage 则用默认 */ }
    return 0.5;
  }
  function nDelta() {
    try {
      var v = parseFloat(localStorage.getItem('jv-equiv-n-delta'));
      if (isFinite(v) && v > 0) return Math.round(v * 100) / 100;
    } catch (e) { /* 忽略 */ }
    return hystDelta(); // 兼容旧键（t7 的 jv-equiv-hyst-delta）
  }
  function setNDelta(v) {
    try { localStorage.setItem('jv-equiv-n-delta', String(v)); } catch (e) { /* 忽略 */ }
  }
  function j0logDelta() {
    try {
      var v = parseFloat(localStorage.getItem('jv-equiv-j0log-delta'));
      if (isFinite(v) && v > 0) return Math.round(v * 100) / 100;
    } catch (e) { /* 忽略 */ }
    return 1.0; // t10：Δlog₁₀J₀ 辅助阈值默认 1.0（=J₀ 差 10 倍）
  }
  function setJ0logDelta(v) {
    try { localStorage.setItem('jv-equiv-j0log-delta', String(v)); } catch (e) { /* 忽略 */ }
  }

  /** t8：Rs 修正开关（默认关——实测本批数据对数线性窗口内未修正 r² 最优） */
  function rsCorrect() {
    try { return localStorage.getItem('jv-equiv-rs-correct') === '1'; } catch (e) { return false; }
  }
  function setRsCorrect(v) {
    try { localStorage.setItem('jv-equiv-rs-correct', v ? '1' : '0'); } catch (e) { /* 忽略 */ }
  }

  /** t9（P2-3）：测试温度（K，默认 300），影响 n 提取（kT/q 随温度） */
  function tempK() {
    try {
      var v = parseFloat(localStorage.getItem('jv-equiv-temp-k'));
      if (isFinite(v) && v >= 200 && v <= 400) return v;
    } catch (e) { /* 默认 */ }
    return 300;
  }
  function setTempK(v) {
    try { localStorage.setItem('jv-equiv-temp-k', String(v)); } catch (e) { /* 忽略 */ }
  }

  /** t7：双方向子信息（n/J₀ 主值=正反扫平均；显示方向差与迟滞差，迟滞大加 ⚠）
   *  t8-2：附正扫/反扫各自的仪器 Rs，供配对解读（正扫 n 高时可对照正扫 Rs 判断是否 Rs 相关） */
  function dirSubInfo(st) {
    var hasRev = isNum(st.nRevMed) || isNum(st.j0RevMed);
    var hasFwd = isNum(st.nFwdMed) || isNum(st.j0FwdMed);
    if (!hasRev && !hasFwd) return '';
    var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：双方向行
    var parts = [];
    if (isNum(st.nRevMed) && isNum(st.nFwdMed)) {
      parts.push(isEn ? ('fwd n≈' + st.nFwdMed.toFixed(2) + ' / rev n≈' + st.nRevMed.toFixed(2)) : ('正扫 n≈' + st.nFwdMed.toFixed(2) + ' / 反扫 n≈' + st.nRevMed.toFixed(2)));
    }
    if (isNum(st.fwdRsMed) && isNum(st.revRsMed)) {
      parts.push(isEn ? ('fwd Rs≈' + st.fwdRsMed.toFixed(1) + ' / rev Rs≈' + st.revRsMed.toFixed(1)) : ('正扫 Rs≈' + st.fwdRsMed.toFixed(1) + ' / 反扫 Rs≈' + st.revRsMed.toFixed(1)));
    }
    if (isNum(st.nDMed)) parts.push('Δn=' + st.nDMed.toFixed(2));
    if (isNum(st.j0DMed)) parts.push('Δlog₁₀J₀=' + st.j0DMed.toFixed(2));
    // t9（P1-3）：有符号方向差 + 系统性方向统计（δn>0 = 正扫更高）
    if (isNum(st.dNSMed) && st.fwdHigherNTotal > 0) {
      var sysTxt = st.fwdHigherN === st.fwdHigherNTotal ? (isEn ? 'systematically forward-biased' : '系统性正扫偏高') : (st.fwdHigherN === 0 ? (isEn ? 'systematically reverse-biased' : '系统性反扫偏高') : (isEn ? 'direction inconsistent' : '方向不一致'));
      parts.push(isEn ? ('δn=' + (st.dNSMed > 0 ? '+' : '') + st.dNSMed.toFixed(2) + ' (forward higher ' + st.fwdHigherN + '/' + st.fwdHigherNTotal + ', ' + sysTxt + ')') : ('δn=' + (st.dNSMed > 0 ? '+' : '') + st.dNSMed.toFixed(2) + '（正扫更高 ' + st.fwdHigherN + '/' + st.fwdHigherNTotal + '，' + sysTxt + '）'));
    }
    if (!parts.length) return '';
    var nd = nDelta(); // t10（P1-3）：Δn 主阈值
    var big = (isNum(st.nDMed) && st.nDMed > nd);
    return (big ? '⚠ ' : '') + (isEn ? 'Two-direction: ' : '双方向：') + parts.join(' · ') + (big ? (isEn ? ' (Δn > threshold ' + nd + ', read cautiously)' : '（Δn > 阈值 ' + nd + '，谨慎解读）') : '');
  }

  /** 逐条件诊断卡（相对当前 Base；Base 变更后重渲染，图不重建） */
  function renderCards(conditions) {
    var sel = $('equiv-base');
    var baseName = sel && sel.value ? sel.value : (conditions.length ? (conditions[0].displayName || conditions[0].name) : '');
    var baseCond = null, baseStats = null;
    conditions.forEach(function (c) {
      if ((c.displayName || c.name) === baseName) { baseCond = c; return; }
    });
    if (baseCond) baseStats = statsFor(baseCond);

    var wrap = $('equiv-cards');
    if (!wrap) return;
    wrap.innerHTML = '';
    conditions.forEach(function (cond) {
      var nm = cond.displayName || cond.name;
      var st = statsFor(cond);
      var an = A.analyze(st, baseStats, { N_DELTA: nDelta(), J0LOG_DELTA: j0logDelta() });
      var isBase = nm === baseName;
      var cardEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：诊断卡文案
      var html = '';
      html += '<div class="equiv-card">';
      html += '<div class="equiv-card-head">';
      html += '<span class="equiv-card-name">' + esc(nm) + '</span>';
      if (isBase) html += '<span class="equiv-badge">BASE</span>';
      var sumVal = an.summary;
      if (sumVal && typeof sumVal === 'object') sumVal = cardEn ? (sumVal.en || sumVal.zh) : (sumVal.zh || sumVal.en); // i18n：summary 双语取用（修复 R5-1：中文态对象漏解包致 [object Object]）
      html += '<span class="equiv-card-summary">' + esc(sumVal || '') + '</span>';
      html += '</div>';
      // 参数迷你表（器件数 + Rs/Rsh/n/J₀ 中位数）——t9：n/J₀ 定位为汇总值/表观外推值（P1-1/P1-2）
      html += '<table class="equiv-param-mini"><tr>';
      html += '<td class="equiv-param-k">' + (cardEn ? 'n summary' : 'n 汇总') + '</td><td>' + (isNum(st.nMed) ? st.nMed.toFixed(2) : '—') + '</td>';
      html += '<td class="equiv-param-k">' + (cardEn ? 'Apparent J₀' : '表观 J₀') + '</td><td>' + (isNum(st.j0Med) ? A.fmt(st.j0Med) : '—') + '</td>';
      html += '<td class="equiv-param-k">Rs (Ω)</td><td>' + A.fmtRs(st.rsMed) + '</td>';
      html += '<td class="equiv-param-k">Rsh (Ω)</td><td>' + A.fmtRsh(st.rshMed) + '</td>';
      html += '<td class="equiv-param-k">' + (cardEn ? 'Devices' : '器件') + '</td><td>' + st.count + '</td>';
      html += '</tr></table>';
      // t9（P1-4）：拟合质量指标行（N=线性区点数、ΔV=电压跨度、r²=拟合线性）
      if (isNum(st.nNMed) && isNum(st.nDVMed)) {
        html += '<div class="equiv-dirinfo">' + (cardEn ? 'Fit quality: N=' + st.nNMed + ' pts · ΔV=' + st.nDVMed.toFixed(2) + ' V · r²=' + (isNum(st.r2MedExtra) ? st.r2MedExtra.toFixed(4) : '—') + ' · slope-SE median=' + (isNum(st.nSEMed) ? st.nSEMed.toExponential(1) : '—') : '拟合质量：N=' + st.nNMed + ' 点 · ΔV=' + st.nDVMed.toFixed(2) + ' V · r²=' + (isNum(st.r2MedExtra) ? st.r2MedExtra.toFixed(4) : '—') + ' · 斜率标准误中位=' + (isNum(st.nSEMed) ? st.nSEMed.toExponential(1) : '—')) + '</div>';
      }
      // t10（P1-2）：拟合覆盖率——成功拟合数/总数、A/B/C 质量分级占比、J₀ 可信数、窗口敏感数
      if (st.fitTotal > 0) {
        var gc = st.gradeCounts || { A: 0, B: 0, C: 0 };
        html += '<div class="equiv-dirinfo">' + (cardEn ? 'Fit coverage: ' + st.fitOk + '/' + st.fitTotal + ' devices · grades A/B/C=' + gc.A + '/' + gc.B + '/' + gc.C + ' · J₀ reliable (A)=' + st.j0Confident + (st.windowSensitiveCount ? ' · window-sensitive=' + st.windowSensitiveCount : '') : '拟合覆盖：' + st.fitOk + '/' + st.fitTotal + ' 台 · 质量 A/B/C=' + gc.A + '/' + gc.B + '/' + gc.C + ' · J₀ 可信(A级)=' + st.j0Confident + (st.windowSensitiveCount ? ' · 窗口敏感=' + st.windowSensitiveCount : '')) + '</div>';
      }
      // 冒烟发现：叠层/高 Voc 数据拟合可能全部失败且无提示——补明确提示
      if (st.fitTotal > 0 && st.fitOk === 0) {
        html += '<div class="equiv-dirinfo equiv-dirinfo-warn">' + (cardEn ? '⚠ All fits failed for this condition (n out of physical protection or no valid points in the window) — common for tandem / high-Voc data where the log-linear region exceeds the single-junction window; n/J₀ not applicable; Rs/Rsh and hysteresis difference are unaffected.' : '⚠ 该条件全部器件拟合失败（n 超出物理保护或窗口无有效点）——常见于叠层/高 Voc 数据，对数线性区超出单结适用窗口，n/J₀ 不适用；Rs/Rsh 与迟滞差不受影响。') + '</div>';
      }
      // t7：双方向子信息行（n/J₀ 汇总=正反扫平均；给出方向差与迟滞差）
      var dirInfo = dirSubInfo(st);
      if (dirInfo) html += '<div class="equiv-dirinfo' + (dirInfo.indexOf('⚠') === 0 ? ' equiv-dirinfo-warn' : '') + '">' + dirInfo + '</div>';
      // 判定行（level 着色）
      if (an.verdicts && an.verdicts.length) {
        html += '<ul class="equiv-verdicts">';
        var isEn2 = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：诊断卡文案按语言取
        an.verdicts.forEach(function (v) {
          var icon = v.level === 'ok' ? '✓' : (v.level === 'warn' ? '⚠' : 'ℹ');
          var txt = isEn2 ? (v.textEn || v.text) : v.text;
          html += '<li class="equiv-v-' + v.level + '">' + icon + ' ' + esc(txt) + '</li>';
        });
        html += '</ul>';
      }
      // 建议
      if (an.advice && an.advice.length) {
        html += '<ul class="equiv-advice">';
        an.advice.forEach(function (a) { if (a && typeof a === 'object') a = cardEn ? (a.en || a.zh) : (a.zh || a.en); html += '<li>' + esc(a) + '</li>'; }); // i18n：advice 双语（修复 R5-2：同 L273，中文态漏解包致 [object Object]）
        html += '</ul>';
      }
      html += '</div>';
      wrap.innerHTML += html;
    });
  }

  /* ================================================================
   * 供 PDF 导出复用（t4-2 与主图同源）：
   *   ① pdfRenderers：4 参数的离屏渲染器（main.js exportPdf 转 SVG URL）
   *   ② buildSummaryTable：参数与诊断摘要表 DOM（PDF「分析页」）
   * ================================================================ */

  /** 单条件「主要判定」缩写（PDF 摘要表）：无 warn → ✓健康；否则 ⚠+标签 */
  function mainVerdict(cond, baseStats) {
    var nd = nDelta();
    var an = A.analyze(statsFor(cond), baseStats || null, { N_DELTA: nd, J0LOG_DELTA: j0logDelta() });
    var mvEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：PDF 摘要表「主要判定」缩写
    var warns = an.verdicts.filter(function (v) { return v.level === 'warn'; }).map(function (v) { return v.key; });
    if (!warns.length) return mvEn ? '✓ Healthy' : '✓ 健康';
    var label = [];
    if (warns.indexOf('rsh') >= 0) label.push(mvEn ? 'leakage' : '漏电');
    if (warns.indexOf('rs') >= 0) label.push(mvEn ? 'series-R' : '串联');
    if (warns.indexOf('n') >= 0) label.push(mvEn ? 'n high' : 'n 偏高');
    if (warns.indexOf('j0') >= 0) label.push(mvEn ? 'J₀ high' : 'J₀ 高');
    if (warns.indexOf('hyst') >= 0) label.push(mvEn ? 'hysteresis' : '迟滞');
    return '⚠ ' + (label.join('/') || (mvEn ? 'abnormal' : '异常'));
  }

  /** 参数与诊断摘要表（PDF 分析页用）：每条件一行 */
  function buildSummaryTable(conditions) {
    if (!conditions || !conditions.length) return null;
    var cardEnT = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：PDF 摘要表头（引用修复：此前误用 renderCards 局部 cardEn）
    var baseCond = conditions[0];
    if (global.JVMain && global.JVMain.getPref) {
      conditions.forEach(function (c) { if (global.JVMain.getPref(c).first) baseCond = c; });
    }
    var baseStats = statsFor(baseCond);
    var table = document.createElement('table');
    table.className = 'eq-pdf-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
      (cardEnT ? '<th class="eq-c">Condition</th><th class="eq-n">n summary</th><th class="eq-n">log₁₀(apparent J₀)</th>' : '<th class="eq-c">条件</th><th class="eq-n">n 汇总</th><th class="eq-n">log₁₀(表观 J₀)</th>') +
      (cardEnT ? '<th class="eq-n">Rs (Ω)</th><th class="eq-n">Rsh (Ω)</th><th class="eq-n">Devices</th>' : '<th class="eq-n">Rs (Ω)</th><th class="eq-n">Rsh (Ω)</th><th class="eq-n">器件数</th>') +
      (cardEnT ? '<th class="eq-v">Main verdict</th>' : '<th class="eq-v">主要判定</th>') + '</tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    conditions.forEach(function (c) {
      var st = statsFor(c);
      var nm = c.displayName || c.name;
      var isBase = (c.displayName || c.name) === (baseCond.displayName || baseCond.name);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="eq-c">' + esc(nm) + (isBase ? ' <span class="eq-pdf-base">BASE</span>' : '') + '</td>' +
        '<td class="eq-n">' + (isNum(st.nMed) ? st.nMed.toFixed(2) : '—') + '</td>' +
        '<td class="eq-n">' + (isNum(st.j0Med) && st.j0Med > 0 ? Math.log10(st.j0Med).toFixed(2) : '—') + '</td>' +
        '<td class="eq-n">' + A.fmtRs(st.rsMed) + '</td>' +
        '<td class="eq-n">' + A.fmtRsh(st.rshMed) + '</td>' +
        '<td class="eq-n">' + st.count + '</td>' +
        '<td class="eq-v">' + esc(mainVerdict(c, baseStats)) + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /** 4 参数的离屏渲染器列表（PDF 用；与模态同源 buildBoxplotOption） */
  function pdfRenderers(conditions) {
    prepareDevices(conditions);
    return CHART_KEYS.map(function (k) {
      return {
        kind: k,
        title: chartTitle(k),
        render: function (dom, ex) {
          if (!global.echarts) return null;
          var chart = global.echarts.init(dom, null, { renderer: 'svg' });
          chart.setOption(C.buildBoxplotOption(k, conditions, Object.assign({
            axisTitlePos: 'left',
            logY: k === 'rsh',
            styleNs: equivMergedStyle() // t5：PDF 等效图与模态 4 图同格式
          }, ex || {})));
          return chart;
        }
      };
    });
  }

  /* ================================================================
   * 打开 / 关闭 / 释放
   * ================================================================ */

  /** 打开模态（无数据/无勾选则提示并返回；仅分析已勾选条件） */
  function open() {
    var data = global.JVMain && global.JVMain.currentData ? global.JVMain.currentData() : null;
    if (!data || !data.conditions || !data.conditions.length) {
      if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast('请先加载数据（含 Rs/Rsh 列）');
      return;
    }
    var checked;
    if (global.JVMain && global.JVMain.checkedConditions) checked = global.JVMain.checkedConditions(data);
    else checked = data.conditions;
    if (!checked || !checked.length) {
      if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast('请先勾选至少一个条件');
      return;
    }
    var modal = $('equiv-modal');
    if (!modal) return;
    dispose();
    lastConditions = checked;
    modal.hidden = false;
    var panel = $('equiv-format-panel');
    if (panel) panel.style.display = 'none'; // 每次打开收起格式面板
    renderBaseSelect(checked);
    renderCharts(checked);
    renderCards(checked);
    // t8：Rs 修正状态标注 + 无有效拟合提示；t9：模块名收敛（表观参数与迟滞诊断）
    var titleEl = modal.querySelector('.modal-title');
    if (titleEl) {
      var tEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      var rcSuffix = rsCorrect() ? (tEn ? ' · Rs corrected' : ' · Rs 修正') : '';
      titleEl.textContent = tEn ? ('⚡ Apparent Parameters & Hysteresis (screening' + rcSuffix + ')') : ('⚡ 表观参数与迟滞诊断（工程筛选' + rcSuffix + '）');
    }
    if (rsCorrect()) {
      var anyFit = false;
      checked.forEach(function (c) {
        var st = statsFor(c);
        if (isNum(st.nMed) || isNum(st.j0Med)) anyFit = true;
      });
      if (!anyFit && global.JVTable && global.JVTable.showToast) {
        global.JVTable.showToast('Rs 修正后本批数据无有效拟合（修正量过大）——建议关闭 Rs 修正');
      }
    }
    // t10（P2-3）：跨条件扫描协议一致性警示（Step/Delay 不一致 → 迟滞指标不可直接横比）
    // 问题5：警示对称撤销——协议恢复一致时移除红条（否则切换条件后红条残留）
    // i-2 附带：title 写入条件放开为「有 protoWarn 必写」——原守卫（无→有才写）在切语言后重开时
    // className 残留 equiv-proto-warn 导致新语言 title 滞留旧语言
    var protoWarn = protocolMismatch(checked);
    var hint = $('equiv-fmt-hint');
    if (hint) {
      if (protoWarn) {
        if (hint.className.indexOf('equiv-proto-warn') < 0) hint.className += ' equiv-proto-warn';
        hint.title = protoWarn;
      } else if (hint.className.indexOf('equiv-proto-warn') >= 0) {
        hint.className = hint.className.replace(' equiv-proto-warn', '');
        hint.removeAttribute('title');
      }
    }
  }

  /** t10（P2-2/2-3）：检查已选条件的测量协议（Step/Delay）是否一致；不一致返回警示文案 */
  function protocolMismatch(conditions) {
    var rows = [];
    conditions.forEach(function (c) {
      var st = statsFor(c);
      if (isNum(st.stepVMed) || isNum(st.delayMsMed)) {
        rows.push({ nm: c.displayName || c.name, stepV: st.stepVMed, delayMs: st.delayMsMed, tempC: st.tempDegCMed, light: st.lightSunMed });
      }
    });
    if (!rows.length) return '';
    var s0 = rows[0];
    var bad = rows.filter(function (x) {
      return (isNum(x.stepV) && isNum(s0.stepV) && Math.abs(x.stepV - s0.stepV) > 1e-9) ||
             (isNum(x.delayMs) && isNum(s0.delayMs) && x.delayMs !== s0.delayMs);
    });
    if (!bad.length) return '';
    var en = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i-2：协议警告双语（title 由调用点直接消费，无需改动）
    var list = bad.map(function (x) {
      return en
        ? (x.nm + ' (step ' + (isNum(x.stepV) ? x.stepV : '—') + ' V' + (isNum(x.delayMs) ? ' / ' + x.delayMs + ' ms' : '') + ')')
        : (x.nm + '(步长 ' + (isNum(x.stepV) ? x.stepV : '—') + ' V' + (isNum(x.delayMs) ? ' / ' + x.delayMs + ' ms' : '') + ')');
    }).join(en ? '; ' : '、');
    return en
      ? ('⚠ Cross-condition scan-protocol mismatch: ' + list + ' differs from "' + s0.nm + '" (step ' + s0.stepV + ' V / ' + s0.delayMs + ' ms) — hysteresis metrics are not directly comparable across protocols; interpret per condition only.')
      : ('⚠ 跨条件扫描协议不一致：' + list + ' 与「' + s0.nm + '」（步长 ' + s0.stepV + ' V / ' + s0.delayMs + ' ms）不同——迟滞指标跨协议不可直接比较，仅作各自条件内参考。');
  }

  /* ================================================================
   * t5：4 图独立「格式」面板（equivStyle 持久化；改动只重渲染 4 图，不动诊断卡/主图）
   * ================================================================ */
  function buildFormatPanel() {
    var panel = $('equiv-format-panel');
    if (!panel) return;
    if (panel.childNodes.length) return; // 构建一次（恢复默认时重建）
    var fmtEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：格式面板
    function addRange(label, key, min, max, step) {
      var row = document.createElement('label');
      row.className = 'equiv-fmt-row';
      var span = document.createElement('span');
      span.className = 'equiv-fmt-label';
      span.textContent = label;
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(equivStyle[key]);
      input.setAttribute('data-key', key);
      row.appendChild(span);
      row.appendChild(input);
      var val = document.createElement('span');
      val.className = 'equiv-fmt-val';
      val.textContent = String(equivStyle[key]);
      row.appendChild(val);
      input.addEventListener('input', function () {
        equivStyle[key] = step < 1 ? Math.round(parseFloat(input.value) * 100) / 100 : parseInt(input.value, 10);
        val.textContent = String(equivStyle[key]);
        saveStyle();
        applyStyle();
      });
      panel.appendChild(row);
    }
    addRange(fmtEn ? 'X tick size' : 'X 刻度字号', 'xTickFontSize', 8, 20, 1); // t6：横纵分开
    addRange(fmtEn ? 'Y tick size' : 'Y 刻度字号', 'yTickFontSize', 8, 20, 1);
    addRange(fmtEn ? 'Title size' : '标题字号', 'titleFontSize', 8, 22, 1);
    addRange(fmtEn ? 'Axis width' : '轴线宽', 'axisLineWidth', 0.5, 3, 0.25);
    addRange(fmtEn ? 'Box width' : '箱体宽度', 'boxWidthMin', 30, 90, 1);
    addRange(fmtEn ? 'Box alpha' : '箱体透明度', 'boxFillAlpha', 0.05, 1, 0.05);
    addRange(fmtEn ? 'Box border width' : '箱体描边粗细', 'boxBorderWidth', 0.5, 5, 0.25);
    addRange(fmtEn ? 'X label gap' : 'X 标签间距', 'xLabelGap', 0, 20, 1);
    addRange(fmtEn ? 'Y label gap' : 'Y 标签间距', 'yLabelGap', 0, 20, 1);
    addRange(fmtEn ? 'X label rotate' : 'X 标签旋转', 'xLabelRotate', 0, 60, 1);
    addRange(fmtEn ? 'X label offset' : 'X 标签偏移', 'xLabelOffset', -40, 40, 1); // t6：横向微调
    // t7：诊断阈值（非图样式——影响迟滞警示判定；改动后重渲染诊断卡）
    var sep = document.createElement('div');
    sep.className = 'equiv-fmt-sep';
    sep.textContent = fmtEn ? 'Diagnostic thresholds' : '诊断阈值';
    panel.appendChild(sep);
    // t8：Rs 修正开关（影响 n/J₀ 拟合口径 → 图与诊断卡都要重渲染）
    var rsRow = document.createElement('label');
    rsRow.className = 'equiv-fmt-row';
    var rsSpan = document.createElement('span');
    rsSpan.className = 'equiv-fmt-label';
    rsSpan.textContent = fmtEn ? 'Rs correction' : 'Rs 修正';
    rsSpan.title = fmtEn
      ? 'Re-fits on a corrected voltage axis V_int = V − J·Rs (Rs is area-normalized Ω·cm² = raw value × area). The log-linear window already avoids the Rs-dominated region near Jsc; on typical data uncorrected fits are already near-optimal, so it is off by default — try it only for batches with large Rs or windows forced near Jsc, and re-check linearity (r²) and physical plausibility.'
      : '拟合时用 V_int = V − J·Rs（Rs 为面积归一化 Ω·cm²，= 仪器值 × 面积）重做电压轴。对数线性窗口已避开近 Jsc 的 Rs 重干扰区段，对常见数据未修正时拟合线性已优，故默认关；仅当 Rs 较大或窗口贴近 Jsc 的批次可尝试开启，并以 r² 与物理合理性复核。';
    var rsCb = document.createElement('input');
    rsCb.type = 'checkbox';
    rsCb.checked = rsCorrect();
    rsRow.appendChild(rsSpan);
    rsRow.appendChild(rsCb);
    var rsHint = document.createElement('span');
    rsHint.className = 'equiv-fmt-val';
    rsHint.textContent = rsCorrect() ? (fmtEn ? 'On' : '开') : (fmtEn ? 'Off' : '关');
    rsRow.appendChild(rsHint);
    rsCb.addEventListener('change', function () {
      setRsCorrect(rsCb.checked);
      rsHint.textContent = rsCb.checked ? (fmtEn ? 'On' : '开') : (fmtEn ? 'Off' : '关');
      // t8：开关影响 n/J₀ 拟合 → 图（缓存重建）与诊断卡全部重渲染
      prepareDevices(lastConditions);
      dispose();
      renderCharts(lastConditions);
      renderCards(lastConditions);
    });
    panel.appendChild(rsRow);
    // t9（P2-3）：测试温度（K）——影响 n 提取（kT/q 随温度，默认 300K）
    var tmpRow = document.createElement('label');
    tmpRow.className = 'equiv-fmt-row';
    var tmpSpan = document.createElement('span');
    tmpSpan.className = 'equiv-fmt-label';
    tmpSpan.textContent = fmtEn ? 'Test temperature (K)' : '测试温度 (K)';
    tmpSpan.title = fmtEn
      ? 'n extraction depends on the thermal voltage kT/q; default 300 K (~27°C) — adjust to the actual measurement temperature. Charts and diagnostic cards recompute on change.'
      : 'n 提取依赖热电压 kT/q；默认 300 K（约 27°C），按实际测试温度调整。改动后图与诊断卡重新计算。';
    var tmpInput = document.createElement('input');
    tmpInput.type = 'number';
    tmpInput.min = '200'; tmpInput.max = '400'; tmpInput.step = '1';
    tmpInput.value = String(tempK());
    tmpRow.appendChild(tmpSpan);
    tmpRow.appendChild(tmpInput);
    tmpInput.addEventListener('change', function () {
      var v = parseFloat(tmpInput.value);
      if (!isFinite(v) || v < 200 || v > 400) { tmpInput.value = String(tempK()); return; }
      setTempK(v);
      prepareDevices(lastConditions);
      dispose();
      renderCharts(lastConditions);
      renderCards(lastConditions);
    });
    panel.appendChild(tmpRow);
    // t10（P1-3）：迟滞阈值拆双滑块——Δn 主警报阈值 + Δlog₁₀J₀ 辅助阈值（尺度不同，不可共用）
    function addDeltaSlider(label, title, getter, setter, min, max, step, defVal) {
      var row = document.createElement('label');
      row.className = 'equiv-fmt-row';
      var span = document.createElement('span');
      span.className = 'equiv-fmt-label';
      span.textContent = label;
      span.title = title;
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(getter());
      row.appendChild(span);
      row.appendChild(input);
      var val = document.createElement('span');
      val.className = 'equiv-fmt-val';
      val.textContent = String(getter());
      row.appendChild(val);
      input.addEventListener('input', function () {
        var v = Math.round(parseFloat(input.value) * 100) / 100;
        setter(v);
        val.textContent = String(v);
        renderCards(lastConditions); // 阈值变更 → 只重渲染诊断卡（图不变）
      });
      panel.appendChild(row);
      return row;
    }
    // fmtEn 定义见 buildFormatPanel 开头（i18n：格式面板）
    addDeltaSlider(fmtEn ? 'Hysteresis threshold Δn' : '迟滞阈值 Δn',
      fmtEn ? 'If the median fwd/rev n difference exceeds this → main hysteresis warning (⚠). Larger thresholds reduce false alarms but may miss real ones; smaller are more sensitive but prone to false alarms. Δn and Δlog₁₀J₀ have different scales, so they are split into two thresholds.'
           : '正/反扫 n 差中位超过此值 → 迟滞主警报（⚠）。阈值越大误报越少但可能漏报；越小越敏感但易误报。Δn 与 Δlog₁₀J₀ 尺度不同，已拆为两个阈值。',
      nDelta, setNDelta, 0.1, 1, 0.05, 0.5);
    addDeltaSlider(fmtEn ? 'Hysteresis threshold Δlog₁₀J₀' : '迟滞阈值 Δlog₁₀J₀',
      fmtEn ? 'If the median log₁₀J₀ difference exceeds this → supporting hysteresis evidence (ℹ, never triggers the main warning alone). Default 1.0 = 10× J₀ difference; J₀ is an extrapolated apparent parameter, weighted below Δn.'
           : 'log₁₀J₀ 差中位超过此值 → 作为迟滞支持证据（ℹ，不单独触发主警报）。默认 1.0 = J₀ 相差 10 倍；J₀ 为外推型表观参数，权重低于 Δn。',
      j0logDelta, setJ0logDelta, 0.2, 2, 0.1, 1.0);
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-sm';
    reset.textContent = fmtEn ? '↺ Reset Defaults' : '↺ 恢复默认';
    reset.addEventListener('click', function () {
      equivStyle = Object.assign({}, DEF_STYLE);
      saveStyle();
      panel.innerHTML = '';
      buildFormatPanel();
      applyStyle();
    });
    panel.appendChild(reset);
  }

  function toggleFormat() {
    var panel = $('equiv-format-panel');
    if (!panel) return;
    buildFormatPanel();
    var closed = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = closed ? 'block' : 'none';
    var btn = $('equiv-format');
    if (btn) btn.classList.toggle('active', closed);
  }

  /** t5：格式变更 → 释放 4 图 → 重渲（诊断卡不重建；主图 chartStyle 不受影响） */
  function applyStyle() {
    if (!lastConditions || !lastConditions.length) return;
    var modal = $('equiv-modal');
    if (modal && modal.hidden) return;
    dispose();
    renderCharts(lastConditions);
  }

  function close() {
    var modal = $('equiv-modal');
    if (modal) modal.hidden = true;
    dispose();
  }

  /** 释放全部图表实例（ECharts dispose，避免内存/事件泄漏） */
  function dispose() {
    instances.forEach(function (c) {
      try { c.dispose(); } catch (e) { /* 已释放则忽略 */ }
    });
    instances = [];
  }

  /* ================================================================
   * 「分析说明」模态（t4-3；equiv 与 corr 共用）
   * ================================================================ */
  function openHelp(kind) {
    var modal = $('help-modal');
    if (!modal || !global.JVHelpContent) return;
    var c = global.JVHelpContent;
    var titleEl = $('help-title');
    var lang = (typeof I18N !== 'undefined' && I18N.getLang()) || 'zh'; // i18n：帮助文档按当前语言取
    if (titleEl) {
      var t = (c.titles && c.titles[kind]) || '分析说明';
      if (t && typeof t === 'object') t = t[lang] || t.zh || t.en;
      titleEl.textContent = t;
    }
    var body = $('help-body');
    // i18n：英文态取 {kind}_en（核心段英译），否则取中文全档
    var content = lang === 'en' ? (c[kind + '_en'] || c[kind]) : c[kind];
    if (body && content) body.innerHTML = content;
    modal.hidden = false;
  }

  function closeHelp() {
    var modal = $('help-modal');
    if (modal) modal.hidden = true;
  }

  function addFigExportBtns() {
    var figs = document.querySelectorAll('.equiv-fig');
    if (!figs || !figs.length) return;
    figs.forEach(function (fig) {
      var title = fig.querySelector('.equiv-fig-title');
      if (!title || title.querySelector('.equiv-fig-btn')) return;
      var btns = document.createElement('span');
      btns.className = 'equiv-fig-btn';
      function mk(label, isSvg) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = label;
        b.addEventListener('click', function () {
          var dom = fig.querySelector('.equiv-chart');
          if (!dom) return;
          var chart = echarts.getInstanceByDom(dom);
          if (!chart) return;
          try {
            if (isSvg) C.downloadChartSVG(chart, 'equiv');
            else C.copyChartPNG(chart, 'equiv');
          } catch (e) { /* 导出失败静默 */ }
        });
        return b;
      }
      btns.appendChild(mk((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Copy Image' : '复制图片', false));
      btns.appendChild(mk((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Download SVG' : '下载矢量图', true));
      title.appendChild(btns);
    });
  }

  function bind() {
    if (typeof document === 'undefined') return;
    addFigExportBtns(); // t6：4 图各带复制/下载矢量图
    var btn = $('btn-equiv-analysis');
    if (btn) btn.addEventListener('click', open);
    var modal = $('equiv-modal');
    if (modal) {
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n:changed', function () {
        var m = $('equiv-modal');
        if (m && !m.hidden) open(); // N6：弹窗开着切语言即时重渲染（open 首行 dispose，幂等无实例泄漏）
      });
    }
    var closeBtn = $('equiv-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    // t5：4 图独立格式面板
    var fmtBtn = $('equiv-format');
    if (fmtBtn) fmtBtn.addEventListener('click', toggleFormat);
    // 说明按钮（equiv + corr 共用 help 模态）
    var he = $('help-equiv');
    if (he) he.addEventListener('click', function () { openHelp('equiv'); });
    var hc = $('help-corr');
    if (hc) hc.addEventListener('click', function () { openHelp('corr'); });
    var helpModal = $('help-modal');
    if (helpModal) {
      helpModal.addEventListener('click', function (e) { if (e.target === helpModal) closeHelp(); });
    }
    var helpClose = $('help-close');
    if (helpClose) helpClose.addEventListener('click', closeHelp);
    // Base 变更 → 重渲染诊断卡（图与 Base 无关，不重建）
    var sel = $('equiv-base');
    if (sel) sel.addEventListener('change', function () {
      renderCards(lastConditions);
    });
    // Esc：优先关 help，再 equiv（lightbox 打开时让位）
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var lb = $('chart-lightbox');
      if (lb && !lb.hidden) return;
      var helpM = $('help-modal');
      if (helpM && !helpM.hidden) { closeHelp(); return; }
      if (modal && !modal.hidden) close();
    });
  }

  if (typeof document !== 'undefined') {
    loadStyle();
    // 脚本位于 </body> 前，DOM 已就绪
    bind();
  }

  global.JVEquiv = {
    open: open,
    close: close,
    dispose: dispose,
    renderCards: renderCards,
    applyStyle: applyStyle,
    openHelp: openHelp,
    closeHelp: closeHelp,
    pdfRenderers: pdfRenderers,
    buildSummaryTable: buildSummaryTable
  };
})(typeof window !== 'undefined' ? window : globalThis);
