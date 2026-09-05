/**
 * charts.js —— 图表渲染与导出（实施规格书第 8 章）
 *
 *   renderBoxplot(dom, paramKey, conditions, opts)   → 单张 Origin 风格箱线图
 *   renderCombinedBoxplot(dom, conditions, opts)     → 2×2 合并图（左上 PCE / 右上 Voc / 左下 Jsc / 右下 FF）
 *   copyChartPNG(chart, fileName)                    → SVG → 4xPNG → 剪贴板（失败降级下载 PNG）
 *   downloadChartSVG(chart, fileName)                → SVG 矢量图下载
 *
 * 规格要点（8.2-8.3）：四分位数 Type-7 自行计算；1.5×IQR 须线（可切 minmax）；
 *   箱体 45% 透明条件色 + 深色描边；均值白方块；原始点固定种子抖动；内刻度、四边框、无网格线。
 */
(function (global) {
  'use strict';

  var P = global.JVParser;

  var FONT = "Arial, 'Microsoft YaHei', sans-serif";
  var Y_TITLES = {
    pce: 'PCE (%)',
    voc: 'Voc (V)',
    jsc: 'Jsc (mA/cm²)',
    ff: 'FF (%)',
    // t4-2：等效电路参数复用主图箱线图构建（标题对齐 PCE/Voc/Jsc/FF 四图）
    rs: 'Rs (Ω)',
    rsh: 'Rsh (Ω)',
    n: 'n',
    j0: 'log₁₀(J₀) (mA/cm²)'
  };

  /* ================================================================
   * 第二十四批：chartStyle 全局样式对象（图像格式调整器）
   * 第二十五批：重构为「按图型命名空间」single/combined/jv 各自独立参数
   *   + 顶层 palette + 顶层 condColors（条件色覆盖）。字号偏移（合并图+2/+5、
   *   JV-2）已固化为各命名空间默认值（single 13/15、combined 15/20、jv 11/13）。
   * 所有 build*Option 读各自命名空间；页面/灯箱/复制/PDF 同源同步。
   * ================================================================ */
  function cloneNS(o) { return JSON.parse(JSON.stringify(o)); }

  var DEFAULT_CHART_STYLE = {
    palette: 'origin',        // 调色板名：origin/nature/blue/warm/gray/tableau10/set1/pastel1/dark2/paired
    condColors: {},           // 条件名(displayName||name) → hex；空则按调色板取色
    single: {
      tickFontSize: 13, titleFontSize: 15, titleBold: true, // t6：刻度字号拆 x/y（xTickFontSize/yTickFontSize 优先，tickFontSize 保留作兼容回退）
      xTickFontSize: 13, yTickFontSize: 13,
      axisLineWidth: 1.5, axisLineColor: '#000000', tickColor: '#000000', labelColor: '#333333',
      boxWidthMin: 55, boxWidthMax: 68, boxFillAlpha: 0.45, boxBorderWidth: 2, boxBorderDarken: 0.3,
      showRawPoints: true, rawPointSize: 4.5, showMean: true, meanSize: 10, meanColor: '#ffffff',
      meanBorderWidth: 1.5, meanBorderDarken: 0.3,
      layout: { padTop: 10, padRight: 10, padBottom: 8 },
      // 第三十七批（第三）坐标轴：null/0=自动；yTitlePos 标题左/右；xLabelRotate 标签旋转（0=按条件数自动）；xLabelGap/yLabelGap 横纵标签间距（0=默认，分别控制）
      yMin: null, yMax: null, yInterval: null,
      yTitlePos: 'left', xLabelRotate: 0, xLabelGap: 0, yLabelGap: 0, xTitleGap: 0, yTitleGap: 0,
      xLabelOffset: 0 // t6：X 轴横向偏移（旋转标签与箱体视觉对齐微调，px，正右负左）
    },
    combined: {
      tickFontSize: 15, titleFontSize: 20, titleBold: true,
      xTickFontSize: 15, yTickFontSize: 15,
      axisLineWidth: 1.5, axisLineColor: '#000000', tickColor: '#000000', labelColor: '#333333',
      boxWidthMin: 55, boxWidthMax: 68, boxFillAlpha: 0.45, boxBorderWidth: 2, boxBorderDarken: 0.3,
      showRawPoints: true, rawPointSize: 4.5, showMean: true, meanSize: 10, meanColor: '#ffffff',
      meanBorderWidth: 1.5, meanBorderDarken: 0.3,
      layout: { gutter: 42, gutterPct: 10, vgap: 20, padTop: 10, padBottom: 8 },
      yMin: null, yMax: null, yInterval: null,
      yTitlePos: 'left', xLabelRotate: 0, xLabelGap: 0, yLabelGap: 0, xTitleGap: 0, yTitleGap: 0,
      xLabelOffset: 0
    },
    jv: {
      tickFontSize: 11, titleFontSize: 13, titleBold: true,
      xTickFontSize: 11, yTickFontSize: 11, // P5-收尾：拆分字段（t6 迁移遗漏 jv 命名空间）
      axisLineWidth: 1.5, axisLineColor: '#000000', tickColor: '#000000', labelColor: '#333333',
      jvRevLineWidth: 2, jvFwdLineWidth: 2, jvFwdDash: 'dashed', jvShowRefLine: true,
      jvShowLegend: true, jvLegendFontSize: 10, // 第三十四批：默认按用户设置（原 12）
      jvLegendOffsetX: 45, jvLegendOffsetY: -1, // 第三十四批：默认按用户设置（原 0/0）
      layout: { padLeft: 56, padRight: 20, padTop: 48, padBottom: 44 },
      yMin: null, yMax: null, yInterval: null,
      xMin: null, xMax: null, xInterval: null, // JV 额外横轴范围
      xLabelOffset: 0, // P5-收尾：X 标签偏移（JV 支持）
      yTitlePos: 'left', xTitlePos: 'bottom', xLabelGap: 0, yLabelGap: 0, xTitleGap: 0, yTitleGap: 0
    },
    jvOverlay: { // P5-4：多条件 JV 叠加独立命名空间（数据量大于单卡，格式与单 JV 隔离）
      tickFontSize: 11, titleFontSize: 15, titleBold: true,
      xTickFontSize: 11, yTickFontSize: 11, // P5-收尾
      axisLineWidth: 1.5, axisLineColor: '#000000', tickColor: '#000000', labelColor: '#333333',
      jvRevLineWidth: 2, jvFwdLineWidth: 2, jvFwdDash: 'dashed', jvShowRefLine: true,
      jvShowLegend: true, jvLegendFontSize: 11,
      jvLegendOffsetX: 380, jvLegendOffsetY: -50, // 用户设定：图例右对齐左移 384px（图中间偏右）、垂直 37.5%
      layout: { padLeft: 56, padRight: 20, padTop: 48, padBottom: 44 },
      yMin: null, yMax: null, yInterval: null,
      xMin: null, xMax: null, xInterval: null,
      xLabelOffset: 0, // P5-收尾
      yTitlePos: 'left', xTitlePos: 'bottom', xLabelGap: 0, yLabelGap: 0, xTitleGap: 0, yTitleGap: 0
    }
  };

  /** 调色板预设（origin = 当前 THEME.chart 微调色板，零回归；第三十七批（第三）新增 5 套：tableau10/set1/pastel1/dark2/paired） */
  var PALETTES = {
    origin: ['#8A8F98', '#E2574C', '#3B82F6', '#22A06B', '#E8912D', '#7C6BD9', '#2AA7B8', '#8D6E63', '#D4568F', '#7A9E42'],
    nature: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC', '#86BCB6', '#A0CBE8'],
    blue:   ['#1565C0', '#1976D2', '#1E88E5', '#2196F3', '#42A5F5', '#64B5F6', '#0D47A1', '#0277BD', '#0288D1', '#039BE5'],
    warm:   ['#E64A19', '#F4511E', '#FF5722', '#FF7043', '#FF8A65', '#BF360C', '#D84315', '#EC407A', '#AB47BC', '#7E57C2'],
    gray:   ['#37474F', '#455A64', '#546E7A', '#607D8B', '#78909C', '#90A4AE', '#263238', '#546E7A', '#78909C', '#90A4AE'],
    tableau10: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'],
    set1: ['#E41A1C', '#377EB8', '#4DAF4A', '#984EA3', '#FF7F00', '#FFFF33', '#A65628', '#F781BF', '#999999', '#66C2A5'],
    pastel1: ['#FBB4AE', '#B3CDE3', '#CCEBC5', '#DECBE4', '#FED9A6', '#FFFFCC', '#E5D8BD', '#FDDAEC', '#F2F2F2', '#B3E2CD'],
    dark2: ['#1B9E77', '#D95F02', '#7570B3', '#E7298A', '#66A61E', '#E6AB02', '#A6761D', '#666666', '#A6CEE3', '#1F78B4'],
    paired: ['#A6CEE3', '#1F78B4', '#B2DF8A', '#33A02C', '#FB9A99', '#E31A1C', '#FDBF6F', '#FF7F00', '#CAB2D6', '#6A3D9A']
  };

  /** 运行时样式（localStorage 加载，缺字段保留默认） */
  var chartStyle = loadChartStyle();
  /** 当前渲染图型的命名空间（第二十五批：build* 开头设置；轴函数读它，三种图参数独立） */
  var styleNS = chartStyle.single;

  function deepAssign(t, s) {
    Object.keys(s).forEach(function (k) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
        if (!t[k] || typeof t[k] !== 'object') t[k] = {};
        deepAssign(t[k], s[k]);
      } else {
        t[k] = s[k];
      }
    });
  }

  function loadChartStyle() {
    var s = {
      palette: 'origin',
      condColors: {},
      single: cloneNS(DEFAULT_CHART_STYLE.single),
      combined: cloneNS(DEFAULT_CHART_STYLE.combined),
      jv: cloneNS(DEFAULT_CHART_STYLE.jv),
      jvOverlay: cloneNS(DEFAULT_CHART_STYLE.jvOverlay) // P5-4
    };
    try {
      var raw = localStorage.getItem('jv_chart_style');
      if (raw) {
        var p = JSON.parse(raw);
        if (p.palette) s.palette = p.palette;
        if (p.condColors) s.condColors = p.condColors;
        // 问题3：jvOverlay 持久化（第 4 命名空间）——此前三处白名单漏掉，叠加图格式刷新即丢
        ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
          if (p[k]) deepAssign(s[k], p[k]);
        });
        // 第三十七批（第三）迁移：旧 labelGap 同时作用于横纵 → 拆分后两轴沿用旧值
        ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
          if (s[k].labelGap > 0 && !(s[k].xLabelGap > 0) && !(s[k].yLabelGap > 0)) {
            s[k].xLabelGap = s[k].labelGap; s[k].yLabelGap = s[k].labelGap;
          }
        });
        // t6 迁移：旧 tickFontSize → xTickFontSize/yTickFontSize（single/combined 仅箱线图拆分）
        ['single', 'combined'].forEach(function (k) {
          if (s[k].tickFontSize != null && s[k].xTickFontSize == null) {
            s[k].xTickFontSize = s[k].tickFontSize; s[k].yTickFontSize = s[k].tickFontSize;
          }
        });
      }
    } catch (e) {}
    return s;
  }

  function saveChartStyle() {
    try {
      localStorage.setItem('jv_chart_style', JSON.stringify({
        palette: chartStyle.palette,
        condColors: chartStyle.condColors,
        single: chartStyle.single,
        combined: chartStyle.combined,
        jv: chartStyle.jv,
        jvOverlay: chartStyle.jvOverlay // 问题3：第 4 命名空间持久化
      }));
    } catch (e) {}
  }

  function resetChartStyle() {
    chartStyle.palette = 'origin';
    chartStyle.condColors = {};
    chartStyle.single = cloneNS(DEFAULT_CHART_STYLE.single);
    chartStyle.combined = cloneNS(DEFAULT_CHART_STYLE.combined);
    chartStyle.jv = cloneNS(DEFAULT_CHART_STYLE.jv);
    chartStyle.jvOverlay = cloneNS(DEFAULT_CHART_STYLE.jvOverlay); // 问题3：第 4 命名空间重置
    saveChartStyle();
  }

  /** 第二十八批：用外部对象深合并设置 chartStyle（命名空间各深合，顶层字段合并；缺失保留默认） */
  function applyChartStyle(obj) {
    if (!obj) return;
    if (obj.palette) chartStyle.palette = obj.palette;
    if (obj.condColors) chartStyle.condColors = Object.assign({}, obj.condColors);
    ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (ns) { // 问题3：applyChartStyle 同步带上第 4 命名空间（导出 HTML 恢复）
      if (obj[ns]) chartStyle[ns] = Object.assign({}, DEFAULT_CHART_STYLE[ns], chartStyle[ns], obj[ns]);
    });
    saveChartStyle(); // 同步写回 localStorage（与手动调整一致）
  }

  function paletteColor(i) {
    var p = PALETTES[chartStyle.palette] || PALETTES.origin;
    return p[i % p.length];
  }

  /* ---------- 颜色工具 ---------- */
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
  }
  function darken(hex, ratio) {
    var c = hexToRgb(hex);
    var f = 1 - (ratio || 0.45);
    return 'rgb(' + Math.round(c.r * f) + ',' + Math.round(c.g * f) + ',' + Math.round(c.b * f) + ')';
  }

  /** 固定种子伪随机（保证每次渲染抖动位置一致，8.3） */
  function seeded(seed) {
    var x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /** 参数取值（统一入口 P.deviceParam，改动 1）：pce 走 userEff→反扫→正扫，其余反扫优先、正扫兜底。
   *  t4-2：额外支持等效电路参数（rs/rsh 直接取器件 given 值；n/j0 读 equiv_ui 预缓存的 _n/_j0，
   *  其中 _j0 已是 log₁₀ 值）——使 buildBoxplotOption 可直接为等效 4 图复用。 */
  function paramOf(key, device) {
    if (key === 'rs') return device ? device.rs : NaN;
    if (key === 'rsh') return device ? device.rsh : NaN;
    if (key === 'n') return device ? device._n : NaN;
    if (key === 'j0') return device ? device._j0 : NaN;
    return P.deviceParam(device, key);
  }

  /** 条件最高器件的正/反扫效率（格式 A 取统计区原值，格式 B 取标题效率） */
  function condEff(cond, which) {
    var d = cond.devices[cond.maxDeviceIndex];
    if (which === 'fwd') {
      if (d && P.isNum(d.rawFwdEff)) return d.rawFwdEff;
      return cond.titleFwdEff;
    }
    if (d && P.isNum(d.rawRevEff)) return d.rawRevEff;
    return cond.titleRevEff;
  }

  /** 单条件箱线图 5 分位 [下须, Q1, 中位, Q3, 上须]（自行计算，不用 dataTool） */
  function boxOf(values, whiskerMode) {
    var w = P.whiskers(values, whiskerMode || 'iqr');
    return [w.lower, w.stats.q1, w.stats.median, w.stats.q3, w.upper];
  }

  /** 数值轴范围：数据 min/max ± 5% padding（Origin 风格，让箱体占满轴空间提高可读性） */
  function axisRange(valuesList) {
    var min = Infinity, max = -Infinity, n = 0;
    for (var i = 0; i < valuesList.length; i++) {
      var vs = valuesList[i];
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j];
        if (P.isNum(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
          n++;
        }
      }
    }
    if (n === 0) return {};
    var pad = (max - min) * 0.05;
    if (!(pad > 0)) pad = Math.abs(max) * 0.05 || 1; // 全部值相同时给固定 padding
    return { min: min - pad, max: max + pad };
  }

  /** 刻度步长：span 的 1/2/2.5/5×10^k（目标约 5 个刻度），供轴范围吸附共用 */
  function niceStep(span) {
    if (!(span > 0)) return 1;
    var roughStep = span / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    var norm = roughStep / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }
  function snapDown(v, step) { return Math.floor(v / step) * step; }
  function snapUp(v, step) { return Math.ceil(v / step) * step; }

  /** 漂亮刻度轴范围（第十一批改动 2）：数据 ±8% padding → niceStep 吸附 → 非负钳制 →
   *  极端小范围保底。min/max 永远是 step 的整数倍（interval=step 时刻度从 min 起严格对齐，
   *  不再出现 19.33 这类非均匀刻度）；若吸附后数据占比 <50%（数据被压扁），逐档降 step 重算。
   *  返回 {min, max, step}，调用方显式设 interval=step */
  function niceAxisRange(valuesList) {
    // 展平取极值（调用方已过滤未排除器件）
    var flat = [];
    valuesList.forEach(function (arr) { arr.forEach(function (v) { if (P.isNum(v)) flat.push(v); }); });
    if (!flat.length) return { min: undefined, max: undefined, step: undefined };
    var dataMin = Math.min.apply(null, flat);
    var dataMax = Math.max.apply(null, flat);
    var span = dataMax - dataMin;
    if (!(span > 0)) span = Math.abs(dataMax) * 0.1 || 1;
    var rawMin = dataMin - span * 0.08;
    var rawMax = dataMax + span * 0.08;
    // 逐档收窄目标范围（→ 更细步长）直到数据占比 ≥50%，保证整数倍对齐且数据不被压扁
    var step = niceStep(rawMax - rawMin);
    var min, max;
    for (var i = 0; i < 8; i++) {
      min = snapDown(rawMin, step);
      max = snapUp(rawMax, step);
      if ((dataMax - dataMin) / (max - min) >= 0.5) break;
      step = niceStep((rawMax - rawMin) * (0.5 + 0.08 * i)); // 目标范围缩小 → 步长变细
    }
    // 非负钳制：数据全 ≥0 时轴不许从负数开始（0 是任何 step 的整数倍，不破坏对齐）
    if (dataMin >= 0) min = Math.max(0, min);
    // 极端小范围保底
    if (max - min < step) max = min + step;
    return { min: min, max: max, step: step };
  }

  /** 四边框轴（Origin 风格）：底部/顶部 x 轴 + 左侧/右侧 y 轴 */
  function axisLineStyle(sc) {
    // 第二十四批：读 chartStyle（格式修改1 后默认 1.5px 纯黑）；第二十五批：读当前图型命名空间
    var st = styleNS || chartStyle.single;
    return { color: st.axisLineColor, width: S(st.axisLineWidth, sc || 1) };
  }
  /** 条件名 x 轴（第十一批改动 3）：所有条件名全部显示（interval 恒 0，绝不间隔抽取——
   *  用户明确「吞标签万万不可」）；>6 条件 rotate -30°（顺时针防边界裁剪）；fontSize 绝对像素；
   *  条件名 >12 字符截断加省略号（data 保留完整名供 tooltip）
   *  hideLabels（第二十一批）：迷你对比图隐藏全部刻度文字 */
  function baseXAxis(names, isTop, fontSize, hideLabels, sc, rotateOverride, truncate) {
    var n = names ? names.length : 0;
    var st = styleNS || chartStyle.single;
    // 第三十七批（第三）：X 标签旋转可调（xLabelRotate；0/null=按条件数自动 -30/-20/0）
    // 问题4（PDF 标签粘连）：rotateOverride（PDF 大旋转角）+ truncate 覆盖优先于样式值
    var autoRotate = n > 6 ? -30 : (n > 3 ? -20 : 0);
    var rotate = rotateOverride != null ? -rotateOverride : (st.xLabelRotate > 0 ? -st.xLabelRotate : autoRotate);
    var maxLen = truncate || 12;
    var ax = {
      type: 'category',
      data: names,
      position: isTop ? 'top' : 'bottom',
      axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) }, // onZero:false 保证轴线画在网格边缘而非 0 刻度处（否则 PCE 上框线消失）
      axisTick: { show: !hideLabels, inside: true, lineStyle: { color: st.tickColor } }, // 第二十四批：读 chartStyle
      axisLabel: (function () {
        var lb = {
          show: !hideLabels,
          fontSize: fontSize,
          color: st.labelColor, // 第二十四批：标签颜色
          interval: 0, // 全显示，不间隔抽取
          rotate: rotate,
          // 第二十三批修正：X 标签不做斜体（用户确认参考图非斜体；旋转即可区分）
          // 问题4：截断长度由调用方覆盖（PDF 窄渲染 8 字符；页面默认 12）
          formatter: function (v) { return String(v).length > maxLen ? String(v).slice(0, maxLen) + '…' : String(v); }
        };
        // 第三十七批（第三）根修：margin 必须 >0 才设属性——显式 undefined 会让 ECharts
        // containLabel 布局计算异常（plot 区被压没 → 只显示轴线、系列不渲染）；属性缺失=默认 5
        if (st.xLabelGap > 0) lb.margin = S(st.xLabelGap, sc);
        return lb;
      })(),
      splitLine: { show: false }
    };
    if (isTop) ax.axisLabel.show = false;
    return ax;
  }
  /** Y 轴标题：'left'（纵轴左侧纵向，行业惯例/默认）| 'top'（轴上方）。
   *  第十七批：所有尺寸参数经 S() 缩放；nameGap 由调用处 yTitleLayout 动态算好传入（不写死）
   *  第三十七批（第三）：styleNS.yTitlePos（'left'/'right'）优先于 axisTitlePos 参数——轴左右侧切换 */
  function yAxisTitle(axisTitlePos, titleFontSize, nameGap, sc) {
    var s = sc || 1;
    var fs = titleFontSize || S(14, s);
    var fw = (styleNS || chartStyle.single).titleBold ? 'bold' : 'normal'; // 第二十四批：读 chartStyle
    var pos = (styleNS && styleNS.yTitlePos) || axisTitlePos || 'left';
    if (pos === 'top') { // 兼容历史 'top' 语义（轴上方）
      return {
        position: 'top',
        nameLocation: 'end',
        nameTextStyle: { fontSize: fs, fontWeight: fw, fontFamily: FONT, align: 'left', padding: [0, 0, S(2, s), S(-8, s)] }
      };
    }
    return {
      position: pos === 'right' ? 'right' : 'left',
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: nameGap || S(38, s),
      nameTextStyle: { fontSize: fs, fontWeight: fw, fontFamily: FONT }
    };
  }

  /** 尺寸缩放：所有绝对像素尺寸统一经此函数（第十七批：导出=网页观感的唯一机制）。
   *  ECharts 一切尺寸皆绝对像素，不随容器缩放；scale=目标容器宽÷页面设计基准宽。 */
  function S(v, sc) { return Math.round(v * sc * 10) / 10; }

  /** 文本实测宽度（canvas measureText 精确；SSR/Node 回退 0.6em 估算） */
  function textWidth(str, fontSize) {
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        var c = document.createElement('canvas');
        var ctx = c.getContext && c.getContext('2d');
        if (ctx && ctx.measureText) {
          ctx.font = fontSize + 'px Arial';
          return ctx.measureText(str).width;
        }
      }
    } catch (e) { /* 回退估算 */ }
    return String(str).length * fontSize * 0.6;
  }

  /** X 轴标签竖向占用（第十九批，单图/合并图导出共用）：
   *  rotate 时高 = 最长标签宽×sin(|rotate|) + fontSize×cos + margin；最长 = 截断后 13 字符（12+…），M 最宽。
   *  全部已按 sc 缩放（fs = S(12.5, sc)，与 buildBoxplotOption 一致）。 */
  function xLabelSpace(sc, count, names, rotateOverride, truncate) {
    var st = styleNS || chartStyle.single;
    var autoRotate = count > 6 ? -30 : (count > 3 ? -20 : 0);
    var rotate = rotateOverride != null ? -rotateOverride : (st.xLabelRotate > 0 ? -st.xLabelRotate : autoRotate); // 问题4：PDF override 优先
    var fs = S(12.5, sc);
    if (rotate === 0) return fs + S(8, sc) + S(4, sc);
    var rad = Math.abs(rotate) * Math.PI / 180;
    // 用实际最长标签（截断后）而非假设 13 字符——短标签不虚占行距/中缝（十九批）
    var longest = 'MMMMMMMMMMMM…';
    if (names && names.length) {
      var mx = '';
      var maxL = truncate || 12; // 问题4：截断覆盖
      names.forEach(function (n) {
        var s2 = String(n);
        if (s2.length > maxL) s2 = s2.slice(0, maxL) + '…';
        if (s2.length > mx.length) mx = s2;
      });
      if (mx) longest = mx;
    }
    return Math.ceil(textWidth(longest, fs) * Math.sin(rad) + fs * Math.cos(rad)) + S(6, sc) + S(3, sc); // 标签高 + 呼吸间距（十九批收紧）
  }

  /** X 轴标签旋转后的横向伸出量（第二十批，修单图最右/最左标签被画布裁剪）：
   *   rotate 时最长标签（截断后）绕中心旋转，中心贴 plot 边缘，向 plot 外伸出 ≈ W/2·|cos| + fs/2·|sin|。
   *   left/right 边距需 ≥ 该值，否则长条件名（如 "DCz:Me-4P(base)"）被容器裁掉。 */
  function xLabelReach(sc, names, rotateOverride, truncate) {
    var st = styleNS || chartStyle.single;
    var n = names ? names.length : 0;
    var autoRotate = n > 6 ? 30 : (n > 3 ? 20 : 0);
    var rotate = rotateOverride != null ? rotateOverride : (st.xLabelRotate > 0 ? st.xLabelRotate : autoRotate); // 问题4：PDF override 优先
    if (!rotate) return 0;
    var fs = S(12.5, sc);
    var longest = 'MMMMMMMMMMMM…';
    if (names && names.length) {
      var mx = '';
      var maxL = truncate || 12; // 问题4：截断覆盖
      names.forEach(function (s2) {
        var t = String(s2);
        if (t.length > maxL) t = t.slice(0, maxL) + '…';
        if (t.length > mx.length) mx = t;
      });
      if (mx) longest = mx;
    }
    var W = textWidth(longest, fs);
    var rad = rotate * Math.PI / 180;
    return Math.ceil(W * Math.cos(rad) * 0.5 + fs * Math.sin(rad) * 0.5) + S(6, sc); // 伸出 + 呼吸
  }

  /** 按实际刻度标签计算 Y 轴标题 nameGap 与左侧预留（第十七批 + 裁剪根修）：
   *  标签宽用 measureText 实测（0.6em 估算偏小致标题左缘被画布裁掉——用户实测「PCE (%)」缺 P）；
   *  leftReserve 加 0.7 倍标题半宽 + 8px 保险。labels: 刻度标签数组；tickFs/titleFs/margin: 已缩放值 */
  function yTitleLayout(labels, tickFs, titleFs, margin, sc) {
    var st = styleNS || chartStyle.single;
    var longest = '0.00';
    labels.forEach(function (t) { if (String(t).length > longest.length) longest = String(t); });
    var labelW = textWidth(longest, tickFs);       // 实测最长标签宽
    // 第三十七批（第三）：标题间距手动覆盖（yTitleGap>0 直接采用；否则自动按标签宽）
    var nameGap = st.yTitleGap > 0 ? S(st.yTitleGap, sc || 1) : Math.ceil(margin + labelW + titleFs * 0.5 + 4);
    var leftReserve = Math.ceil(nameGap + titleFs * 0.7 + 8);     // 标题左缘不越出画布（保险）
    return { nameGap: nameGap, leftReserve: leftReserve };
  }

  /** 生成 value 轴刻度标签字符串（toFixed(2)，用于 yTitleLayout） */
  function tickLabels(min, max, step) {
    var out = [];
    if (!(step > 0) || !isFinite(step)) step = 1;
    var guard = 0;
    for (var v = min; v <= max + 1e-9 && guard < 2000; v += step, guard++) out.push(v.toFixed(2)); // 第三十七批（第三）：上限防御（极小增量防卡死）
    return out;
  }

  /** 第三十七批（第三）：Y 轴手动范围覆盖——用户给 yMin/yMax/yInterval 时直接采用（不再吸附），缺省回退自动 */
  function applyYRange(st, range) {
    if (!st || range.min === undefined) return range;
    return {
      min: st.yMin != null ? st.yMin : range.min,
      max: st.yMax != null ? st.yMax : range.max,
      step: (st.yInterval != null && st.yInterval > 0) ? st.yInterval : range.step
    };
  }

  /** V2 收尾：合并图 Y 轴按参数单独覆盖（yRanges = { pce:{min,max,interval}, ... }，优先；否则全局 yMin/yMax/yInterval） */
  function applyYRangeForKey(k, st, range) {
    var kr = st.yRanges && st.yRanges[k];
    var hasK = kr && (kr.min != null || kr.max != null || kr.interval != null);
    if (hasK) return applyYRange({ yMin: kr.min, yMax: kr.max, yInterval: kr.interval }, range);
    var hasG = st.yMin != null || st.yMax != null || st.yInterval != null;
    return hasG ? applyYRange(st, range) : range;
  }

  /** 箱线图 Y 轴：tickFs 刻度字号、titleFs 标题字号（均已缩放，调用处算好分开传入，
   *  不再函数内 +2 避免与缩放叠加歧义）；nameGap 由调用处 yTitleLayout 传入
   *  hideLabels（第二十一批）：迷你对比图隐藏刻度标签与标题 */
  function baseYAxis(title, tickFs, titleFs, axisTitlePos, nameGap, sc, hideLabels) {
    var tt = yAxisTitle(axisTitlePos, titleFs, nameGap, sc);
    var st = styleNS || chartStyle.single;
    var ax = {
      type: 'value',
      position: tt.position, // 第三十七批（第三）：yTitlePos 左/右
      name: hideLabels ? '' : title,
      nameLocation: tt.nameLocation,
      nameRotate: tt.nameRotate,
      nameGap: tt.nameGap,
      nameTextStyle: tt.nameTextStyle,
      axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) }, // onZero:false 保证轴线画在网格边缘而非 0 刻度处（否则 PCE 上框线消失）
      axisTick: { show: !hideLabels, inside: true, lineStyle: { color: st.tickColor } }, // 第二十四批：读 chartStyle
      axisLabel: { show: !hideLabels, fontSize: tickFs, color: st.labelColor, margin: st.yLabelGap > 0 ? S(st.yLabelGap, sc || 1) : S(8, sc || 1), formatter: function (v) { return v.toFixed(2); } }, // 第七批：两位小数；第十九批：标签与框线留呼吸感；第二十四批：标签颜色；第三十七批（第三）yLabelGap 可调
      splitLine: { show: false }
    };
    return ax;
  }
  /** log 轴（t4-2）：等效 Rsh 图跨数量级用。仿 baseYAxis 但 type:'log'，刻度标签精简，不套 niceAxisRange。 */
  function baseLogYAxis(title, tickFs, titleFs, axisTitlePos, nameGap, sc, hideLabels) {
    var tt = yAxisTitle(axisTitlePos, titleFs, nameGap, sc);
    var st = styleNS || chartStyle.single;
    return {
      type: 'log', logBase: 10,
      position: tt.position,
      name: hideLabels ? '' : title,
      nameLocation: tt.nameLocation,
      nameRotate: tt.nameRotate,
      nameGap: tt.nameGap,
      nameTextStyle: tt.nameTextStyle,
      axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) },
      axisTick: { show: !hideLabels, inside: true, lineStyle: { color: st.tickColor } },
      axisLabel: { show: !hideLabels, fontSize: tickFs, color: st.labelColor, margin: st.yLabelGap > 0 ? S(st.yLabelGap, sc || 1) : S(8, sc || 1), formatter: logTick },
      splitLine: { show: false }
    };
  }
  /** log 轴刻度标签精简（1000→1.0k、10000→10k） */
  function logTick(v) {
    if (!isFinite(v) || v <= 0) return '';
    if (v >= 10000) return (v / 1000).toFixed(0) + 'k';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 1) return v.toFixed(1);
    return v.toExponential(1);
  }
  /** 空框轴：补全上/右边框线。isTop 用 category 类型（dataArr 传入与主轴相同的类目数组，
   *   否则空类目数组可能让上框线渲染成零宽/残段——第六批修复） */
  function emptyAxis(isTop, dataArr, sc) {
    return {
      type: isTop ? 'category' : 'value',
      position: isTop ? 'top' : 'right',
      show: true,
      axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
      data: isTop ? (dataArr || []) : undefined
    };
  }

  /** 数值轴边框轴（JV 图用）：与主轴同类型的满宽框线（value min/max 决定线长）。
   *  onZero 必须在 axisLine 对象内（ECharts 读 axisLine.onZero）——否则轴线默认画在 0 位置，
   *  JV 图 X/Y 都含 0 时会变成中心十字而不是边框 */
  function valueFrameAxis(position, min, max, sc) {
    return {
      type: 'value',
      position: position,
      min: min,
      max: max,
      show: true,
      axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false }
    };
  }

  /** 器件是否参与（排除过滤，改动 1；优先用 JVTable.isActive） */
  function isActiveDev(d) {
    if (global.JVTable && global.JVTable.isActive) return global.JVTable.isActive(d);
    return !d.excluded;
  }

  /** 某一参数的全部系列（箱体 + 原始点 + 均值），挂在指定 grid/轴
   *   gridIdx 为 grid 序号；轴数组索引 = gridIdx*2（主轴）与 gridIdx*2+1（边框轴）
   *   boxplot 必须用「一个系列 + 每组数据带 itemStyle」，第 k 组对应类目 k；
   *   若拆成每条件一个系列，ECharts 会把各系列的 data[0] 都画在类目 0（箱体重叠）
   *   已排除器件不参与统计与散点；某条件全部排除时该组用透明占位（保持对齐） */
  /** V3：Y 轴范围截断（用户调 Y 范围后只显示范围内部分；boxplot 不支持 clip，数据层实现）
   *  规则（Origin 语义）：端点 clamp 到 [min,max]（超界须/箱贴边界=截断显示）；
   *  Q1..Q3 整箱在界外 → 隐藏（占位透明保持类目对齐）；散点/均值超界 → 过滤。
   *  only 手动设置范围才生效（自动范围天然包含全部数据，不裁剪）。 */
  function clipYRange(values5, yMin, yMax) {
    if (yMin === undefined && yMax === undefined) return { list: values5, show: true };
    var lo = yMin !== undefined ? yMin : -Infinity;
    var hi = yMax !== undefined ? yMax : Infinity;
    var min = values5[0], q1 = values5[1], q3 = values5[3], max = values5[4];
    // 整箱（Q1..Q3）完全在界外 → 不显示
    if (q3 < lo || q1 > hi) return { list: values5, show: false };
    var cl = function (v) { return v < lo ? lo : (v > hi ? hi : v); };
    return {
      list: [cl(min), cl(q1), cl(values5[2]), cl(q3), cl(max)],
      show: true,
      orig: values5.slice(0) // 保留原始统计值（tooltip 用）
    };
  }

  function seriesFor(paramKey, conditions, opts, gridIdx, yRange) {
    var series = [];
    var boxData = [], scatter = [], mean = [];
    var xAxisIndex = gridIdx * 2, yAxisIndex = gridIdx * 2;
    var sc = opts.scale || 1; // 第十七批：尺寸缩放
    // 第二十五批：读当前图型命名空间（build* 经 opts.styleNs 传入；缺省回退 single）
    var st = (opts && opts.styleNs) || chartStyle.single;
    // V3：Y 轴范围截断（手动设置时生效；自动范围天然涵盖全部数据无副作用）
    var yMin = yRange ? yRange.min : undefined, yMax = yRange ? yRange.max : undefined;
    conditions.forEach(function (cond, i) {
      // 第二十五批：条件色优先 condColors[displayName||name]，否则调色板
      var ckey = cond.displayName || cond.name;
      var color = (chartStyle.condColors && chartStyle.condColors[ckey])
        ? chartStyle.condColors[ckey]
        : (opts.chartColor ? opts.chartColor(i) : paletteColor(i));
      var active = cond.devices.filter(isActiveDev); // 改动 1：排除过滤
      var values = active.map(function (d) { return paramOf(paramKey, d); }).filter(P.isNum);
      if (values.length) {
        // 第二十四批：箱体全部读 chartStyle（填充透明度/描边加深/描边宽）
        var v5 = boxOf(values, opts.whisker);
        var clip = clipYRange(v5, yMin, yMax);
        if (clip.show) {
          boxData.push({
            value: clip.list,
            _orig: clip.orig, // 原始统计值（tooltip 用，不显示 clamp 假值）
            itemStyle: {
              color: rgba(color, st.boxFillAlpha),
              borderColor: darken(color, st.boxBorderDarken),
              borderWidth: S(st.boxBorderWidth, sc)
            }
          });
        } else {
          // 整箱超出 Y 范围：占位透明（类目对齐，不崩）
          boxData.push({ value: [NaN, NaN, NaN, NaN, NaN], itemStyle: { opacity: 0 } });
        }
      } else {
        // 全部被排除：透明占位（组与类目对齐，不崩）
        boxData.push({ value: [NaN, NaN, NaN, NaN, NaN], itemStyle: { opacity: 0 } });
      }
      // 原始数据点：条件色实心小圆 + 固定种子水平抖动（排除器件跳过；超 Y 范围滤掉——只看有价值部分）
      active.forEach(function (d, di) {
        var v = paramOf(paramKey, d);
        if (!P.isNum(v)) return;
        if (yMin !== undefined && v < yMin) return;
        if (yMax !== undefined && v > yMax) return;
        var jitter = (seeded(i * 31 + di * 17 + (paramKey === 'pce' ? 0 : 13)) - 0.5) * 0.6;
        scatter.push({ value: [i + jitter, v], itemStyle: { color: color } });
      });
      // 均值（data 项覆盖 series 级；读 chartStyle 颜色/描边；超 Y 范围滤掉）
      var stats = P.boxStats(values);
      if (P.isNum(stats.mean) && (yMin === undefined || stats.mean >= yMin) && (yMax === undefined || stats.mean <= yMax)) {
        mean.push({
          value: [i, stats.mean],
          itemStyle: {
            color: st.meanColor,
            borderColor: darken(color, st.meanBorderDarken),
            borderWidth: S(st.meanBorderWidth, sc)
          }
        });
      }
    });
    series.push({
      name: '箱线图',
      type: 'boxplot',
      xAxisIndex: xAxisIndex,
      yAxisIndex: yAxisIndex,
      data: boxData,
      boxWidth: [st.boxWidthMin + '%', st.boxWidthMax + '%'] // 第二十四批：读 chartStyle
    });
    // 注：中位线由 boxplot 自带（颜色 = 箱体描边 darken(条件色, boxBorderDarken)）。第二十三批曾叠加深灰 line 系列
    // 画中位线，但 line 会把相邻箱的端点相连（箱间出现横线 bug），已回滚（第二十三批修正）。
    // 第二十四批：显隐由 chartStyle.showRawPoints 与 opts.rawPoints 共同决定（复选框读写 chartStyle）
    if (st.showRawPoints && opts.rawPoints !== false) {
      series.push({
        name: '原始数据点', type: 'scatter', xAxisIndex: xAxisIndex, yAxisIndex: yAxisIndex,
        data: scatter, symbol: 'circle', symbolSize: S(st.rawPointSize, sc)
      });
    }
    if (st.showMean && opts.meanMark !== false) {
      series.push({
        name: '均值', type: 'scatter', xAxisIndex: xAxisIndex, yAxisIndex: yAxisIndex,
        data: mean, symbol: 'rect', symbolSize: S(st.meanSize, sc),
        itemStyle: { color: st.meanColor, borderColor: st.tickColor, borderWidth: S(st.meanBorderWidth, sc) } // series 级兜底，data 项覆盖
      });
    }
    return series;
  }

  /** 通用 tooltip：hover 显示条件名与数据摘要（条件多、X 轴标签间隔时定位具体条件） */
  function boxTooltip() {
    return {
      trigger: 'item',
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: '#C6CFDC',
      textStyle: { color: '#1F2329', fontSize: 12, fontFamily: FONT },
      formatter: function (params) {
        if (params.seriesType === 'boxplot') {
          var v = (params.data && params.data._orig) ? params.data._orig : params.value; // V3：优先原始统计值（Y 截断不显示假值）
          var name = params.name || '';
          return '<b>' + name + '</b><br/>' +
            '下须 ' + P.roundSigText(v[0]) + '<br/>' +
            'Q1 ' + P.roundSigText(v[1]) + '<br/>' +
            '中位数 ' + P.roundSigText(v[2]) + '<br/>' +
            'Q3 ' + P.roundSigText(v[3]) + '<br/>' +
            '上须 ' + P.roundSigText(v[4]);
        }
        var val = params.value && params.value[1] != null ? params.value[1] : params.value;
        return (params.seriesName || '') + '<br/>' + (params.name != null ? params.name + ': ' : '') + P.roundSigText(val);
      }
    };
  }

  /** 单张箱线图 option（纯函数，可无头渲染/测试）
   *  opts.hideAxisLabels：迷你对比图模式——隐藏 X/Y 刻度标签与 Y 标题，只留箱体/须线/散点/均值
   *  （HTML 层的标题与图例代替文字，规避小格子里矢量文字过小不可读） */
  function buildBoxplotOption(paramKey, conditions, opts) {
    opts = opts || {};
    var sc = opts.scale || 1; // 第十七批：尺寸缩放（页面=1；导出/灯箱按容器宽÷设计基准）
    // 第二十五批：单图命名空间（PDF 箱线图同源）
    // t5：可选 opts.styleNs —— equiv 4 图传「主图样式+独立覆盖」合并对象；不传回退 chartStyle.single（主图/PDF 行为不变）
    var st = opts.styleNs || chartStyle.single;
    styleNS = st;
    opts.styleNs = st;
    var names = conditions.map(function (c) { return c.displayName || c.name; });
    // Y 轴：漂亮刻度范围（吸附 1/2/2.5/5×10^k 步长整数倍），标签 roundSigText 格式化
    var valuesList = conditions.map(function (c) { return c.devices.filter(isActiveDev).map(function (d) { return paramOf(paramKey, d); }); });
    // t4-2：logY（Rsh 跨数量级）时不套 niceAxisRange 的线性 min/max/interval，交给 ECharts log 轴自动
    var range = opts.logY ? { min: undefined } : applyYRange(st, niceAxisRange(valuesList)); // 第三十七批（第三）：Y 轴手动覆盖
    // 第十七批：nameGap 按实际刻度标签动态计算 + grid.left 保底（修 Y 标题裁剪/贴标签）
    var yTickFs = S(st.yTickFontSize != null ? st.yTickFontSize : st.tickFontSize, sc); // t6：Y 刻度字号（拆分后独立；旧 tickFontSize 回退）
    var xTickFs = S(st.xTickFontSize != null ? st.xTickFontSize : st.tickFontSize, sc); // t6：X 刻度字号
    var titleFs = S(st.titleFontSize, sc); // 第二十四批：读 chartStyle
    var tickFs = yTickFs; // 别名：yTitleLayout/Y 轴沿用 y
    var lay = { nameGap: S(38, sc), leftReserve: S(60, sc) };
    if (range.min !== undefined) {
      var labels = tickLabels(range.min, range.max, range.step);
      lay = yTitleLayout(labels, tickFs, titleFs, S(8, sc));
    }
    var yMain;
    if (opts.logY) {
      yMain = baseLogYAxis(Y_TITLES[paramKey], tickFs, titleFs, opts.axisTitlePos, lay.nameGap, sc, opts.hideAxisLabels);
    } else {
      yMain = baseYAxis(Y_TITLES[paramKey], tickFs, titleFs, opts.axisTitlePos, lay.nameGap, sc, opts.hideAxisLabels);
      if (range.min !== undefined) { yMain.min = range.min; yMain.max = range.max; yMain.interval = range.step; } // 第九批：显式 interval=step 刻度等距
    }
    // 第二十批：页面/导出一律显式内容盒边距（containLabel 不处理旋转标签与轴标题 name）：
    // left 留 y 轴标题（leftReserve）且 ≥ 旋转伸出；right 留最右标签旋转伸出；
    // bottom 留旋转标签高度；top 留呼吸。全部已按 sc 缩放（页面 scale=1）
    var grid;
    if (opts.hideAxisLabels) {
      // 迷你图：无文字，边距只留框线与呼吸（第二十一批）
      grid = { left: S(8, sc), right: S(6, sc), top: S(6, sc), bottom: S(6, sc), containLabel: false };
    } else {
      var pdfRot = opts.pdfLabelRotate || 0; // 问题4：PDF 强制大旋转角（标签粘连修复）
      var pdfTrunc = opts.pdfLabelTruncate || 0; // 问题4：PDF 截断长度覆盖
      var reach = xLabelReach(sc, names, pdfRot || undefined, pdfTrunc || undefined);
      var LS = st.layout; // 第二十五批：读单图命名空间 layout
      grid = {
        left: Math.max(lay.leftReserve, reach) + S(st.xLabelOffset || 0, sc), // t6：X 轴横向偏移微调（旋转标签对齐）
        right: Math.max(S(LS.padRight, sc), reach),
        top: S(LS.padTop, sc),
        bottom: Math.max(S(LS.padBottom, sc), Math.ceil(xLabelSpace(sc, names.length, names, pdfRot || undefined, pdfTrunc || undefined) * 1.1) + 3),
        containLabel: false
      };
      if (opts.__pageMode) {
        // V2 收尾：单图页面 plot 高恒定（宽度受卡片布局限制），容器高度自适应
        grid.height = SB_PLOT_H0;
        grid.__needH = Math.round(grid.top + SB_PLOT_H0 + grid.bottom);
      }
    }
    return {
      backgroundColor: '#ffffff',
      textStyle: { fontFamily: FONT },
      animation: opts.exportMode ? false : undefined, // 根修：离屏导出关动画（否则新建实例同步取 SVG 是动画首帧=无数据）
      tooltip: opts.hideAxisLabels ? undefined : boxTooltip(),
      grid: grid,
      xAxis: [baseXAxis(names, false, xTickFs, opts.hideAxisLabels, sc, (opts.pdfLabelRotate || 0) || undefined, (opts.pdfLabelTruncate || 0) || undefined), emptyAxis(true, names, sc)], // t6：X 刻度字号独立
      yAxis: [yMain, emptyAxis(false, undefined, sc)],
      series: seriesFor(paramKey, conditions, opts, 0, range) // V3：传 Y 范围（截断超界箱体/散点/均值）
    };
  }

  /** 单张箱线图（V2 收尾：页面模式 plot 高恒定、容器高度自适应） */
  function renderBoxplot(dom, paramKey, conditions, opts) {
    opts = opts || {};
    if (!opts.exportMode && dom) {
      opts = Object.assign({}, opts, { __pageMode: true });
    }
    var opt = buildBoxplotOption(paramKey, conditions, opts);
    if (opt && opt.grid && opt.grid.__needH && dom) {
      var curH = dom.offsetHeight || 0;
      if (Math.abs(curH - opt.grid.__needH) > 4) dom.style.height = opt.grid.__needH + 'px';
    }
    var chart = echarts.init(dom, null, { renderer: 'svg' });
    chart.setOption(opt);
    return chart;
  }

  /** 2×2 合并图 option（第十一批改动 3：Origin 科研风格——四格等大对称、X 标签四格全显示、
   *  Y 标题竖向对齐。第十七批：全部尺寸经 S() 缩放，像素 grid 乘 sc、left 保底） */
  function buildCombinedOption(conditions, opts) {
    opts = opts || {};
    var sc = opts.scale || 1; // 第十七批：尺寸缩放
    // 第二十五批：合并图命名空间（字号偏移已固化进默认值，此处直接读）
    var st = chartStyle.combined;
    styleNS = st;
    opts.styleNs = st;
    var names = conditions.map(function (c) { return c.displayName || c.name; });
    var keys = ['pce', 'voc', 'jsc', 'ff'];
    // 每格 Y 范围与 nameGap 动态布局（四格各算各的：标题都在各自标签左侧贴齐）
    var ranges = [], lays = [];
    var yTickFs = S(st.yTickFontSize != null ? st.yTickFontSize : st.tickFontSize, sc); // t6：Y 刻度字号
    var xFs = S(st.xTickFontSize != null ? st.xTickFontSize : st.tickFontSize, sc); // t6：X 刻度字号
    var tickFs = yTickFs;
    var titleFs = S(st.titleFontSize, sc); // X 标签字号 = 合并图刻度字号（与旧行为一致）
    keys.forEach(function (k) {
      var valuesList = conditions.map(function (c) { return c.devices.filter(isActiveDev).map(function (d) { return paramOf(k, d); }); });
      var range = applyYRangeForKey(k, st, niceAxisRange(valuesList)); // V2 收尾：Y 轴 per-key（4 参数分开调）
      ranges.push(range);
      if (range.min !== undefined) lays.push(yTitleLayout(tickLabels(range.min, range.max, range.step), tickFs, titleFs, S(8, sc), sc));
      else lays.push({ nameGap: S(50, sc), leftReserve: S(80, sc) });
    });
    // 四格 nameGap 统一取最大（第十九批；第二十批提前到 grids 之前算，布局要依赖它）
    var allNameGap = Math.max(lays[0].nameGap, lays[1].nameGap, lays[2].nameGap, lays[3].nameGap);
    // 四格等大、横竖严格对齐（第十九批：内容盒模型）——grid 只决定 plot 区；
    // 刻度标签/轴标题空间显式算进 ML/MR/MT/MB，两套坐标系合一（FF 标题压框线、右列标签截肢同愈）
    var grids;
    if (opts.exportMode) {
      var W = opts.exportW || 1400, H = opts.exportH || 980;  // 容器尺寸由 main.js 传入（改尺寸只动 main.js 一处）
      var LC = st.layout; // 第二十五批：读合并图命名空间 layout
      var allLay = Math.max(lays[0].leftReserve, lays[1].leftReserve, lays[2].leftReserve, lays[3].leftReserve);
      var ML = Math.max(S(8, sc), allLay);                    // 左缘：四格标题取最大，Y 标题同一条竖线
      // 标签空间保险系数 1.2+4：浏览器 canvas 实测标签宽大于 SSR 0.6em 估算（'M'≈0.7em），贴边会被切
      var pdfRot2 = opts.pdfLabelRotate || 0; // 问题4：PDF 强制大旋转角（标签粘连修复）
      var XLBL = Math.ceil(xLabelSpace(sc, names.length, names, pdfRot2 || undefined) * 1.1) + 3;
      var MR = Math.max(S(8, sc), XLBL);                     // 右缘：X 标签旋转伸出 plot 的部分
      var MT = S(LC.padTop, sc);
      var MB = Math.max(S(LC.padBottom, sc), XLBL);          // 下缘：X 标签
      var GUT = S(LC.gutter, sc);                             // 中缝：像素基数（第二十四批读 layout）
      var VGAP = S(LC.vgap, sc);                              // 行距
      // 中缝防长标签伸入：rotate -30° 时标签右缘相对 tick 伸出 ≈ 宽×cos(30°)×0.5
      var rot = names.length > 6 ? 30 : (names.length > 3 ? 20 : 0);
      if (rot > 0) {
        var mx2 = 'MMMMMMMMMMMM…';
        names.forEach(function (n) { var s3 = String(n); if (s3.length > 12) s3 = s3.slice(0, 12) + '…'; if (s3.length > mx2.length) mx2 = s3; });
        var reach = textWidth(mx2, S(12.5, sc)) * Math.cos(rot * Math.PI / 180) * 0.5 + 4;
        GUT = Math.max(GUT, reach);
      }
      // 第二十批：中缝还需容纳右列 y 轴标题——标题中心在右列 grid.left − allNameGap，左缘再减标题半宽，
      // 必须 ≥ 左列 plot 右缘，否则「Voc (V)」「FF (%)」伸进左图（用户实测复制/放大后右列标题与左图重叠）
      var titleHalf = Math.ceil(titleFs * 0.5);
      GUT = Math.max(GUT, Math.ceil(allNameGap) + titleHalf + S(8, sc));
      // 格式修改1/第二十四批：中缝占整图宽 gutterPct%（页面 + 导出保底）
      GUT = Math.max(GUT, Math.round(W * LC.gutterPct / 100));
      // 行间总空间 = 上排 X 标签高 + 微距（上排旋转标签画在 plot 下方，必须预留——否则伸进下排图重叠）
      var VROW = XLBL + VGAP;
      // V2 收尾：__pageMode 子图尺寸恒定（PLOT_W0/PLOT_H0 基准），容器整卡随内容自适应（图变大/变小，plot 不变形）
      var plotW, plotH, __needW, __needH;
      if (opts.__pageMode) {
        plotW = PLOT_W0;
        plotH = PLOT_H0;
        __needW = Math.round(ML + MR + GUT + 2 * plotW);
        __needH = Math.round(MT + MB + VROW + 2 * plotH);
      } else {
        plotW = (W - ML - MR - GUT) / 2;
        plotH = (H - MT - MB - VROW) / 2;
      }
      var xOff = S(st.xLabelOffset || 0, sc); // t6：X 轴横向偏移（导出/灯箱/PDF 像素 grid 生效；页面百分比 grid 由 xLabelRotate 调节）
      grids = [
        { left: ML + xOff,         width: plotW, top: MT,                 height: plotH, containLabel: false }, // 左上 PCE
        { left: ML + plotW + GUT + xOff, width: plotW, top: MT,                 height: plotH, containLabel: false }, // 右上 Voc
        { left: ML + xOff,         width: plotW, top: MT + plotH + VROW,  height: plotH, containLabel: false }, // 左下 Jsc
        { left: ML + plotW + GUT + xOff, width: plotW, top: MT + plotH + VROW,  height: plotH, containLabel: false }  // 右下 FF
      ];
    } else {
      // 第二十四批：页面 grid 按 layout.combined.gutterPct 动态算（格式修改1 后默认 10%）
      // W1 = (84 - gPct)/2 每列宽（左右留 7%/9% 给 Y 标题与右边距）；左列 right = 93 - W1；右列 left = 7 + W1 + gPct
      var gPct = st.layout.gutterPct;
      var W1 = (84 - gPct) / 2;
      grids = [
        { left: '7%', right: (93 - W1) + '%', top: '4%', bottom: '58%', containLabel: true },
        { left: (7 + W1 + gPct) + '%', right: '9%', top: '4%', bottom: '58%', containLabel: true },
        { left: '7%', right: (93 - W1) + '%', top: '48%', bottom: '14%', containLabel: true },
        { left: (7 + W1 + gPct) + '%', right: '9%', top: '48%', bottom: '14%', containLabel: true }
      ];
    }
    var xAxis = [], yAxis = [], series = [];
    for (var g = 0; g < 4; g++) {
      var range = ranges[g];
      var yMain = baseYAxis(Y_TITLES[keys[g]], tickFs, titleFs, opts.axisTitlePos, allNameGap, sc);
      if (range.min !== undefined) { yMain.min = range.min; yMain.max = range.max; yMain.interval = range.step; }
      xAxis.push(baseXAxis(names, false, xFs, false, sc, (opts.pdfLabelRotate || 0) || undefined)); // 全显示（interval 恒 0）绝不间隔抽取；第 4 参 hideLabels 勿传 sc（第二十二批修复：误传导致 X 标签全灭）
      xAxis.push(emptyAxis(true, names, sc));
      yAxis.push(yMain);
      yAxis.push(emptyAxis(false, undefined, sc));
      series = series.concat(seriesFor(keys[g], conditions, opts, g, ranges[g])); // V3：传 per-key Y 范围（截断超界箱体）
    }
    // 各格 x/y 轴与 grid 的对应：轴索引 = g*2（主）、g*2+1（边框）
    for (var i = 0; i < 4; i++) {
      xAxis[i * 2].gridIndex = i; xAxis[i * 2 + 1].gridIndex = i;
      yAxis[i * 2].gridIndex = i; yAxis[i * 2 + 1].gridIndex = i;
    }
    return {
      backgroundColor: '#ffffff',
      textStyle: { fontFamily: FONT },
      animation: opts.exportMode ? false : undefined, // 根修：离屏导出关动画（否则新建实例同步取 SVG 是动画首帧=无数据）
      tooltip: boxTooltip(),
      grid: grids,
      xAxis: xAxis,
      yAxis: yAxis,
      series: series,
      __needW: __needW, __needH: __needH // V2 收尾：页面容器目标尺寸（导出为 undefined 保持固定）
    };
  }

  var COMBINED_R = 1.33; // V2 收尾：合并图子图目标宽高比（1400×980 默认布局推导）
  var PLOT_W0 = 340, PLOT_H0 = 256; // V2 收尾：页面模式子图目标尺寸（对应 4:3 子图观感，gap 变化时保持恒定）
  var JV_PLOT_H0 = 250, JV_PLOT_W0 = 380; // V3：JV plot 宽高恒定（页面/预览）
  var SB_PLOT_H0 = 240; // V2 收尾：箱线单图页面 plot 高恒定（宽度受卡片网格布局限制）
  var OV_PLOT_W0 = 1000, OV_PLOT_H0 = 440; // V2 收尾：叠加图页面 plot 恒定（独占整行宽度自由）

  /** 2×2 合并图（V2 收尾：页面模式也走像素 grid——读容器实际尺寸，layout 参数页面与预览/导出一致生效；
   *  容器尺寸随内容自适应：gap/字号/留白变化只改变图卡大小，子图（plot）恒定不变形） */
  function renderCombinedBoxplot(dom, conditions, opts) {
    opts = opts || {};
    if (!opts.exportMode) {
      var w = dom && dom.offsetWidth ? dom.offsetWidth : 850;
      var h = dom && dom.offsetHeight ? dom.offsetHeight : 595;
      opts = Object.assign({}, opts, { exportMode: true, __pageMode: true, exportW: w, exportH: h });
    }
    // V3：两阶段构建——option 的 grid 必须按容器最终尺寸计算（灯箱/导出保持 exportMode 布局，不进入 __pageMode）
    var opt = buildCombinedOption(conditions, opts);
    if (opt && opt.__needH && dom) {
      // 先按当前 exportW 试算 → 设置容器 → 尺寸变化则用最终尺寸重建 option
      var curW = dom.offsetWidth || 0, curH = dom.offsetHeight || 0;
      var changed = false;
      if (Math.abs(curW - opt.__needW) > 4) { dom.style.width = opt.__needW + 'px'; changed = true; }
      if (Math.abs(curH - opt.__needH) > 4) { dom.style.height = opt.__needH + 'px'; changed = true; }
      if (changed) {
        var w2 = dom.offsetWidth, h2 = dom.offsetHeight;
        if (w2 > 100 && h2 > 100) {
          opt = buildCombinedOption(conditions, Object.assign({}, opts, { exportW: w2, exportH: h2 }));
        }
      }
    }
    var chart = echarts.init(dom, null, { renderer: 'svg' });
    chart.setOption(opt);
    return chart;
  }

  /* ================================================================
   * 8.5 JV 折线图（每条件最高器件，正反扫两条曲线）
   * 默认聚焦第四象限（V≥0、J≤0 发电工作区），全范围可切换
   * ================================================================ */
  function buildJVOption(cond, opts) {
    opts = opts || {};
    var sc = opts.scale || 1; // 第十七批：尺寸缩放
    // 第三十二批：图例位置缓存（grid IIFE 写入、legend IIFE 读取）
    var _jvLegendPos = null;
    // 第二十五批：JV 命名空间（字号偏移 -2 已固化进默认值 11/13）
    var st = chartStyle.jv;
    styleNS = st;
    opts.styleNs = st;
    // P5：支持指定器件（详情表行点击切换；缺省最高器件）
    var devIdx = (opts.devIndex != null && opts.devIndex >= 0) ? opts.devIndex : cond.maxDeviceIndex;
    var maxDev = cond.devices[devIdx];
    var fwdPts = (maxDev && maxDev.fwd && maxDev.fwd.points) || [];
    var revPts = (maxDev && maxDev.rev && maxDev.rev.points) || [];
    var fwdEff = condEff(cond, 'fwd');
    var revEff = condEff(cond, 'rev');
    // 第二十五批：条件色优先 condColors[displayName||name]，否则调色板
    var color = (chartStyle.condColors && chartStyle.condColors[cond.displayName || cond.name])
      ? chartStyle.condColors[cond.displayName || cond.name]
      : opts.chartColor(opts.condIndex || 0);
    // 数据范围（提前计算：series 构建需要 focused 决定 markLine）
    var vMin = Infinity, vMax = -Infinity, jMin = Infinity, jMax = -Infinity;
    [fwdPts, revPts].forEach(function (pts) {
      pts.forEach(function (p) {
        if (P.isNum(p[0]) && P.isNum(p[2])) {
          if (p[0] < vMin) vMin = p[0];
          if (p[0] > vMax) vMax = p[0];
          if (p[2] < jMin) jMin = p[2];
          if (p[2] > jMax) jMax = p[2];
        }
      });
    });
    var focused = opts.jvFocus !== false && isFinite(vMin) && isFinite(jMin);
    var series = [];
    var hasBoth = fwdPts.length > 0 && revPts.length > 0; // 单方向（检测不到正反）时系列名只用条件名——避免未真实判向的方向词误导
    var condLabel = (cond.displayName || cond.name) + ' · '; // 单方向时的图例：条件名 + 效率
    if (fwdPts.length) {
      series.push({
        name: hasBoth ? 'Forward (Efficiency: ' + P.roundSigText(fwdEff) + '%)' : condLabel + P.roundSigText(fwdEff) + '%',
        type: 'line',
        data: fwdPts.map(function (p) { return [p[0], p[2]]; }),
        showSymbol: false,
        lineStyle: { color: darken(color, 0.35), width: S(st.jvFwdLineWidth, sc), type: st.jvFwdDash }, // 第二十四批：读 chartStyle（线宽/线型）
        itemStyle: { color: darken(color, 0.35) },
        markLine: quadrantRefLines(focused, sc)
      });
    }
    if (revPts.length) {
      series.push({
        name: hasBoth ? 'Reverse (Efficiency: ' + P.roundSigText(revEff) + '%)' : condLabel + P.roundSigText(revEff) + '%',
        type: 'line',
        data: revPts.map(function (p) { return [p[0], p[2]]; }),
        showSymbol: false,
        lineStyle: { color: color, width: S(st.jvRevLineWidth, sc) }, // 第二十四批：读 chartStyle
        itemStyle: { color: color },
        // 正扫缺失（rev-only 器件）时象限参考线挂到反扫上，避免丢失
        markLine: fwdPts.length ? undefined : quadrantRefLines(focused, sc)
      });
    }
    var xMin, xMax, yMin, yMax;
    if (focused) {
      // 聚焦第四象限：X 从 0（或数据起点）到最大 V；Y 只留一小段正区
      xMin = Math.min(0, vMin);
      xMax = vMax;
      yMin = jMin * 1.05;
      yMax = Math.max(2, Math.abs(jMin) * 0.08); // 第三十批：上方正区收紧 0.15→0.08（-25 数据 → yMax 2 而非 3.75），减少 Y 0 以上大段空白
    } else {
      // 全范围：数据 min/max ± 2%
      var xPad = (vMax - vMin) * 0.02 || 0.01;
      var yPad = (jMax - jMin) * 0.02 || 0.01;
      xMin = vMin - xPad; xMax = vMax + xPad;
      yMin = jMin - yPad; yMax = jMax + yPad;
    }
    // 第三十七批（第三）：坐标轴手动覆盖——用户给 min/max/interval 直接采用（不做吸附），缺省回退自动
    if (st.xMin != null) xMin = st.xMin;
    if (st.xMax != null) xMax = st.xMax;
    if (st.yMin != null) yMin = st.yMin;
    if (st.yMax != null) yMax = st.yMax;
    // 第十三批改动 3：数值规范化——Y 按 niceStep 吸附；X 聚焦从 -0.1 起（左侧只留 0.1 边距显示 y=0 参考线），
    // 全范围保持 0.2 步长吸附；聚焦时 X interval 改自动（在 [-0.1, xMax] 上 ECharts 自动挑 0/0.2/0.4… 整齐刻度）
    // 第三十批：聚焦 Y 轴用细步长（|jMin|>12 → 5，否则 2）——原 niceStep(span≈29) 给 10，Y 0 以上
    // 空白被顶到 10；显式 5 步长 → yMax=5、yMin=-30，0 以上空白减半，刻度仍整齐（-30/-25/…/0/5）
    var yStep;
    if (st.yInterval != null && st.yInterval > 0) yStep = st.yInterval;
    else if (focused) yStep = Math.abs(st.yMin != null ? st.yMin : jMin) > 12 ? 5 : 2;
    else yStep = niceStep((st.yMax != null ? st.yMax : yMax) - (st.yMin != null ? st.yMin : yMin));
    if (st.yMin == null) yMin = snapDown(yMin, yStep);
    if (st.yMax == null) yMax = snapUp(yMax, yStep);
    if (st.xMin == null) xMin = focused ? -0.1 : snapDown(xMin, 0.2); // 起点固定 -0.1（不再 -0.2 留空白）
    if (st.xMax == null) xMax = focused ? snapUp(xMax - 1e-3, 0.2) : snapUp(xMax, 0.2); // 第三十批：去浮点尾数（1.200001→1.2），X 右缘收窄到数据边界
    // 第十七批：Y 标题字号缩放 + nameGap 动态（interval 自动无法预知全部刻度，用 yMin/yMax/0 估最大长度）
    // P5-收尾：X/Y 刻度字号拆读（xTickFontSize/yTickFontSize 优先，回退 tickFontSize）
    var yTickFs = S(st.yTickFontSize != null ? st.yTickFontSize : st.tickFontSize, sc);
    var xTickFs = S(st.xTickFontSize != null ? st.xTickFontSize : st.tickFontSize, sc);
    var yTitleFs = S(st.titleFontSize, sc); // 第二十五批：JV 命名空间默认 11/13
    var lay = yTitleLayout([yMin.toFixed(2), yMax.toFixed(2), (0).toFixed(2)], yTickFs, yTitleFs, S(8, sc), sc);
    var tt = yAxisTitle(opts.axisTitlePos, yTitleFs, lay.nameGap, sc);
    // X 轴标签：最多 2 位小数、去尾零（0.20 显示 0.2）
    var xLabel = function (v) { return String(Number(v.toFixed(2))); };
    return {
      backgroundColor: '#ffffff',
      textStyle: { fontFamily: FONT },
      animation: opts.exportMode ? false : undefined, // 根修：离屏导出关动画（否则新建实例同步取 SVG 是动画首帧=无数据）
      // 第三十二批：grid 边距与图例位置统一在此计算——图例放「y=0 参考线正下方、plot 左部空白区」
      // （J -0.6~-8、V<0.5 无曲线），彻底不挡参考线/曲线/轴线
      grid: (function () {
        var xTitleBase = S(11, sc) + S(4, sc) + S(28, sc) + S(12, sc) * 0.6; // 页面档（nameGap 28）
        var isExport = opts.exportMode && (opts.exportW || 0) >= 600;
        var vTop = isExport
          ? S(14, sc)
          : Math.max(S(st.layout.padTop, sc), xTitleBase);
        var vBottom = isExport
          ? Math.max(S(20, sc), S(20, sc) + S(10, sc) * 0.6 + S(2, sc))
          : Math.max(S(st.layout.padBottom, sc), xTitleBase);
        var gridLeft = Math.max(S(st.layout.padLeft, sc), lay.leftReserve) + S(st.xLabelOffset || 0, sc); // P5-收尾：X 标签偏移（JV 支持）
        var g = {
          left: gridLeft,
          right: S(st.layout.padRight, sc),
          top: vTop,
          bottom: vBottom,
          containLabel: true
        };
        if (opts.__pageMode) {
          // V3：JV 页面/预览 plot 宽高恒定（380×250），容器宽高自适应（修偏右/曲线压平）
          g.width = JV_PLOT_W0;
          g.height = JV_PLOT_H0;
          g.containLabel = false;
          g.__needW = Math.round(gridLeft + JV_PLOT_W0 + S(st.layout.padRight, sc));
          g.__needH = Math.round(vTop + JV_PLOT_H0 + vBottom);
        }
        // 图例：y=0 线画布 y = vTop + yMax/(yMax-yMin) × plotH；图例 top = 该线 + 4px（正下方空白区）
        var H = opts.exportH || 340;
        var plotH = H - vTop - vBottom;
        var y0 = vTop + (yMax / (yMax - yMin)) * plotH;
        _jvLegendPos = { left: gridLeft + S(8, sc), top: y0 + S(4, sc) };
        return g;
      })(),
      legend: (function () {
        // 第三十二批：图例在 y=0 线正下方（J -0.6~-8 空白区）——不挡参考线/曲线/轴线；无 plot 时不渲染
        // 第三十三批：支持 jvLegendOffsetX/Y 微调（±px，乘 sc 保持页面/导出相对一致）
        var pos = _jvLegendPos || { left: 0, top: 0 };
        var fs = S(st.jvLegendFontSize, sc);
        return {
          show: st.jvShowLegend,
          orient: 'vertical',
          left: (pos.left + S(st.jvLegendOffsetX || 0, sc)) + 'px',
          top: (pos.top + S(st.jvLegendOffsetY || 0, sc)) + 'px',
          backgroundColor: 'rgba(255,255,255,0.85)',
          borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 3,
          padding: [4, 7],
          itemGap: S(4, sc),
          itemWidth: fs * 1.3, itemHeight: fs * 0.7, // P5-收尾：图例符号随字号缩放（框高同步变化）
          textStyle: { fontSize: fs, fontFamily: FONT, color: st.labelColor || '#33415c' }
        };
      })(),
      xAxis: [
        {
          type: 'value', name: 'Volt (V)', min: xMin, max: xMax,
          position: st.xTitlePos === 'top' ? 'top' : 'bottom', // 第三十七批（第三）：X 标题/轴位置
          interval: (st.xInterval != null && st.xInterval > 0) ? st.xInterval : (focused ? undefined : 0.2), // 聚焦：自动刻度（起点 -0.1 非 0.2 倍数）；全范围：固定 0.2；手动覆盖优先
          nameLocation: 'middle', nameGap: st.xTitleGap > 0 ? S(st.xTitleGap, sc) : ((opts.exportMode && (opts.exportW || 0) >= 600) ? S(20, sc) : S(28, sc)), // 第三十批：导出 20；第三十七批（第三）xTitleGap 手动覆盖
          nameTextStyle: { fontSize: S(12, sc), fontWeight: 'bold', fontFamily: FONT },
          axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) }, // 轴线画在底部边缘满宽（onZero 须在 axisLine 内）
          axisTick: { show: true, inside: true, lineStyle: { color: st.tickColor } }, // 第二十五批：读 JV 命名空间刻度色
          axisLabel: { show: true, fontSize: xTickFs, formatter: xLabel, margin: (st.xLabelGap > 0 ? S(st.xLabelGap, sc) : (st.labelGap > 0 ? S(st.labelGap, sc) : S(3, sc))), color: st.labelColor }, // P5-收尾：X 刻度字号/间距读拆分字段（回退旧 labelGap）
          splitLine: { show: false }
        },
        valueFrameAxis(st.xTitlePos === 'top' ? 'bottom' : 'top', xMin, xMax, sc) // 第三十七批（第三）：主轴换侧时框轴反向
      ],
      yAxis: [
        {
          type: 'value', name: 'J (mA/cm²)', min: yMin, max: yMax,
          position: st.yTitlePos === 'right' ? 'right' : 'left', // 第三十七批（第三）：Y 标题/轴位置
          interval: yStep, // 第三十批：聚焦细步长（5/2）保证刻度整齐（-30/-25/…/0/5）且 0 以上空白减半
          nameLocation: tt.nameLocation, nameRotate: tt.nameRotate, nameGap: tt.nameGap,
          nameTextStyle: tt.nameTextStyle,
          axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) }, // 轴线画在左侧边缘满高
          axisTick: { show: true, inside: true, lineStyle: { color: st.tickColor } }, // 第二十五批：读 JV 命名空间刻度色
          // 第十三批：toFixed(2) 统一标签宽度 + margin 防贴线；第十七批：乘 sc；第三十七批（第三）yLabelGap 可调
          axisLabel: { show: true, fontSize: yTickFs, formatter: function (v) { return v.toFixed(2); }, margin: st.yLabelGap > 0 ? S(st.yLabelGap, sc) : S(8, sc), color: st.labelColor },
          splitLine: { show: false }
        },
        valueFrameAxis('right', yMin, yMax, sc)
      ],
      series: series
    };
  }

  /** P5：多条件 JV 曲线叠加 option。conditions 为已勾选+二次筛选后的条件数组。
   *  opts: { direction:'rev'|'fwd'|'both'（默认 rev）, chartColor, axisTitlePos }
   *  每条件取排除后效率最高器件（反扫优先 effOf）；叠加为多系列，条件色沿用 condColors/调色板。
   *  复用 jv 样式命名空间（线宽/字号/坐标轴随主图「⚙ 调整格式 → JV」联动）。 */
  function buildJVOverlayOption(conditions, opts) {
    opts = opts || {};
    var sc = opts.scale || 1;
    var dir = opts.direction || 'rev';
    var st = chartStyle.jvOverlay; // P5-4：独立命名空间（与单卡 JV 隔离）
    styleNS = st;
    // 数据收集：每条件最高器件（排除后）的指定方向曲线
    var entries = []; // {cond, dev, pts, eff, color, idx}
    (conditions || []).forEach(function (cond, ci) {
      if (!cond || !cond.devices || !cond.devices.length) return;
      var best = null, bestEff = -Infinity;
      cond.devices.forEach(function (d) {
        if (d.excluded) return; // P5：排除器件不入选
        var e = (global.JVTable && global.JVTable.effOf) ? global.JVTable.effOf(d) : P.deviceParam(d, 'pce'); // effOf 在 tables.js（命名空间）
        if (P.isNum(e) && e > bestEff) { bestEff = e; best = d; }
      });
      if (!best) return;
      var pts = dir === 'fwd' ? (best.fwd && best.fwd.points) || []
        : dir === 'both' ? (best.rev && best.rev.points) || []
        : (best.rev && best.rev.points) || []; // rev 默认
      var color = (chartStyle.condColors && chartStyle.condColors[cond.displayName || cond.name])
        ? chartStyle.condColors[cond.displayName || cond.name]
        : opts.chartColor(ci);
      entries.push({ cond: cond, dev: best, pts: pts, eff: bestEff, color: color, idx: ci });
    });
    if (!entries.length) return null;
    // 数据范围（全部选中曲线）
    var vMin = Infinity, vMax = -Infinity, jMin = Infinity, jMax = -Infinity;
    entries.forEach(function (en) {
      en.pts.forEach(function (p) {
        if (P.isNum(p[0]) && P.isNum(p[2])) {
          if (p[0] < vMin) vMin = p[0];
          if (p[0] > vMax) vMax = p[0];
          if (p[2] < jMin) jMin = p[2];
          if (p[2] > jMax) jMax = p[2];
        }
      });
    });
    var focused = isFinite(vMin) && isFinite(jMin);
    // 系列：每条件 1~2 条（both 时正扫虚线/反扫实线，同色深浅）
    var series = [];
    var refLine = (focused && st.jvShowRefLine) ? quadrantRefLines(focused, sc) : undefined; // P5-7：叠加图参考线（挂首个系列）
    entries.forEach(function (en) {
      // P5-收尾：图例去器件编号（只留 条件 · 效率）
      var label = (en.cond.displayName || en.cond.name) + ' · ' + P.roundSigText(en.eff) + '%';
      if (dir === 'both') {
        var fwdPts = (en.dev.fwd && en.dev.fwd.points) || [];
        var revPts = (en.dev.rev && en.dev.rev.points) || [];
        if (fwdPts.length) series.push({
          name: label + ' Forward', type: 'line', data: fwdPts.map(function (p) { return [p[0], p[2]]; }),
          showSymbol: false, lineStyle: { color: darken(en.color, 0.35), width: S(st.jvFwdLineWidth, sc), type: st.jvFwdDash }, itemStyle: { color: darken(en.color, 0.35) }
        });
        if (revPts.length) series.push({
          name: label + ' Reverse', type: 'line', data: revPts.map(function (p) { return [p[0], p[2]]; }),
          showSymbol: false, lineStyle: { color: en.color, width: S(st.jvRevLineWidth, sc) }, itemStyle: { color: en.color },
          markLine: series.length === 0 ? refLine : undefined
        });
      } else {
        if (en.pts.length) series.push({
          name: label, type: 'line', data: en.pts.map(function (p) { return [p[0], p[2]]; }),
          showSymbol: false, lineStyle: { color: en.color, width: dir === 'fwd' ? S(st.jvFwdLineWidth, sc) : S(st.jvRevLineWidth, sc), type: dir === 'fwd' ? st.jvFwdDash : 'solid' },
          itemStyle: { color: en.color },
          markLine: series.length === 0 ? refLine : undefined
        });
      }
    });
    if (!series.length) return null;
    // 轴：聚焦四象限（整体范围）
    var xMin, xMax, yMin, yMax;
    if (focused) {
      xMin = Math.min(0, vMin);
      xMax = vMax;
      yMin = jMin * 1.05;
      yMax = Math.max(2, Math.abs(jMin) * 0.08);
    } else {
      var xPad = (vMax - vMin) * 0.02 || 0.01, yPad = (jMax - jMin) * 0.02 || 0.01;
      xMin = vMin - xPad; xMax = vMax + xPad; yMin = jMin - yPad; yMax = jMax + yPad;
    }
    var yStep = Math.abs(jMin) > 12 ? 5 : 2;
    if (st.yInterval != null && st.yInterval > 0) yStep = st.yInterval;
    if (st.yMin == null) yMin = snapDown(yMin, yStep);
    if (st.yMax == null) yMax = snapUp(yMax, yStep);
    if (st.xMin == null) xMin = focused ? -0.1 : snapDown(xMin, 0.2);
    if (st.xMax == null) xMax = focused ? snapUp(xMax - 1e-3, 0.2) : snapUp(xMax, 0.2);
    var yTickFs = S(st.yTickFontSize != null ? st.yTickFontSize : st.tickFontSize, sc); // P5-收尾：拆分字段优先
    var xTickFs = S(st.xTickFontSize != null ? st.xTickFontSize : st.tickFontSize, sc);
    var yTitleFs = S(st.titleFontSize, sc);
    var lay = yTitleLayout([yMin.toFixed(2), yMax.toFixed(2), (0).toFixed(2)], yTickFs, yTitleFs, S(8, sc), sc);
    var tt = yAxisTitle(opts.axisTitlePos, yTitleFs, lay.nameGap, sc);
    var xLabel = function (v) { return String(Number(v.toFixed(2))); };
    var gTop = Math.max(S(st.layout.padTop, sc), S(11, sc) + S(4, sc) + S(28, sc) + S(12, sc) * 0.6);
    var gBottom = Math.max(S(st.layout.padBottom, sc), S(11, sc) + S(4, sc) + S(28, sc) + S(12, sc) * 0.6);
    var gLeft = Math.max(S(st.layout.padLeft, sc), lay.leftReserve) + S(st.xLabelOffset || 0, sc); // P5-收尾：X 标签偏移
    return {
      backgroundColor: '#ffffff',
      textStyle: { fontFamily: FONT },
      animation: opts.exportMode ? false : undefined,
      tooltip: { trigger: 'axis', confine: true, textStyle: { fontSize: 12 }, formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var head = 'V = ' + Number(ps[0].axisValue.toFixed(3)) + ' V';
        var rows = ps.map(function (p) {
          return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + p.color + ';margin-right:4px"></span>' + p.seriesName + '：<b>' + p.value[1].toFixed(2) + '</b> mA/cm²';
        });
        return '<div style="font-size:12px;line-height:1.7">' + head + '<br>' + rows.join('<br>') + '</div>';
      } },
      grid: (function() {
        var g = { left: gLeft, right: 130, top: gTop, bottom: gBottom, containLabel: true };
        if (opts.__pageMode) {
          // V2 收尾：叠加图页面 plot 恒定，容器宽高自适应（独占整行宽度自由）
          g.width = OV_PLOT_W0;
          g.height = OV_PLOT_H0;
          g.containLabel = false;
          g.__needW = Math.round(gLeft + OV_PLOT_W0 + 130);
          g.__needH = Math.round(gTop + OV_PLOT_H0 + gBottom);
        }
        return g;
      })(),
      legend: {
        orient: 'vertical',
        right: (4 + S(st.jvLegendOffsetX || 0, sc)) + 'px', // P5-收尾：水平偏移（px，可大幅左移进图内）
        top: (50 + S(st.jvLegendOffsetY || 0, sc) * 0.25) + '%', // P5-收尾：垂直偏移（百分比：±200 → 0~100% 全覆盖）
        type: 'scroll', backgroundColor: 'rgba(255,255,255,0.85)',
        borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 3, padding: [4, 7],
        itemGap: S(4, sc),
        itemWidth: S(st.jvLegendFontSize, sc) * 1.3, itemHeight: S(st.jvLegendFontSize, sc) * 0.7, // P5-收尾：符号随字号
        textStyle: { fontSize: S(st.jvLegendFontSize, sc), fontFamily: FONT, color: st.labelColor || '#33415c' }
      },
      xAxis: [
        { type: 'value', name: 'Volt (V)', min: xMin, max: xMax, position: st.xTitlePos === 'top' ? 'top' : 'bottom',
          interval: st.xInterval != null && st.xInterval > 0 ? st.xInterval : (focused ? undefined : 0.2),
          nameLocation: 'middle', nameGap: st.xTitleGap > 0 ? S(st.xTitleGap, sc) : S(28, sc),
          nameTextStyle: { fontSize: S(12, sc), fontWeight: 'bold', fontFamily: FONT },
          axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) },
          axisTick: { show: true, inside: true, lineStyle: { color: st.tickColor } },
          axisLabel: { show: true, fontSize: xTickFs, formatter: xLabel, margin: (st.xLabelGap > 0 ? S(st.xLabelGap, sc) : (st.labelGap > 0 ? S(st.labelGap, sc) : S(3, sc))), color: st.labelColor }, // P5-收尾：拆分字段
          splitLine: { show: false } },
        valueFrameAxis(st.xTitlePos === 'top' ? 'bottom' : 'top', xMin, xMax, sc)
      ],
      yAxis: [
        { type: 'value', name: 'J (mA/cm²)', min: yMin, max: yMax, position: st.yTitlePos === 'right' ? 'right' : 'left',
          interval: yStep, nameLocation: tt.nameLocation, nameRotate: tt.nameRotate, nameGap: tt.nameGap,
          nameTextStyle: tt.nameTextStyle,
          axisLine: { show: true, onZero: false, lineStyle: axisLineStyle(sc) },
          axisTick: { show: true, inside: true, lineStyle: { color: st.tickColor } },
          axisLabel: { show: true, fontSize: yTickFs, formatter: function (v) { return v.toFixed(2); }, margin: st.yLabelGap > 0 ? S(st.yLabelGap, sc) : S(8, sc), color: st.labelColor },
          splitLine: { show: false } },
        valueFrameAxis('right', yMin, yMax, sc)
      ],
      series: series
    };
  }

  /** 第四象限参考线：y=0 横线 + x=0 竖线（#999 灰色虚线，无箭头、无标签）。
   *  P5-7：用户要求所有 JV 图两条参考线都显示（含聚焦模式）。 */
  function quadrantRefLines(focused, sc) {
    if (!(styleNS || chartStyle.single).jvShowRefLine) return undefined; // 第二十四批：读 chartStyle 显隐（第二十五批：JV 命名空间）
    var data = [{ yAxis: 0 }, { xAxis: 0 }];
    return {
      silent: true,
      symbol: 'none',
      lineStyle: { color: '#999999', width: S(1, sc || 1), type: 'dashed' },
      label: { show: false },
      data: data
    };
  }

  function renderJVChart(dom, cond, opts) {
    opts = opts || {};
    if (!opts.exportMode && dom) {
      opts = Object.assign({}, opts, { __pageMode: true });
    }
    var opt = buildJVOption(cond, opts);
    // V3：JV 容器宽高自适应（plot 恒定）
    if (opt && opt.grid && opt.grid.__needH && dom) {
      var curW = dom.offsetWidth || 0, curH = dom.offsetHeight || 0;
      if (opt.grid.__needW && Math.abs(curW - opt.grid.__needW) > 4) dom.style.width = opt.grid.__needW + 'px';
      if (Math.abs(curH - opt.grid.__needH) > 4) dom.style.height = opt.grid.__needH + 'px';
    }
    var chart = echarts.init(dom, null, { renderer: 'svg' });
    chart.setOption(opt);
    return chart;
  }

  /** P5：多条件 JV 叠加渲染（conditions 为二次筛选后的条件数组） */
  function renderJVOverlay(dom, conditions, opts) {
    opts = opts || {};
    if (!opts.exportMode && dom && String(dom.className || '').indexOf('style-preview-box') < 0) {
      opts = Object.assign({}, opts, { __pageMode: true });
    } else if (opts.__pageMode) {
      // 预览双传：显式 __pageMode 即启用（叠加图预览盒固定 1400×700 scale2 自适配，不参与）
    }
    var chart = echarts.init(dom, null, { renderer: 'svg' });
    var o = buildJVOverlayOption(conditions, opts);
    if (o && o.grid && o.grid[0] && o.grid[0].__needW && dom) {
      if (Math.abs((dom.offsetWidth || 0) - o.grid[0].__needW) > 4) dom.style.width = o.grid[0].__needW + 'px';
      if (Math.abs((dom.offsetHeight || 0) - o.grid[0].__needH) > 4) dom.style.height = o.grid[0].__needH + 'px';
    }
    if (o) chart.setOption(o);
    return chart;
  }

  /* ================================================================
   * 8.6 导出：SVG 下载 / 4xPNG 复制（剪贴板失败降级下载）
   * ================================================================ */
  /** 清理 SVG 供 <img> 解码/文件下载：
   *  ① 移除 CDATA 包装（浏览器禁止 image 上下文中的 CDATA）
   *  ② 属性值内的双引号转义为 &quot;（严格 XML 解析要求，ECharts 可能输出未转义引号） */
  function sanitizeSVG(svg) {
    svg = svg.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
    var out = '', inTag = false, inQuote = false, quoteCh = '';
    for (var i = 0; i < svg.length; i++) {
      var ch = svg[i];
      if (inTag) {
        if (inQuote) {
          if (ch === quoteCh) { inQuote = false; out += ch; }
          else if (ch === '"' && quoteCh === '"') { out += '&quot;'; }
          else out += ch;
        } else if (ch === '"' || ch === "'") { inQuote = true; quoteCh = ch; out += ch; }
        else { out += ch; if (ch === '>') inTag = false; }
      } else {
        out += ch;
        if (ch === '<') inTag = true;
      }
    }
    return out;
  }

  function downloadBlob(blob, fileName) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function downloadChartSVG(chart, fileName) {
    var svg = sanitizeSVG(chart.renderToSVGString());
    downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), fileName + '.svg');
  }

  /** 离屏导出（第十四批改动 1 真根修）：**离屏容器不能放屏幕外**（left:-99999px 时 ECharts 对
   *  需要测量容器的系列——尤其抖动散点——会布局失败被跳过，导致导出图缺散点）。
   *  正确做法：容器放在可见视口内、占满导出尺寸，但完全透明不可见不遮挡：
   *  visibility:hidden（仍在渲染流可正常测量布局）+ z-index:-1 + pointer-events:none。
   *  仍保留双重 rAF（可见区内渲染也需一帧完成首次绘制，更稳）。
   *  PNG 的 SVG→canvas 转换是异步的，但 SVG 字符串同步取出后 div 移除不影响其完成。 */
  function exportChartOffscreen(renderFn, size, fileName, isSvg) {
    if (typeof renderFn !== 'function') return;
    var div = document.createElement('div');
    // opacity:0 容器（getClientRects 恒非空）；exportMode 同时关闭 ECharts 动画（见 build*Option）
    div.style.cssText = 'position:fixed;right:0;bottom:0;width:' + size.width + 'px;height:' + size.height + 'px;' +
      'opacity:0;pointer-events:none;z-index:-1;';
    document.body.appendChild(div);
    var chart = null;
    try {
      chart = renderFn(div, { exportMode: true, scale: size.scale || 1, exportW: size.width, exportH: size.height }); // 导出模式（内容盒 + animation:false + 网页观感缩放）
    } catch (e) {
      if (div.parentNode) div.parentNode.removeChild(div);
      return;
    }
    var done = false;
    var doExport = function () {
      if (done) return;
      done = true;
      try {
        // 渲染完成后再取 SVG：exportMode 已关动画（否则同步取到动画首帧 scale≈0 = 无数据），
        // 并用 finished 事件确保渲染完成；setTimeout 兜底
        if (isSvg) downloadChartSVG(chart, fileName);
        else copyChartPNG(chart, fileName);
      } catch (e) {
        // 兜底
      } finally {
        try { chart.dispose(); } catch (e) {}
        if (div.parentNode) div.parentNode.removeChild(div);
      }
    };
    if (chart.on && typeof chart.on === 'function') chart.on('finished', doExport);
    setTimeout(doExport, 60); // finished 兜底
  }

  function copyChartPNG(chart, fileName) {
    var svg = sanitizeSVG(chart.renderToSVGString());
    var img = new Image();
    img.onload = function () {
      var scale = 4; // 4 倍分辨率，进 PPT 清晰
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (blob && navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
            showToast('图片已复制，可直接 Ctrl+V 粘贴进 PPT');
          }, function () {
            fallbackPNG(canvas, fileName);
          });
        } else {
          fallbackPNG(canvas, fileName);
        }
      }, 'image/png');
    };
    img.onerror = function () { showToast('图表导出失败：SVG 转图片出错'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function fallbackPNG(canvas, fileName) {
    try {
      var url = canvas.toDataURL('image/png');
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('剪贴板不可用，已改为下载 PNG 图片');
    } catch (e) {
      showToast('图片导出失败');
    }
  }

  function showToast(msg) {
    if (global.JVTable && global.JVTable.showToast) global.JVTable.showToast(msg);
  }

  global.JVChart = {
    buildBoxplotOption: buildBoxplotOption,
    buildCombinedOption: buildCombinedOption,
    buildJVOption: buildJVOption,
    buildJVOverlayOption: buildJVOverlayOption, // P5：多条件叠加
    renderBoxplot: renderBoxplot,
    renderCombinedBoxplot: renderCombinedBoxplot,
    renderJVChart: renderJVChart,
    renderJVOverlay: renderJVOverlay, // P5
    copyChartPNG: copyChartPNG,
    downloadChartSVG: downloadChartSVG,
    exportChartOffscreen: exportChartOffscreen,
    paramOf: paramOf,
    boxOf: boxOf,
    condEff: condEff,
    axisRange: axisRange,
    niceAxisRange: niceAxisRange,
    xLabelSpace: xLabelSpace,
    xLabelReach: xLabelReach,
    niceStep: niceStep,
    snapDown: snapDown,
    snapUp: snapUp,
    valueFrameAxis: valueFrameAxis,
    sanitizeSVG: sanitizeSVG,
    // 第二十四批：chartStyle API（图像格式调整器）
    chartStyle: chartStyle,
    DEFAULT_CHART_STYLE: DEFAULT_CHART_STYLE,
    PALETTES: PALETTES,
    saveChartStyle: saveChartStyle,
    resetChartStyle: resetChartStyle,
    applyChartStyle: applyChartStyle, // 第二十八批：外部对象深合并设置（导出 HTML 恢复用）
    paletteColor: paletteColor
  };
})(typeof window !== 'undefined' ? window : globalThis);
