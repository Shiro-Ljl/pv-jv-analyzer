/* V2 · 相关性矩阵 + 散点（P3）
 * 纯函数核心：每器件一行对齐多参数（PCE/Voc/Jsc/FF + Rs/Rsh + n/J₀），
 * 两两 Pearson 相关 + 显著性 t 检验（成对剔除缺失），以及散点数据（含条件/器件定位）。
 * 依赖：globalThis.JVParser.deviceParam、globalThis.JVFit.fitDevice（缺失时对应参数留空）。
 * 无 DOM。挂 globalThis.JVCorr。
 */
(function (global) {
  'use strict';

  var PARAMS = [
    { key: 'pce', label: 'PCE', unit: '%' },
    { key: 'voc', label: 'Voc', unit: 'V' },
    { key: 'jsc', label: 'Jsc', unit: 'mA/cm²' },
    { key: 'ff', label: 'FF', unit: '%' },
    { key: 'rs', label: 'Rs', unit: 'Ω' },
    { key: 'rsh', label: 'Rsh', unit: 'Ω(log)' },
    { key: 'n', label: 'n', unit: '' },
    { key: 'j0', label: 'log₁₀J₀', unit: 'mA/cm²' }
  ];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 3) return null;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var xd = xs[j] - mx, yd = ys[j] - my;
      num += xd * yd; dx += xd * xd; dy += yd * yd;
    }
    if (dx === 0 || dy === 0) return null;
    return num / Math.sqrt(dx * dy);
  }

  /* -------- 学生 t 分布双尾 p（不完全 Beta 连分数，Lentz） -------- */
  function betaContinuedFraction(a, b, x) {
    var MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; var del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function gammaLn(x) {
    var g = 7, C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
    x -= 1; var a = C[0], t = x + g + 0.5;
    for (var i = 1; i < C.length; i++) a += C[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function incompleteBeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(gammaLn(a + b) - gammaLn(a) - gammaLn(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betaContinuedFraction(a, b, x) / a : 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
  }
  function tCdf(t, df) { return 1 - 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t)); }
  function correlP(r, n) {
    if (!isNum(r) || n < 4) return 1;
    var t = r * Math.sqrt((n - 2) / (1 - r * r));
    return 2 * (1 - tCdf(Math.abs(t), n - 2));
  }
  function stars(p) { return p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : ''; }

  /** 每器件一行参数（devIdx 为条件内序号，供散点 tooltip 定位）。缺失参数留 NaN。
   *  mode（t8）：n/J₀ 取数口径 —— 'avg'（默认，正反扫平均主值）| 'rev'（反扫）| 'fwd'（正扫）。
   *  单扫器件在非对应口径下对应方向为 NaN → 不参与该口径相关（合理）。 */
  function rowForDevice(cond, d, idx, mode) {
    var P = global.JVParser, Fit = global.JVFit;
    function dp(k) {
      return P && P.deviceParam ? P.deviceParam(d, k) : NaN;
    }
    var r = {
      pce: dp('pce'), voc: dp('voc'), jsc: dp('jsc'), ff: dp('ff'),
      rs: d.rs, rsh: d.rsh, n: NaN, j0: NaN,
      condName: cond.displayName || cond.name, devIdx: idx + 1
    };
    if (Fit && d.rev && d.rev.points && d.rev.points.length) {
      var f = Fit.fitDevice(d);
      if (f) {
        var nv, j0v;
        if (mode === 'rev') { nv = f.n_rev; j0v = f.J0_rev; }
        else if (mode === 'fwd') { nv = f.n_fwd; j0v = f.J0_fwd; }
        else { nv = f.n; j0v = f.J0; }
        if (isNum(nv) && isNum(j0v) && j0v > 0) { r.n = nv; r.j0 = Math.log10(j0v); }
      }
    }
    return r;
  }

  /** 全部行（可过滤已勾选条件由调用方传 conditions）。返回 {rows, params}。
   *  opts={mode:'avg'|'rev'|'fwd'}（t8 口径切换）。 */
  function buildRows(conditions, opts) {
    var mode = (opts && opts.mode) || 'avg';
    var rows = [];
    (conditions || []).forEach(function (c) {
      (c.devices || []).forEach(function (d, idx) {
        if (d.excluded) return; // V2 修正：被排除器件不入分析（设备序号保持原始，便于回查）
        rows.push(rowForDevice(c, d, idx, mode));
      });
    });
    return { rows: rows, params: PARAMS };
  }

  /** 两参数在所有器件上的成对有效值 → {x,y,n,r,p,star}（PCE 作 y 的散点用） */
  function pair(rows, keyA, keyB) {
    var xs = [], ys = [];
    rows.forEach(function (r) {
      if (isNum(r[keyA]) && isNum(r[keyB])) { xs.push(r[keyA]); ys.push(r[keyB]); }
    });
    var n = xs.length, r = n >= 3 ? pearson(xs, ys) : null;
    var p = isNum(r) && r != null ? correlP(r, n) : 1;
    return { x: xs, y: ys, n: n, r: r, p: p, star: isNum(r) ? stars(p) : '' };
  }

  /** 全矩阵：matrix[i][j]（PARAMS 索引）→ pair 结果 */
  function buildMatrix(rows) {
    var N = PARAMS.length, m = [];
    for (var i = 0; i < N; i++) { m[i] = []; for (var j = 0; j < N; j++) m[i][j] = null; }
    for (var a = 0; a < N; a++) for (var b = a; b < N; b++) {
      var pr = pair(rows, PARAMS[a].key, PARAMS[b].key);
      m[a][b] = pr; m[b][a] = pr; // 对称
    }
    return m;
  }

  /** 散点数据（含条件与器件定位） */
  function scatter(rows, keyA, keyB) {
    var out = [];
    rows.forEach(function (r) {
      if (isNum(r[keyA]) && isNum(r[keyB])) {
        out.push({ x: r[keyA], y: r[keyB], cond: r.condName, dev: r.devIdx });
      }
    });
    return out;
  }

  /** 参考性结论：基于矩阵的显著信号，生成一段/多条中文解读（辅助判断，非定论）。 */
  function summarize(rows, m) {
    var con = [];
    var ND = { pce: 0, voc: 1, jsc: 2, ff: 3, rs: 4, rsh: 5, n: 6, j0: 7 };
    var N = rows.length;
    function cell(a, b) { return m[ND[a]][ND[b]]; }
    function sig(c) { return c && c.p < 0.05 && c.n >= 8 && c.r != null; }

    // 1) PCE 主驱动：PCE 行最强显著非对角
    var best = null;
    ['voc', 'jsc', 'ff', 'rs', 'rsh', 'n', 'j0'].forEach(function (k) {
      var c = cell('pce', k);
      if (sig(c) && (!best || Math.abs(c.r) > Math.abs(best.r))) best = { k: k, c: c, r: c.r };
    });
    if (best) {
      var drive = {
        jsc: '短路电流 Jsc 决定（偏光吸收 / 膜厚）',
        ff: '填充因子 FF 决定（偏接触 / 复合 / 串联损耗）',
        voc: '开路电压 Voc 决定（偏钝化 / 能级 / 复合）',
        rs: '串联电阻 Rs 决定（偏电极 / 接触损耗，属工艺问题）',
        n: '理想因子 n 决定（偏体/界面缺陷复合）',
        j0: '复合强度 J₀ 决定（Voc 损耗，偏钝化/界面缺陷）',
        rsh: '并联电阻 Rsh 决定（偏漏电 / 针孔）'
      }[best.k];
      var driveEn = {
        jsc: 'short-circuit current Jsc (optical absorption / film thickness)',
        ff: 'fill factor FF (contact / recombination / series loss)',
        voc: 'open-circuit voltage Voc (passivation / energetics / recombination)',
        rs: 'series resistance Rs (electrode / contact loss — process issue)',
        n: 'ideality factor n (bulk / interface defect recombination)',
        j0: 'recombination strength J₀ (Voc loss, passivation / interface defects)',
        rsh: 'shunt resistance Rsh (leakage / pinholes)'
      }[best.k]; // P-1 修复：textEn 此前引用未定义的 driveEn，对象构造即抛 ReferenceError（中英文态皆崩，best 非空必现，2f2cc29 引入）
      con.push({
        level: (best.k === 'n' || best.k === 'j0' || best.k === 'rs' || best.k === 'rsh') ? 'warn' : 'info',
        text: 'PCE 与【' + PARAMS[ND[best.k]].label + '】相关性最强（r=' + best.c.r.toFixed(2) + (best.c.p < 0.001 ? '***' : '**') + '）→ 本批器件性能差异主要由 ' + drive + '。',
        textEn: 'PCE most strongly correlates with ' + PARAMS[ND[best.k]].label + ' (r=' + best.c.r.toFixed(2) + (best.c.p < 0.001 ? '***' : '**') + ') → the batch spread is mainly ' + driveEn + '.'
      });
    }

    // 2) 典型信号：FF×logJ0 强负、n×logJ0 强正、PCE×Rs 负
    var ffJ0 = cell('ff', 'j0'), nJ0 = cell('n', 'j0'), prs = cell('pce', 'rs');
    if (sig(ffJ0) && ffJ0.r < -0.6) {
      con.push({ level: 'info', text: 'FF 与 log₁₀(J₀) 强负相关（r=' + ffJ0.r.toFixed(2) + '）→ 复合越弱、FF 越高；FF 是复合强度的敏感窗口。',
      textEn: 'FF strongly anti-correlates with log₁₀(J₀) (r=' + ffJ0.r.toFixed(2) + ') → weaker recombination, higher FF; FF is a sensitive window into recombination strength.' });
    }
    if (sig(nJ0) && nJ0.r > 0.6) {
      con.push({ level: 'info', text: 'n 与 log₁₀(J₀) 强正相关（r=' + nJ0.r.toFixed(2) + '）→ 两项自洽（同源于复合机制），可信度高。',
      textEn: 'n strongly correlates with log₁₀(J₀) (r=' + nJ0.r.toFixed(2) + ') → the two are self-consistent (same recombination mechanism), high confidence.' });
    }
    if (sig(prs) && prs.r < -0.3) {
      con.push({ level: 'warn', text: 'PCE 与 Rs 显著负相关（r=' + prs.r.toFixed(2) + '）→ 串联损耗正在拖累部分器件，应优先排查电极/接触层。', textEn: 'PCE significantly anti-correlates with Rs (r=' + prs.r.toFixed(2) + ') → series-resistance loss is dragging some devices; check electrode / contact layers first.' });
    }

    // 3) 器件的效率离散度提示（PCE 的 IQR 跨度）
    var pces = rows.map(function (r) { return r.pce; }).filter(isNum);
    if (pces.length >= 8) {
      var sd = pces.slice().sort(function (a, b) { return a - b; });
      var q = function (p) { var pos = (sd.length - 1) * p, lb = Math.floor(pos), ub = Math.ceil(pos); return sd[lb] + (pos - lb) * (sd[ub] - sd[lb]); };
      var span = q(0.75) - q(0.25);
      if (span > 2) con.push({ level: 'warn', text: 'PCE 的 IQR 跨度较大（约 ' + span.toFixed(1) + ' 个百分点，' + N + ' 台）→ 批次均匀性一般，建议先看离散大的条件是否来自同一工艺异常。', textEn: 'PCE IQR is wide (~' + span.toFixed(1) + ' points, ' + N + ' devices) → batch uniformity moderate; check whether the high-scatter conditions come from one process anomaly.' });
      else con.push({ level: 'info', text: 'PCE 分布较集中（IQR ≈ ' + span.toFixed(1) + '，' + N + ' 台）→ 批次均匀性较好。', textEn: 'PCE distribution concentrated (IQR ≈ ' + span.toFixed(1) + ', ' + N + ' devices) → good batch uniformity.' });
    }
    if (!con.length) con.push({ level: 'info', text: '未发现强且显著的参数关联（p<0.05），可能样本量不足或参数间本就独立——可增大样本后再看。', textEn: 'No strong, significant parameter association found (p<0.05) — possibly too few samples or genuinely independent parameters; consider a larger sample.' });
    return con;
  }

  var JVCorr = {
    PARAMS: PARAMS,
    rowForDevice: rowForDevice,
    buildRows: buildRows,
    pair: pair,
    buildMatrix: buildMatrix,
    scatter: scatter,
    summarize: summarize,
    pearson: pearson,
    stars: stars
  };
  global.JVCorr = JVCorr;
})(typeof window !== 'undefined' ? window : globalThis);
