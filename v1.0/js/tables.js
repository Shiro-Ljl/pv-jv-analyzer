/**
 * tables.js —— 三类表格渲染（实施规格书第 9 章）
 *
 *   renderSummaryTable(cond, themeColor)   → S2 左侧汇总表（Max / Average 两行，9.1）
 *   renderDetailTable(cond, themeColor, onEditEff) → S3 详情表（9.2，最高行高亮，Efficiency 可编辑）
 *   copyTableAsTSV(tableEl)                → 制表符分隔文本写入剪贴板（粘贴进 Excel）
 *   shade(hex, ratio)                      → 主题色加深/减淡工具
 *
 * 所有展示数值一律走 parser.roundSigText（4 位有效数字）；
 * 平均与最高判定用未舍入原值（5.8），用户手改效率后以新值参与计算（联动在 main.js）。
 */
(function (global) {
  'use strict';

  var P = global.JVParser;
  var isNum = P.isNum;

  /* ---------- 颜色工具：hex → 加深(ratio<0) / 减淡(ratio>0) ---------- */
  function shade(hex, ratio) {
    if (!hex) return '';
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (ratio < 0) {
      var f = 1 + ratio;
      r = r * f; g = g * f; b = b * f;
    } else {
      r = r + (255 - r) * ratio;
      g = g + (255 - g) * ratio;
      b = b + (255 - b) * ratio;
    }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }

  /* ---------- 表格骨架 ---------- */
  function buildTable(headers) {
    var table = document.createElement('table');
    table.className = 'data-table';
    if (headers && headers.length) {
      var thead = document.createElement('thead');
      var tr = document.createElement('tr');
      headers.forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    table.appendChild(document.createElement('tbody'));
    return table;
  }

  function tbodyOf(table) { return table.querySelector('tbody'); }

  function addRow(table, cells, cls) {
    var tr = document.createElement('tr');
    if (cls) tr.className = cls;
    cells.forEach(function (c) {
      var td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    });
    tbodyOf(table).appendChild(tr);
    return tr;
  }

  /* ---------- 数值显示 / 平均 ---------- */
  function num(v) { return P.roundSigText(v); }

  function avgOf(arr) {
    var sum = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      if (isNum(arr[i])) { sum += arr[i]; n++; }
    }
    return n ? sum / n : NaN;
  }

  /** 器件当前生效的反扫效率（统一入口 P.deviceParam，改动 1） */
  function effOf(device) {
    return P.deviceParam(device, 'pce');
  }

  /** HI 显示：百分比、1 位小数；无效显示 '—'（第七批：0.04347 → 4.3%） */
  function hiText(v) {
    return isNum(v) ? (v * 100).toFixed(1) + '%' : '—';
  }

  /** 器件是否参与统计与绘图（排除标记，改动 1） */
  function isActive(device) {
    return !device.excluded;
  }

  /** 未排除的器件列表（统计/绘图用） */
  function activeDevices(devices) {
    return devices.filter(isActive);
  }

  /** 条件各参数平均值（第十二批：Base 基准对比用；只统计未排除器件，avgOf 已过滤无效值）
   *  t53：Voc/Jsc/FF 改用 P.deviceParam（反扫优先 + 单方向 fwd 兜底——与 Max 行/详情表同语义，防单方向数据 Average 空白） */
  function condAverages(cond) {
    var d = activeDevices(cond.devices);
    if (!d.length) return null;
    return {
      voc: avgOf(d.map(function (x) { return P.deviceParam(x, 'voc'); })),
      jsc: avgOf(d.map(function (x) { return P.deviceParam(x, 'jsc'); })),
      ff: avgOf(d.map(function (x) { return P.deviceParam(x, 'ff'); })),
      pce: avgOf(d.map(effOf)),
      hi: avgOf(d.map(function (x) { return x.HI; }))
    };
  }

  /** 第十二批 Base 对比：各参数绝对阈值下限（与相对阈值 1%×|B| 取较大者作为持平判定） */
  var BASE_ABS_THR = { voc: 0.005, jsc: 0.1, ff: 0.5, pce: 0.1, hi: 0.005 };
  var BASE_PARAM_LABEL = { voc: 'Voc', jsc: 'Jsc', ff: 'FF', pce: 'PCE', hi: 'HI' };

  /** 在 Average 行数值单元格后追加 Base 对比箭头（数字后 append；持平不标；HI 越低越好） */
  function baseArrow(cell, key, V, B, baseName) {
    if (!isNum(V) || !isNum(B)) return null;
    var thr = Math.max(0.01 * Math.abs(B), BASE_ABS_THR[key]);
    var diff = V - B;
    if (Math.abs(diff) <= thr) return null; // 持平不标，避免满屏箭头
    var better = key === 'hi' ? diff < 0 : diff > 0;
    var rel = Math.abs(diff) / Math.abs(B);
    var lv = rel < 0.03 ? 's1' : (rel < 0.08 ? 's2' : 's3');
    var span = document.createElement('span');
    span.className = 'base-arrow ' + (better ? 'good' : 'bad') + ' ' + lv;
    span.textContent = better ? '▲' : '▼';
    var pct = (rel * 100).toFixed(1);
    var lbl = key === 'hi' ? 'HI' : BASE_PARAM_LABEL[key];
    var vTxt = key === 'hi' ? hiText(V) : P.roundSigText(V);
    var bTxt = key === 'hi' ? hiText(B) : P.roundSigText(B);
    if (typeof I18N !== 'undefined' && I18N.getLang() === 'en') {
      var enGood = key === 'hi' ? 'lower (better)' : 'higher';
      span.title = 'Avg ' + lbl + ' ' + vTxt + ', vs Base (' + bTxt + ') ' + (better ? enGood : (enGood === 'lower (better)' ? 'higher' : 'lower')) + ' ' + pct + '%';
    } else {
      span.title = lbl + ' 平均 ' + vTxt + '，比 Base（' + bTxt + '）' + (better ? (key === 'hi' ? '低（更优）' : '高') : (key === 'hi' ? '高' : '低')) + ' ' + pct + '%';
    }
    cell.appendChild(span);
    return { better: better, rel: rel };
  }

  /** 第十二批：Condition 单元格三色 emoji（只比 PCE：平均+最高 vs Base，稀疏标记） */
  function baseEmoji(condAvg, maxPce, baseAvg, baseMaxPce) {
    if (!condAvg || !isNum(condAvg.pce) || !isNum(maxPce) || !baseAvg || !isNum(baseAvg.pce) || !isNum(baseMaxPce)) return null;
    var thr = Math.max(0.01 * Math.abs(baseAvg.pce), 0.1);
    var avgBetter = condAvg.pce > baseAvg.pce + thr;
    var avgWorse = condAvg.pce < baseAvg.pce - thr;
    var maxBetter = maxPce > baseMaxPce + thr;
    var maxNotBetter = maxPce <= baseMaxPce + thr;
    if (avgBetter && maxBetter) return { emo: '😊', title: (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Average and best efficiency both beat Base' : '平均与最高效率均优于 Base' };
    if (maxBetter && !avgBetter) return { emo: '🤔', title: (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Best efficiency beats Base but average is flat or worse (promising but unstable)' : '最高效率优于 Base，但平均效率持平或更差（有潜力但不稳）' };
    if (avgWorse && maxNotBetter) return { emo: '😢', title: (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Average and best efficiency both trail Base' : '平均与最高效率均不如 Base' };
    return null; // 其余情况不标（避免泛滥）
  }

  /* ================================================================
   * 9.1 S2 汇总表：Condition | Type | Voc | Jsc | FF | Efficiency | HI
   *   每条件两行：Max（最高器件反扫参数 + 其 HI）和 Average（全部器件各列平均）
   *   Condition 纵向合并两行；Max 行主题色加深 10%，Average 行减淡 42%
   *   追加到传入的 table（所有条件共用一张表，由 main.js 建表头）
   *   第十二批：baseInfo 传 {base:true}（本行是 Base）或 {avg,maxPce,allAvg,index,baseIdx}（被比条件）
   *   ================================================================ */
  function appendSummaryRows(table, cond, themeColor, baseInfo) {
    var tbody = tbodyOf(table);
    table.classList.add('summary-table'); // 第十批：汇总表专用紧凑样式
    var maxIdx = cond.maxDeviceIndex;
    var maxDev = maxIdx >= 0 && maxIdx < cond.devices.length ? cond.devices[maxIdx] : null;

    // --- Max 行 ---
    var trMax = document.createElement('tr');
    trMax.className = 'row-max-val cond-group-start'; // 数值加粗（用户要求）+ 第十二批：条件组分隔线
    var tdCond = document.createElement('td');
    tdCond.textContent = cond.displayName || cond.name;
    tdCond.rowSpan = 2;
    tdCond.className = 'col-cond'; // 第十批：左对齐 + 加粗
    tdCond.style.background = themeColor ? shade(themeColor, 0.85) : ''; // 第八批：浅 tint 替代实底
    trMax.appendChild(tdCond);
    var tdTypeMax = document.createElement('td');
    tdTypeMax.className = 'col-type'; // 第十批：Type 列左对齐（不能用 nth-child：Average 行第 1 格即 Type）
    tdTypeMax.textContent = 'Max';
    trMax.appendChild(tdTypeMax);
    if (maxDev) {
      trMax.appendChild(makeTd(num(P.deviceParam(maxDev, 'voc')))); // V2/t6 统一入口：反扫优先、单方向（fwd-only）回退 fwd——直接取 rev 字段在单方向器件下显示为空（判向源分叉时 17/27 类纯数字主键空白）
      trMax.appendChild(makeTd(num(P.deviceParam(maxDev, 'jsc'))));
      trMax.appendChild(makeTd(num(P.deviceParam(maxDev, 'ff'))));
      trMax.appendChild(makeTd(num(effOf(maxDev))));
      trMax.appendChild(makeTd(hiText(maxDev.HI)));
    } else {
      for (var i = 0; i < 5; i++) trMax.appendChild(makeTd(''));
    }
    trMax.style.background = themeColor ? shade(themeColor, 0.75) : ''; // 第八批：浅 tint
    tbody.appendChild(trMax);

    // --- Average 行（只统计未排除器件，改动 1） ---
    var trAvg = document.createElement('tr');
    var tdTypeAvg = document.createElement('td');
    tdTypeAvg.className = 'col-type'; // 第十批：Type 列左对齐
    tdTypeAvg.textContent = 'Average';
    trAvg.appendChild(tdTypeAvg);
    var d = activeDevices(cond.devices);
    var condAvg = condAverages(cond);
    var cells = [
      makeTd(d.length ? num(condAvg.voc) : '—'),
      makeTd(d.length ? num(condAvg.jsc) : '—'),
      makeTd(d.length ? num(condAvg.ff) : '—'),
      makeTd(d.length ? num(condAvg.pce) : '—'),
      makeTd(d.length ? hiText(condAvg.hi) : '—')
    ];
    cells.forEach(function (td) { trAvg.appendChild(td); });
    trAvg.style.background = themeColor ? shade(themeColor, 0.90) : ''; // 第八批：近白浅 tint
    tbody.appendChild(trAvg);

    // --- 第十二批：Base 对比标记 ---
    if (baseInfo && condAvg) {
      var baseName = baseInfo.base ? null : (baseInfo.baseName || 'Base');
      if (baseInfo.base) {
        // Base 自己的行：条件名后加 ⚑ Base 小标记
        var flag = document.createElement('span');
        flag.className = 'base-flag';
        flag.textContent = '⚑ Base';
        flag.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Base condition: all other conditions are compared against it' : '基准条件（Base）：其余条件与此对比';
        tdCond.appendChild(flag);
      } else {
        // 被比条件：Average 行参数箭头（voc/jsc/ff/pce/hi）+ ⭐ + Condition emoji
        var keys = ['voc', 'jsc', 'ff', 'pce', 'hi'];
        var cellMap = { voc: cells[0], jsc: cells[1], ff: cells[2], pce: cells[3], hi: cells[4] };
        var maxPce = maxDev ? effOf(maxDev) : null;
        keys.forEach(function (key) {
          var res = baseArrow(cellMap[key], key, condAvg[key], baseInfo.avg[key], baseName);
          // ⭐：非 Base 条件中该参数平均最好、且优于 Base、相对偏离 ≥5%（只对「高好」参数，克制）
          if (res && res.better && res.rel >= 0.05 && key !== 'hi' && baseInfo.allAvg) {
            var best = true;
            for (var k in baseInfo.allAvg) {
              if (k == baseInfo.index || k == baseInfo.baseIdx) continue;
              var o = baseInfo.allAvg[k];
              if (o && isNum(o[key]) && o[key] > condAvg[key]) { best = false; break; }
            }
            if (best) {
              var star = document.createElement('span');
              star.className = 'base-star';
              star.textContent = '⭐';
              star.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
                ? (BASE_PARAM_LABEL[key] + ' average is best across all conditions and beats Base')
                : (BASE_PARAM_LABEL[key] + ' 平均全场最优，且优于 Base');
              cellMap[key].appendChild(star);
            }
          }
        });
        // Condition emoji
        var emo = baseEmoji(condAvg, maxPce, baseInfo.avg, baseInfo.maxPce);
        if (emo) {
          var e = document.createElement('span');
          e.className = 'base-emoji';
          e.textContent = emo.emo;
          e.title = emo.title;
          tdCond.appendChild(e);
        }
      }
    }
  }

  /* ================================================================
   * 9.2 S3 详情表：排除 | Device | Voc | Jsc | FF | Efficiency | HI
   *   每行 = 一个器件的反扫参数 + HI；末行 Average 双线分隔（只统计未排除器件）；
   *   最高效率行加粗 + 条件色加深 14% 底 + 外框；Efficiency 列可编辑；
   *   每行最前「⊘/↺」按钮排除/恢复器件（改动 1，非破坏性）
   *   第十六批：opts.reindex=true 用于 PDF 打印——序号按未排除器件连续重排、
   *   不渲染排除行、不渲染排除按钮列（打印版无排除列，表头同步少一列）
   * ================================================================ */
  function renderDetailTable(cond, themeColor, onEditEff, onToggleExclude, opts) {
    opts = opts || {};
    var reindex = !!opts.reindex;
    var headCells = reindex ? ['Device', 'Voc (V)', 'Jsc (mA/cm^2)', 'Fill Factor (%)', 'Efficiency (%)', 'HI (%)']
                            : ['', 'Device', 'Voc (V)', 'Jsc (mA/cm^2)', 'Fill Factor (%)', 'Efficiency (%)', 'HI (%)'];
    var table = buildTable(headCells); // 第七批：HI 百分比
    table.classList.add('dense-table'); // 紧凑可读样式（改动 3）
    // P5：行点击 → 详情 JV 图切换（main.js 挂回调）
    if (opts.onSelectDev) table.__onSelectDev = opts.onSelectDev;
    var tbody = tbodyOf(table);
    var devices = cond.devices;

    // 改动 2/4：未排除器件 ≥4 时，计算 4 参数各自的 1.5×IQR 栅栏（与箱线图同一套判据）；
    // 第七批：fence 额外存 mean/iqr 供三档偏离度箭头用
    var fences = null;
    var activeAll = activeDevices(devices);
    if (activeAll.length >= 4) {
      fences = {};
      ['pce', 'voc', 'jsc', 'ff'].forEach(function (key) {
        var values = activeAll.map(function (d) { return P.deviceParam(d, key); }).filter(P.isNum);
        if (values.length < 4) { fences[key] = null; return; }
        var w = P.whiskers(values, 'iqr');
        fences[key] = { lo: w.stats.q1 - 1.5 * w.stats.iqr, hi: w.stats.q3 + 1.5 * w.stats.iqr, mean: w.stats.mean, iqr: w.stats.iqr };
      });
    }
    var PARAM_NAMES = { pce: 'PCE', voc: 'Voc', jsc: 'Jsc', ff: 'FF' };
    // 箭头插入目标列（pce 不标箭头；数字前 prepend，2px 间距见 CSS）
    var ARROW_COL = { voc: 1, jsc: 2, ff: 3 };
    function addArrow(td, dir, level, tip) {
      var span = document.createElement('span');
      span.className = 'dev-arrow ' + dir + ' ' + level;
      span.textContent = dir === 'up' ? '▲' : '▼'; // 第十批：实心三角更醒目
      span.title = tip;
      td.insertBefore(span, td.firstChild);
    }

    var printIdx = 0; // 第十六批：reindex 模式连续序号
    devices.forEach(function (dev, i) {
      var tr = document.createElement('tr');
      // reindex（PDF 打印）：跳过已排除行、无排除按钮列、序号连续
      if (reindex) {
        if (dev.excluded) return;
        printIdx++;
      } else {
        // 排除/恢复按钮（32px 窄列）
        var toggleTd = document.createElement('td');
        toggleTd.className = 'exclude-cell';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'exclude-btn';
        btn.textContent = dev.excluded ? '↺' : '⊘';
        btn.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
          ? (dev.excluded ? 'Restore this device' : 'Exclude this device: excluded from averages/maxima/plots')
          : (dev.excluded ? '恢复此器件' : '排除此器件：不参与平均值/最高值/绘图');
        btn.addEventListener('click', function () {
          if (onToggleExclude) onToggleExclude(i);
        });
        toggleTd.appendChild(btn);
        tr.appendChild(toggleTd);
      }
      var cells = [
        makeTd(String(reindex ? printIdx : i + 1)),
        makeTd(num(P.deviceParam(dev, 'voc'))), // V2/t6：统一入口（反扫优先、单方向正扫回退 fwd）——直接取 rev 字段在 fwd-only 器件下显示为空
        makeTd(num(P.deviceParam(dev, 'jsc'))),
        makeTd(num(P.deviceParam(dev, 'ff'))),
        makeTd(num(effOf(dev))),
        makeTd(hiText(dev.HI))
      ];
      cells.forEach(function (td) { tr.appendChild(td); });

      // 第三十七批方案B：合并来源标注——device 序号旁小字显示来源条件（仅页面分析用；
      // PDF reindex 模式不渲染，符合"不导出到 PDF"要求）
      if (!reindex && dev.srcCond) {
        var srcSpan = document.createElement('span');
        srcSpan.className = 'dev-src';
        srcSpan.textContent = '·' + dev.srcCond;
        srcSpan.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('Source condition: ' + dev.srcCond) : ('来源条件：' + dev.srcCond);
        cells[0].appendChild(srcSpan);
      }

      // 第七批：⚠ 只标 PCE 异常低值（放行高值）；Voc/Jsc/FF 越出栅栏 → 单元格内数字前三档箭头
      var issues = [];
      if (fences && !dev.excluded) {
        ['pce', 'voc', 'jsc', 'ff'].forEach(function (key) {
          var f = fences[key];
          if (!f) return;
          var v = P.deviceParam(dev, key);
          if (!P.isNum(v)) return;
          if (key === 'pce') {
            if (v < f.lo) issues.push((typeof I18N !== 'undefined' && I18N.getLang() === 'en')
              ? ('Suspected low outlier: PCE ' + P.roundSigText(v) + ' below lower fence ' + P.roundSigText(f.lo) + ' (1.5×IQR)')
              : ('疑似异常低值：PCE ' + P.roundSigText(v) + ' 低于下栅栏 ' + P.roundSigText(f.lo) + '（1.5×IQR）'));
          } else {
            var z = Math.abs(v - f.mean) / f.iqr;
            var lv = z < 2 ? 's1' : (z <= 3 ? 's2' : 's3'); // 偏离度三档：浅/中/深
            if (v > f.hi) {
              addArrow(cells[ARROW_COL[key]], 'up', lv,
                (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
                  ? (PARAM_NAMES[key] + ' above upper fence ' + P.roundSigText(f.hi) + ' (deviation ' + z.toFixed(1) + '×IQR)')
                  : (PARAM_NAMES[key] + ' 高于上栅栏 ' + P.roundSigText(f.hi) + '（偏离 ' + z.toFixed(1) + '×IQR）'));
            } else if (v < f.lo) {
              addArrow(cells[ARROW_COL[key]], 'down', lv,
                (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
                  ? (PARAM_NAMES[key] + ' below lower fence ' + P.roundSigText(f.lo) + ' (deviation ' + z.toFixed(1) + '×IQR)')
                  : (PARAM_NAMES[key] + ' 低于下栅栏 ' + P.roundSigText(f.lo) + '（偏离 ' + z.toFixed(1) + '×IQR）'));
            }
          }
        });
      }

      // P5：序号格皇冠标注（最高效率器件；排除行不标）+ 序号格显式按钮切换详情 JV 图
      // （用户反馈：整行点击易被鼠标框选误触，改物理按钮）
      if (!reindex && !dev.excluded) {
        tr.setAttribute('data-dev-idx', String(i));
        if (i === cond.maxDeviceIndex) {
          var crown = document.createElement('span');
          crown.className = 'dev-crown';
          crown.textContent = '👑';
          crown.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Highest-efficiency device (shown by default in the detail JV chart)' : '最高效率器件（详情 JV 图默认显示此条）';
          cells[0].appendChild(crown);
        }
        var selBtn = document.createElement('button');
        selBtn.type = 'button';
        selBtn.className = 'dev-jv-btn';
        selBtn.textContent = '📈';
        selBtn.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Show this device curve in the right JV chart' : '在右侧 JV 图中显示此器件曲线';
        selBtn.addEventListener('click', function (idx) {
          return function (e) {
            e.stopPropagation();
            var cb = table && table.__onSelectDev; // 修复：tr 无 table 属性，用闭包 table
            if (cb) cb(idx);
          };
        }(i));
        cells[0].appendChild(selBtn);
      }

      // 已排除行灰显（改动 1）；防御：排除行不可能同时是最高行
      if (dev.excluded) {
        tr.className = 'row-excluded';
      } else if (i === cond.maxDeviceIndex) {
        tr.className = 'row-max'; // P5：仅保留加粗（皇冠已标注），不再背景/边框突出
      }
      if (!dev.excluded && issues.length) {
        tr.className += ' row-suspect'; // 淡黄底（优先级：row-excluded > row-max > row-suspect > 斑马纹）
        var warn = document.createElement('span');
        warn.className = 'suspect-mark';
        warn.textContent = '⚠';
        warn.title = issues.join('；'); // 第七批：文案已含「疑似异常低值：」前缀
        if (reindex) cells[0].appendChild(warn); // 打印版无排除列，⚠ 放序号格
        else toggleTd.appendChild(warn);
      }

      // t4-1：不再允许鼠标编辑效率（显示仍走 effOf——userEff 修正值仍显示但不可改）

      tbody.appendChild(tr);
    });

    // --- Average 行（上行双线分隔；只统计未排除器件，改动 1） ---
    var active = activeDevices(devices);
    var avgCells = [
      'Average',
      active.length ? num(avgOf(active.map(function (x) { return P.deviceParam(x, 'voc'); }))) : '—', // t53：rev 优先+fwd 兜底（防单方向 Average 空白）
      active.length ? num(avgOf(active.map(function (x) { return P.deviceParam(x, 'jsc'); }))) : '—',
      active.length ? num(avgOf(active.map(function (x) { return P.deviceParam(x, 'ff'); }))) : '—',
      active.length ? num(avgOf(active.map(effOf))) : '—',
      active.length ? hiText(avgOf(active.map(function (x) { return x.HI; }))) : '—' // HI 平均也显示百分比（第八批 bug 修复）
    ];
    if (!reindex) avgCells.unshift(''); // 排除列占位（与器件行对齐；打印版无排除列）
    var trAvg = addRow(table, avgCells, 'row-avg');

    return table;
  }

  function refreshCell(td, text) {
    td.textContent = text;
  }

  function makeTd(text) {
    var td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  /* ================================================================
   * 9.3 S4 最高器件原始数据表：条件名 + 正反扫并排（原值不舍入、保持顺序）
   *   返回 { wrap, fwdTable, revTable }；无数据时表内显示斜体提示
   * ================================================================ */
  function renderRawDataTable(cond, titleFwdEff, titleRevEff, opts) {
    opts = opts || {};
    // P5-6：支持按序号选择器件（详情卡原始数据折叠；缺省最高器件）
    var devIdx = (opts.devIndex != null && opts.devIndex >= 0) ? opts.devIndex : cond.maxDeviceIndex;
    var maxDev = cond.devices[devIdx];
    var fwdPts = (maxDev && maxDev.fwd && maxDev.fwd.points) || [];
    var revPts = (maxDev && maxDev.rev && maxDev.rev.points) || [];
    var fwdArea = maxDev && maxDev.fwd && P.isNum(maxDev.fwd.area) ? maxDev.fwd.area : '';
    var revArea = maxDev && maxDev.rev && P.isNum(maxDev.rev.area) ? maxDev.rev.area : '';
    // 改动 1：单方向器件的缺失侧提示更准确（dir:'rev' 无正扫、dir:'fwd' 无反扫）
    var fwdMissing = maxDev && maxDev.dir === 'rev' ? '单方向扫描（无正扫）' : '未找到对应原始数据';
    var revMissing = maxDev && maxDev.dir === 'fwd' ? '单方向扫描（无反扫）' : '未找到对应原始数据';

    function sideTable(pts, eff, area, missingText) {
      var table = buildTable([]);
      var tbody = tbodyOf(table);
      // 标题行（Efficiency 用 4 位有效数字）
      var trTitle = document.createElement('tr');
      var tdTitle = document.createElement('td');
      tdTitle.colSpan = 3;
      tdTitle.style.fontWeight = '700';
      tdTitle.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? ('Forward (Efficiency: ' + (P.isNum(eff) ? P.roundSigText(eff) : '—') + '%)')
        : ('正扫 Forward（Efficiency：' + (P.isNum(eff) ? P.roundSigText(eff) : '—') + '%）');
      trTitle.appendChild(tdTitle);
      tbody.appendChild(trTitle);
      // Area 行
      var trArea = document.createElement('tr');
      var tdArea = document.createElement('td');
      tdArea.colSpan = 3;
      tdArea.style.color = 'var(--text-2)';
      tdArea.textContent = 'Area (cm^2): ' + (P.isNum(area) ? area : '—');
      trArea.appendChild(tdArea);
      tbody.appendChild(trArea);
      // 表头行
      var trHead = document.createElement('tr');
      ['[Volt (V)]', '[Current (mA)]', '[J (mA/cm^2)]'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        trHead.appendChild(th);
      });
      tbody.appendChild(trHead);
      // 数据行（原值不舍入、保持原顺序）
      if (pts.length === 0) {
        var trNone = document.createElement('tr');
        var tdNone = document.createElement('td');
        tdNone.colSpan = 3;
        tdNone.className = 'missing';
        tdNone.textContent = missingText || ((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'No matching raw data' : '未找到对应原始数据');
        trNone.appendChild(tdNone);
        tbody.appendChild(trNone);
      } else {
        pts.forEach(function (p) {
          var tr = document.createElement('tr');
          for (var k = 0; k < 3; k++) {
            var td = document.createElement('td');
            td.textContent = String(p[k]);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        });
      }
      return table;
    }

    var fwdTable = sideTable(fwdPts, titleFwdEff, fwdArea, fwdMissing);
    var revTable = sideTable(revPts, titleRevEff, revArea, revMissing);
    // 标题行：反扫表第一行改文字
    var revTitleTd = tbodyOf(revTable).querySelectorAll('tr')[0].children[0];
    revTitleTd.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
      ? ('Reverse (Efficiency: ' + (P.isNum(titleRevEff) ? P.roundSigText(titleRevEff) : '—') + '%)')
      : ('反扫 Reverse（Efficiency：' + (P.isNum(titleRevEff) ? P.roundSigText(titleRevEff) : '—') + '%）');

    // 两侧行数对齐（一侧较短留空）
    var fwdRows = tbodyOf(fwdTable).querySelectorAll('tr').length;
    var revRows = tbodyOf(revTable).querySelectorAll('tr').length;
    var maxRows = Math.max(fwdRows, revRows);
    alignRows(fwdTable, revTable, maxRows);

    var wrap = document.createElement('div');
    wrap.className = 'raw-table-wrap';
    var colF = document.createElement('div');
    colF.className = 'raw-col';
    colF.appendChild(fwdTable);
    var colR = document.createElement('div');
    colR.className = 'raw-col';
    colR.appendChild(revTable);
    wrap.appendChild(colF);
    wrap.appendChild(colR);
    return { wrap: wrap, fwdTable: fwdTable, revTable: revTable };
  }

  /** 较短一侧补空行，使两表行数一致 */
  function alignRows(t1, t2, target) {
    [t1, t2].forEach(function (t) {
      var tbody = tbodyOf(t);
      while (tbody.querySelectorAll('tr').length < target) {
        var tr = document.createElement('tr');
        for (var k = 0; k < 3; k++) {
          var td = document.createElement('td');
          td.textContent = '';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    });
  }

  /* ================================================================
   * 7.4 复制表格：制表符分隔文本 → 剪贴板（rowspan 补空对齐，可直接粘 Excel）
   * 复制时跳过已排除的行（改动 1），并提示跳过的数量
   * ================================================================ */
  function tableToTSV(tableEl) {
    return tableToTSVWithSkip(tableEl).text;
  }

  /** 返回 { text, skipped }：skipped = 跳过的已排除行数（改动 1） */
  function tableToTSVWithSkip(tableEl) {
    var lines = [];
    var rowSpans = {};
    var trs = tableEl.querySelectorAll('tr');
    var skipped = 0;
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].className && String(trs[i].className).indexOf('row-excluded') >= 0) { skipped++; continue; }
      var cells = trs[i].querySelectorAll('th, td');
      var line = [];
      var col = 0;
      for (var j = 0; j < cells.length; j++) {
        var cell = cells[j];
        while (rowSpans[col]) { line.push(''); rowSpans[col]--; col++; }
        line.push(cell.textContent.replace('✎', '').trim());
        var rs = parseInt(cell.getAttribute('rowspan') || '1', 10);
        if (rs > 1) rowSpans[col] = rs - 1;
        col++;
      }
      lines.push(line.join('\t'));
    }
    return { text: lines.join('\n'), skipped: skipped };
  }

  function copyTableAsTSV(tableEl, onFail) {
    var res = tableToTSVWithSkip(tableEl);
    var tip = res.skipped > 0 ? '表格已复制（跳过 ' + res.skipped + ' 个已排除器件），可直接粘贴到 Excel' : '表格已复制，可直接粘贴到 Excel';
    var text = res.text;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(tip);
      }, function () {
        fallbackCopy(text, tip, onFail);
      });
    } else {
      fallbackCopy(text, tip, onFail);
    }
  }

  function fallbackCopy(text, tip, onFail) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) showToast(tip || '表格已复制，可直接粘贴到 Excel');
      else if (onFail) onFail();
    } catch (e) {
      if (onFail) onFail();
    }
  }

  /* 简单 toast 提示（i18n：英文态经 I18N.tr 整句翻译；未匹配原样） */
  function showToast(msg) {
    if (typeof I18N !== 'undefined' && I18N.tr) msg = I18N.tr(msg);
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2000);
  }

  global.JVTable = {
    buildTable: buildTable,
    addRow: addRow,
    tbodyOf: tbodyOf,
    shade: shade,
    num: num,
    avgOf: avgOf,
    effOf: effOf,
    hiText: hiText,
    isActive: isActive,
    activeDevices: activeDevices,
    appendSummaryRows: appendSummaryRows,
    condAverages: condAverages,
    renderDetailTable: renderDetailTable,
    renderRawDataTable: renderRawDataTable,
    copyTableAsTSV: copyTableAsTSV,
    tableToTSV: tableToTSV,
    tableToTSVWithSkip: tableToTSVWithSkip,
    showToast: showToast
  };
})(typeof window !== 'undefined' ? window : globalThis);
