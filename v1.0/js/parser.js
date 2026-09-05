/**
 * parser.js —— 文件解析 + 数据处理
 *
 * 职责：把读入的文本网格（CSV/TXT 解析后）识别为「仪器原始格式」或「处理后格式」，
 *       解析成统一数据模型 fileData（见 5.10 节），并暴露全部统计算法
 *       （四位有效数字、Type-7 四分位数、箱线图统计、正反扫方向判定）。
 *
 * 算法依据：《钙钛矿太阳能电池 JV 数据分析工具 · HTML 实现方案》第 4、5、8 章，
 *       与现有 Excel VBA 宏（SolarCellDataProcessor）逐行移植并实测验证。
 */
(function (global) {
  'use strict';

  /* ================================================================
   * 5.1 文本归一化：所有表头/字段比较都先归一化，且不区分大小写
   * ================================================================ */
  function normalizeText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\u00A0/g, ' ')     // 不间断空格 → 普通空格
      .replace(/[\r\n]+/g, ' ')    // 换行 → 空格
      .trim()
      .replace(/\s+/g, ' ');       // 连续空格压成一个
  }

  /* ================================================================
   * 数值转换：原始文件所有单元格都是文本，把「看起来是数字」的转成数值。
   * True/False/NaN/--- 这类非数字文本保持 NaN（由调用方判断）。
   * ================================================================ */
  function toNumber(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (s === '') return NaN;
    return Number(s); // 非数字 → NaN
  }

  function isNum(v) {
    return typeof v === 'number' && !Number.isNaN(v);
  }

  /* ================================================================
   * 5.7 四位有效数字（half-away-from-zero，与 Excel/VBA 一致）
   *   roundSig(v)   → 舍入后的数值（内部重算、统计用）
   *   roundSigText(v) → 展示用字符串（固定小数位、含尾零，如 19.00）
   * 内部比较一律用未舍入原值；0 显示 '0'；无效值显示 ''。
   * ================================================================ */
  function roundSig(value, sig) {
    sig = sig || 4;
    if (!isFinite(value) || value === 0) return value;
    const sign = value < 0 ? -1 : 1;
    const abs = Math.abs(value);
    // 用科学计数法字符串做 4 位有效数字舍入（JS 内部正确舍入，避免 log10 浮点边界）
    const rounded = parseFloat(abs.toExponential(sig - 1));
    return sign * rounded;
  }

  function roundSigText(value, sig) {
    sig = sig || 4;
    if (value === null || value === undefined || !isFinite(value)) return '';
    if (value === 0) return '0';
    const r = roundSig(value, sig);
    const abs = Math.abs(r);
    let exp = Math.floor(Math.log10(abs));
    if (abs >= Math.pow(10, exp + 1)) exp++;          // 浮点边界修正
    let k = sig - 1 - exp;                             // 需要的小数位数
    if (k < 0) k = 0;
    return r.toFixed(k);
  }

  /* ================================================================
   * 8.2 四分位数（Type 7 / 线性插值，等同 Excel QUARTILE.INC、numpy 默认）
   * ================================================================ */
  function quartiles(sortedArr) {
    const n = sortedArr.length;
    function q(p) {
      const pos = 1 + (n - 1) * p;                     // 1 起始下标
      const k = Math.floor(pos);
      const d = pos - k;
      if (k - 1 < 0) return sortedArr[0];              // 越界取端点
      if (k >= n) return sortedArr[n - 1];
      return sortedArr[k - 1] + d * (sortedArr[k] - sortedArr[k - 1]);
    }
    return { q1: q(0.25), median: q(0.5), q3: q(0.75) };
  }

  /** 箱线图统计：输入未舍入原值数组，返回升序排序与四分位/均值 */
  function boxStats(values) {
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const qs = quartiles(sorted);
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return {
      values: values,
      sorted: sorted,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      q1: qs.q1,
      median: qs.median,
      q3: qs.q3,
      iqr: qs.q3 - qs.q1,
      mean: values.length ? sum / values.length : NaN
    };
  }

  /** 须线：mode='iqr'（1.5×IQR，同 Origin 默认）| 'minmax'（最小-最大） */
  function whiskers(values, mode) {
    const s = boxStats(values);
    if (mode === 'minmax') {
      return { lower: s.min, upper: s.max, outliers: [] };
    }
    const loFence = s.q1 - 1.5 * s.iqr;
    const hiFence = s.q3 + 1.5 * s.iqr;
    let lower = null, upper = null;
    for (let i = 0; i < s.sorted.length; i++) {
      const v = s.sorted[i];
      if (v >= loFence) { lower = v; break; }          // 不小于 Q1-1.5IQR 的最小值
    }
    for (let i = s.sorted.length - 1; i >= 0; i--) {
      const v = s.sorted[i];
      if (v <= hiFence) { upper = v; break; }          // 不大于 Q3+1.5IQR 的最大值
    }
    if (lower === null) lower = s.min;
    if (upper === null) upper = s.max;
    const outliers = s.sorted.filter(function (v) {
      return v < loFence || v > hiFence;
    });
    return { lower: lower, upper: upper, outliers: outliers, stats: s };
  }

  /** R1：唯一键判定（来源：user > guided > manual > 模板 > 系统名容器 > 旧行为）——从 parseRawFormat ck 链提取同一实现。
   *  rec: { name, dir, jvDirAssigned }；ctx: { mode, nameManualMap }；nameRules/guidedRule 为模块态。
   *  返回 { key: string|null, sys: boolean }——sys = guided 模式系统名行（关专用容器语义）。 */
  function resolveConditionKey(rec, ctx) {
    var mode = ctx && ctx.mode;
    if (mode === 'user') return { key: userRuleKey(rec.name), sys: false };
    if (mode === 'guided') {
      var isSys = isUnnamedSystemName(rec.name);
      // N-r6-2：guided 模式系统名行——ck 回退 null 且退出 guided 放行（走容器语义：落单反扫并入最近命名条件）
      return { key: isSys ? null : guidedKey(rec.name, ctx && ctx.guidedRule), sys: isSys };
    }
    if (mode === 'manual') {
      var mval = (ctx && ctx.nameManualMap) ? ctx.nameManualMap[rec.name] : undefined;
      // t45：manual 恒等映射（名→名）+ 方向记录（dir≠0）→ 回退容器基线（并入最近条件，不拆独立条件——防 '1 3.*' 类记录名
      //  造成容器记录缺失/0 器件条件）；恒等+非方向记录保持 map 键（与 map 归组键 '@cl:' 同一键槽，防同名双条件分裂）
      return { key: (mval === undefined || (mval === rec.name && rec.dir !== 0)) ? null : mval, sys: false };
    }
    if (mode) return { key: nameClusterKey(rec.name), sys: false }; // 模板（tpl id 或自动推断）：正则/块/映射/模板键（主键原样，大小写保留——保守归并）
    return { key: null, sys: false }; // 旧行为（clusterMode null）
  }

  /** R2：判向统一入口（仅入口统一——输出与既有链完全一致：getScanDirection → 系统名特征 Reverse data 兜底 → JV 首末为纲；
   *  供后续 B（E36a 序号配对选项）在 ctx 扩展；parseRawRecords 判向链经由本入口——行为不变）。 */
  function resolveScanDir(name, ch0, jvCh) {
    var dir = getScanDirection(name);
    var jvDirAssigned = false;
    // 改动 1：方向不明但具系统名特征（数字+点开头）→ 用通道 Reverse data 兜底判向（False/null/通道缺失 → 正扫，与原链一致）
    if (dir === 0 && isSystemNameLike(name)) {
      dir = (ch0 && ch0.reverseFlag === true) ? -1 : 1;
    }
    // v1.1 回归修复（Bug1）：模板记录（CH_Ref 系）dir 被聚类拍平会破坏同名两块（JV 首点 -0.1=正扫/1.2=反扫）
    // 的正反配对——用通道 JV 首末 V 判向（首<末=正扫 dir=1；首>末=反扫 dir=-1）；无 JV/无法判 → 保持现状
    else if (dir === 0 && jvCh && nameClusterKey(name) !== null && jvCh.jv && jvCh.jv.length >= 2) {
      dir = jvCh.jv[0][0] < jvCh.jv[jvCh.jv.length - 1][0] ? 1 : -1;
      jvDirAssigned = true; // t32 回归修复：仅 JV 判向来源打标——防止误伤系统名记录（260819 Reverse 型）的条件分支
    }
    return { dir: dir, jvDirAssigned: jvDirAssigned };
  }

  /* ================================================================
   * 4.5 正反扫方向判定（完整移植 VBA GetSystemScanDirection）
   *   返回 1 = 正扫（Forward），-1 = 反扫（Reverse），0 = 非系统名/新条件
   * ================================================================ */
  function getScanDirection(rawName) {
    let name = normalizeText(rawName);
    if (name === '') return 0;

    // 1. 名称包装拆解："1 (Base-dmf-TA)" → "Base-dmf-TA"
    var m = /^\d+\s*\((.+)\)$/.exec(name);
    if (m) name = m[1];

    // 2. compactName：去空格、转小写
    var compact = name.replace(/\s+/g, '').toLowerCase();
    if (compact === '') return 0;

    // 3. 强特征（最高优先级，防误判）
    if (compact.indexOf('ch_ref.forward') >= 0) return 1;
    if (compact.indexOf('ch_ref.reverse') >= 0) return -1;

    // 4. 备用规则一：名称完全就是 forward / reverse
    if (compact === 'forward') return 1;
    if (compact === 'reverse') return -1;

    // 5. 备用规则二：带数字通道前缀/后缀 + 方向后缀（避免把 "Forward stability" 误判）
    var baseName = name.replace(/\(\d+\)\s*$/, '');    // 去掉末尾序号后缀 (n)
    var hasNumPrefix = /^\d+\./.test(baseName);        // 以 "1." 等数字前缀开头
    var hasNumSuffix = /\.\d+$/.test(baseName);        // 以 ".1" 等数字后缀结尾
    if (hasNumPrefix || hasNumSuffix) {
      var b = baseName.replace(/\s+/g, '').toLowerCase();
      if (/(\.forward|_forward|-forward)$/.test(b)) return 1;
      if (/(\.reverse|_reverse|-reverse)$/.test(b)) return -1;
    }

    // 6. 都不匹配
    return 0;
  }

  /** 名称去「序号 (真实名)」包装后的核心（与 getScanDirection 第 1 步一致） */
  function systemNameCore(rawName) {
    var n = normalizeText(rawName);
    var m = /^\d+\s*\((.+)\)$/.exec(n);
    return m ? m[1] : n;
  }

  /** 是否为仪器系统名特征（序号.名字，如 1.CH_Ref(1)；数字点后须直接跟字母——排除 "0.5 Mod"/"0.1 Mod" 这类小数浓度自定义名）；是则不当新条件（改动 1） */
  function isSystemNameLike(name) {
    return /^\d+\.[A-Za-z]/.test(systemNameCore(name));
  }

  /* ================================================================
   * 第三十七批：条件系列检测与合并（导入时"用户决策"弹窗的数据层）
   *   seriesCore：剥离尾部/头部后缀得主体
   *     尾部：PVK-1→PVK、QX1→QX、PVK-a→PVK（数字串可无分隔符、单字母须有分隔符；
   *           无分隔符字母结尾单词不剥：PVK/GuaSCN/2D PSS）
   *     头部（第三十七批补充：序号标前面的命名）：0.1 CTAB→CTAB、0.1CTAB→CTAB、0.5 Mod→sam
   *           纯数字+点前缀（0.1/1.0/0.5），2D/3D 等"数字+字母"不剥
   *     含括号（包装形态 1 (PVK-1)）与纯数字名排除
   *   detectGroupCandidates：同主体 + 不同名字 ≥2 → 候选组（单成员不提示）
   *   applyGroupDecisions：应用合并决策，重算 maxEff/maxDeviceIndex
   * ================================================================ */
  function seriesCore(name) {
    var n = normalizeText(name);
    if (n === '' || /[()]/.test(n)) return null;
    // 1) 尾部后缀剥离（优先：先消歧最具体的差异，0.1 CTAB-1 → 0.1 CTAB）
    var m = /^(.*?)([-\s]?)([0-9]+|[A-Za-z])$/.exec(n);
    if (m && m[1] !== '' && m[1] !== n) {
      if (!(/^[A-Za-z]$/.test(m[3]) && m[2] === '')) return m[1]; // 无分隔符单词不剥
    }
    // 2) 头部数字前缀剥离（序号标前面：0.1 CTAB / 0.1CTAB / 0.5 Mod；2D/3D 等"数字+字母"不剥）
    //    完整小数（0.1/1.0）可紧跟主体（0.1CTAB）或带分隔；纯整数（1/2）必须带分隔符（1 sam）
    var hm = /^(?:(\d+\.\d+)[\s-]?|(\d+)[\s-])(.+)$/.exec(n);
    if (hm && hm[3] !== '') return hm[3];
    return null;
  }

  /** 系列尾部序号剥离（t95/t99：-N/空格N 后缀→主体——26-1/32-2/23-2 型用户习惯；纯数字/无分隔符字母不剥——
   *  与 seriesCore 通用剥离不同：浓度/前缀变体（0.1 Mod）与无分隔符字母（R1/R2）是不同条件不并）；
   *  detectGroupCandidates（候选弹窗）/seriesMerge（画板系列归并）/applyGroupDecisions（落地）统一判据。 */
  function seriesTailCore(name) {
    var base = String(name == null ? '' : name).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim();
    var m = /^(.*?)([-\s])([0-9]+)$/.exec(base);
    if (m && m[1] !== '' && m[1] !== base) return m[1]; // 分隔符（- / 空格）存在才剥
    return null;
  }

  function detectGroupCandidates(conditions) {
    var groups = {};
    (conditions || []).forEach(function (c) {
      var core = seriesTailCore(c.name);
      if (!core) return;
      if (!groups[core]) groups[core] = { core: core, names: {}, devices: 0 };
      groups[core].names[c.name] = true;
      groups[core].devices += (c.devices || []).length;
    });
    // t99：主体组纳入（23 与 23-2 同系列——主体自身参与——23/23-2 进候选不再残留）
    (conditions || []).forEach(function (c) {
      var base = String(c.name).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim();
      var g = groups[base];
      if (g && !g.names[c.name]) {
        g.names[c.name] = true;
        g.devices += (c.devices || []).length;
      }
    });
    var out = [];
    Object.keys(groups).forEach(function (core) {
      var g = groups[core];
      var names = Object.keys(g.names);
      if (names.length < 2) return; // 单成员无歧义，不提示
      out.push({ core: core, names: names, devices: g.devices });
    });
    return out;
  }

  function applyGroupDecisions(conditions, decisions) {
    var mergeCores = {};
    Object.keys(decisions || {}).forEach(function (k) {
      if (decisions[k] === 'merge') mergeCores[k] = true;
    });
    // t99：落地判据与候选统一（seriesTailCore——23/23-2 合并生效；无分隔符字母（R1/R2）不并）
    var result = conditions.filter(function (c) {
      var core = seriesTailCore(c.name);
      return !(core && mergeCores[core]);
    });
    Object.keys(mergeCores).forEach(function (core) {
      var members = conditions.filter(function (c) { return seriesTailCore(c.name) === core; });
      if (!members.length) return;
      var target = null;
      for (var i = 0; i < result.length; i++) {
        if (normalizeText(result[i].name) === core) { target = result[i]; break; }
      }
      if (!target) {
        target = {
          name: core, displayName: core,
          devices: [], maxDeviceIndex: -1, maxEff: -Infinity
        };
        placeMergedTarget(result, target, conditions, function (c) { return seriesCore(c.name) === core; });
      }
      mergeMembersInto(target, members);
    });
    return result;
  }

  /** 把成员条件的器件并入 target，打来源标（第三十七批：srcCond 供详情表标注与拆分还原） */
  function mergeMembersInto(target, members) {
    members.forEach(function (c) {
      if (normalizeText(c.name) === normalizeText(target.name)) return; // 目标自身
      target.devices = target.devices.concat(c.devices.map(function (d) {
        if (!d.srcCond) d.srcCond = c.name;
        return d;
      }));
      if (!target.mergedFrom) target.mergedFrom = [];
      if (target.mergedFrom.indexOf(c.name) < 0) target.mergedFrom.push(c.name);
    });
    target.merged = true;
    recalcMax(target);
  }

  /** 手动合并（方案 B）：memberNames 条件并入 targetName（无同名则新建），打来源标
   *  [DEPRECATED-MARK R3-merge]：左栏整理接 GroupModel 管道的快捷操作——本函数为「会话级合并」语义
   *  （target=组键、members=来源、mergedFrom/srcCond=明细），与 buildGroupModel→groupsToConditions 的
   *  条件级合并输出一致（同一数据模型：conditions 层的合并视图）；保留为死代码层对比（R3 收尾声明）。 */
  function mergeConditions(conditions, targetName, memberNames) {
    var names = Array.isArray(memberNames) ? memberNames : [];
    if (!names.length) return conditions.slice();
    var target = null;
    var result = conditions.filter(function (c) {
      if (normalizeText(c.name) === normalizeText(targetName)) { target = c; return true; }
      return names.indexOf(c.name) < 0;
    });
    if (!target) {
      target = {
        name: targetName, displayName: targetName,
        devices: [], maxDeviceIndex: -1, maxEff: -Infinity
      };
      placeMergedTarget(result, target, conditions, function (c) { return names.indexOf(c.name) >= 0; });
    }
    var members = conditions.filter(function (c) { return names.indexOf(c.name) >= 0 && normalizeText(c.name) !== normalizeText(targetName); });
    mergeMembersInto(target, members);
    return result;
  }

  /** 手动拆分（方案 B）：按 srcCond 把 merged 条件还原为独立条件；无标注器件留在原名条件 */
  function splitConditions(conditions, targetName) {
    var target = null;
    var rest = [];
    conditions.forEach(function (c) {
      if (normalizeText(c.name) === normalizeText(targetName)) target = c;
      else rest.push(c);
    });
    if (!target) return conditions.slice();
    var groups = {}, unlabeled = [];
    target.devices.forEach(function (d) {
      if (d.srcCond) {
        if (!groups[d.srcCond]) groups[d.srcCond] = [];
        groups[d.srcCond].push(d);
      } else unlabeled.push(d);
    });
    if (unlabeled.length) {
      var orphan = { name: target.name, displayName: target.displayName || target.name, devices: unlabeled, maxDeviceIndex: -1, maxEff: -Infinity };
      recalcMax(orphan);
      rest.push(orphan);
    }
    Object.keys(groups).forEach(function (src) {
      var c = { name: src, displayName: src, devices: groups[src], maxDeviceIndex: -1, maxEff: -Infinity };
      recalcMax(c);
      rest.push(c);
    });
    return rest;
  }

  /** 重算条件 maxEff/maxDeviceIndex（合并/拆分后统计必须与渲染一致） */
  function recalcMax(cond) {
    var bestIdx = -1, bestEff = -Infinity;
    cond.devices.forEach(function (d, i) {
      var e = deviceParam(d, 'pce');
      if (isNum(e) && e > bestEff) { bestEff = e; bestIdx = i; }
    });
    if (bestIdx >= 0) { cond.maxEff = bestEff; cond.maxDeviceIndex = bestIdx; }
  }

  /** 新建的合并目标条件插入到第一个被移除成员的原始位置（保持面板顺序连续） */
  function placeMergedTarget(result, target, conditions, memberOf) {
    for (var i = 0; i < conditions.length; i++) {
      if (memberOf(conditions[i])) {
        var pos = 0;
        for (var j = 0; j < i; j++) { if (!memberOf(conditions[j])) pos++; }
        result.splice(pos, 0, target);
        return;
      }
    }
    result.push(target);
  }

  /* ================================================================
   * 改动 1：统一参数取值入口（全项目唯一）
   *   pce：userEff → rawRevEff → revEff → rawFwdEff（正扫兜底）
   *   voc/jsc/ff：反扫有效用反扫，否则用正扫
   * ================================================================ */
  function deviceParam(device, key) {
    if (!device) return NaN;
    if (key === 'pce') {
      if (isNum(device.userEff)) return device.userEff;
      if (isNum(device.rawRevEff)) return device.rawRevEff;
      if (isNum(device.revEff)) return device.revEff;
      return device.rawFwdEff;
    }
    if (key === 'voc') return isNum(device.revVoc) ? device.revVoc : device.fwdVoc;
    if (key === 'jsc') return isNum(device.revJsc) ? device.revJsc : device.fwdJsc;
    if (key === 'ff') return isNum(device.revFF) ? device.revFF : device.fwdFF;
    return NaN;
  }

  /* ================================================================
   * CSV / TSV 文本 → 网格（二维字符串数组）
   * 分隔符自动识别：检测首段文本中逗号与 Tab 哪个更多
   * ================================================================ */
  function parseText(text, fileName) {
    var head = text.slice(0, 8000);
    var commas = (head.match(/,/g) || []).length;
    var tabs = (head.match(/\t/g) || []).length;
    var delim = tabs > commas ? '\t' : ',';
    var grid = delim === ',' ? parseCSV(text) : parseTSV(text);
    return grid;
  }

  function parseCSV(text) {
    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (ch === '\r') {
        // 忽略回车
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseTSV(text) {
    return text.split(/\r?\n/).map(function (line) { return line.split('\t'); });
  }

  /* ================================================================
   * 5.2 参数表头识别：找同时含 6 个必需字段的第一行
   * ================================================================ */
  var REQUIRED_HEADERS = ['Name', 'Voc (V)', 'Efficiency (%)', 'Fill Factor (%)', 'Jsc (mA/cm^2)', 'Area (cm^2)'];

  function findParamHeaderRow(grid) {
    for (var r = 0; r < grid.length; r++) {
      var row = grid[r] || [];
      var hit = true;
      var map = {};
      for (var h = 0; h < REQUIRED_HEADERS.length; h++) {
        var found = -1;
        for (var c = 0; c < row.length; c++) {
          if (normalizeText(row[c]).toLowerCase() === REQUIRED_HEADERS[h].toLowerCase()) { found = c; break; }
        }
        if (found < 0) { hit = false; break; }
        map[REQUIRED_HEADERS[h]] = found;
      }
      if (hit) {
        // V2/V1 等效电路诊断：可选读 Rs/Rsh 列（多数仪器格式带；缺失则 -1，不参与）
        map['Rs (ohm)'] = -1; map['Rsh (ohm)'] = -1;
        for (var c2 = 0; c2 < row.length; c2++) {
          var t = normalizeText(row[c2]).toLowerCase();
          if (t === 'rs (ohm)') map['Rs (ohm)'] = c2;
          else if (t === 'rsh (ohm)') map['Rsh (ohm)'] = c2;
        }
        return { row: r, map: map };
      }
    }
    return null;
  }

  /** P2 收敛：单行表头匹配内核（isParamRecord 行级收紧之外的结构级防线——多表头分段）
   *  性能：'Efficiency (%)' 长字面量预筛（每行仅查前 14 列——仪器参数表头在前两通道组内），
   *  命中率每段仅表头行 1 行；全行 6 字段复检仅对预筛命中行执行。 */
  function matchHeaderAt(grid, r) {
    var row = grid[r] || [];
    if (row.length < 6) return null;
    var preLimit = Math.min(row.length, 14);
    var hasEff = false;
    for (var c0 = 0; c0 < preLimit; c0++) {
      if (normalizeText(row[c0]).toLowerCase() === 'efficiency (%)') { hasEff = true; break; }
    }
    if (!hasEff) return null;
    var hit = true;
    var map = {};
    for (var h = 0; h < REQUIRED_HEADERS.length; h++) {
      var found = -1;
      for (var c = 0; c < row.length; c++) {
        if (normalizeText(row[c]).toLowerCase() === REQUIRED_HEADERS[h].toLowerCase()) { found = c; break; }
      }
      if (found < 0) { hit = false; break; }
      map[REQUIRED_HEADERS[h]] = found;
    }
    if (!hit) return null;
    // V2/V1 等效电路诊断：可选读 Rs/Rsh 列（多数仪器格式带；缺失则 -1，不参与）
    map['Rs (ohm)'] = -1; map['Rsh (ohm)'] = -1;
    for (var c2 = 0; c2 < row.length; c2++) {
      var t = normalizeText(row[c2]).toLowerCase();
      if (t === 'rs (ohm)') map['Rs (ohm)'] = c2;
      else if (t === 'rsh (ohm)') map['Rsh (ohm)'] = c2;
    }
    return { row: r, map: map };
  }

  /** P2 收敛：级联表头几何探测——找出全部参数表头行（拼接/续测文件每段一个）。
   *  记录行不可能同时含 6 个表头字面量（E36a 垃圾条件名序列佐证），误命中风险低；
   *  命中后跳过本行继续（表头行不会连续重复命中）。 */
  function findAllParamHeaderRows(grid) {
    var rows = [];
    var r = 0;
    while (r < grid.length) {
      var m = matchHeaderAt(grid, r);
      if (m) { rows.push(m); r = m.row + 1; }
      else r++;
    }
    return rows;
  }

  /* ================================================================
   * v1.1 名称解释器·差分聚类引擎（三维归并第 1 维：主键-通道档）
   *   名称模板识别：内置模板库（以「模板签名」键控，见 NAME_TEMPLATES）；
   *   方向（fwd/rev）与正反扫配对沿用解析器既有配对逻辑（不重造）；
   *   条件名=主键块原样（用户数据不翻译不规整）。
   *   优先级：用户规则（jv_name_rules / setNameRules）> 自动推断（模板库全匹配）> 旧行为。
   *   安全网：仅当「记录数 > 40 且全部记录名匹配同一模板」时自动归并（单模板高置信），否则回退基线。
   * ================================================================ */
  var NAME_CLUSTER_RE = /^(.+?)\.CH_Ref\((\d+)\)$/;

  /** 内置模板库（签名 ↔ 格式实例；roles.key=主键捕获组） */
  var NAME_TEMPLATES = [
    { id: 'ivs.chref', sig: '<key>.CH_Ref(<n>)', re: /^(.+?)\.CH_Ref\((\d+)\)$/, example: 'R1-1.CH_Ref(1)' },
    { id: 'ivs.chref.reverse', sig: '<key>.CH_Ref.Reverse(<n>)', re: /^(.+?)\.CH_Ref\.(Reverse|Forward)\((\d+)\)$/, example: '1.CH_Ref.Reverse(1)' },
    { id: 'ivs.chref.bracketed', sig: '<key> (<mid>.CH_Ref(<n>))', re: /^(.+?) \(.*?\.CH_Ref\(\d+\)\)$/, example: 'Sample-A 1 (X.CH_Ref(1))' },
    { id: 'proc.device', sig: '<key> Device <n>', re: /^(.+?)\s*Device\s+(\d+)$/, example: 'PVK-1 Device 3' }
  ];

  /** 差分聚类：遍历模板库，对名称集合推导模板签名与置信度（全部匹配=单模板高置信；否则 null 不介入） */
  function inferNameTemplate(names) {
    if (!names || !names.length) return null;
    for (var ti = 0; ti < NAME_TEMPLATES.length; ti++) {
      var tp = NAME_TEMPLATES[ti];
      var all = true;
      for (var i = 0; i < names.length; i++) {
        if (!tp.re.test(names[i])) { all = false; break; }
      }
      if (all) return { id: tp.id, cluster: tp.id, signature: tp.sig, groups: names.length, confidence: 'high', example: tp.example };
    }
    return null;
  }

  /** 模板键：名称 → 命中模板的组 1（主键原样）；不匹配返回 null。
   *  I3 修正（原 t17 ISSUE-1）：不再固定只用模板 1 的正则——遍历模板库取组 1（四模板组 1 均为主键），
   *  模板 2/3/4 的自动归并随之生效。 */
  function nameClusterKey(name) {
    for (var ti = 0; ti < NAME_TEMPLATES.length; ti++) {
      var m = NAME_TEMPLATES[ti].re.exec(name);
      if (m && m.length > 1) return m[1];
    }
    return null;
  }

  /** t55：仪器系统名（未命名器件）判据——名称核心 = 数字+空格序列 + .CH_Ref.Reverse/Forward(N)（'1.CH_Ref.Reverse(1)'/'1 1.CH_Ref.Forward(1)'/'1 3...' 等仪器默认编号，含空格复合）。
   *  带语义主键（25/17/R1-1/Sample-A/5% Mod-2 等字母）不受影响；无方向词（25.CH_Ref(1)）仍按常规归并。
   *  供预览分组（main.js computeGroups）与解析器共用——预览不独立成组（归属容器），与解析器容器语义一致。 */
  function isUnnamedSystemName(name) {
    var core = systemNameCore(name || '');
    var m = /^(\d+(?:\s+\d+)*)\s*\.CH_Ref\.(Reverse|Forward)\(\d+\)$/.exec(core);
    if (!m) return false;
    return /^[\d\s]+$/.test(m[1].trim()); // 主键全为数字+空格
  }

  /** v1.1-I3：多模板并存检测（预览触发用）——逐名命中模板库；
   *  single=全部命中同一模板（高置信）；mix=命中 ≥2 种模板；none=存在不命中（低置信/混杂）。 */
  function detectNameTemplateMix(names) {
    if (!names || !names.length) return { state: 'none', ids: [] };
    var ids = [];
    for (var i = 0; i < names.length; i++) {
      var hit = null;
      for (var ti = 0; ti < NAME_TEMPLATES.length; ti++) {
        if (NAME_TEMPLATES[ti].re.test(names[i])) { hit = NAME_TEMPLATES[ti].id; break; }
      }
      if (hit === null) return { state: 'none', ids: ids };
      if (ids.indexOf(hit) < 0) ids.push(hit);
    }
    return { state: ids.length === 1 ? 'single' : 'mix', ids: ids };
  }

  /** v1.1-I3：解析预览数据（每记录：原名/模板 id/主键/通道号/方向）——仅 records>40 时构建 */
  function buildNamePreview(records) {
    if (!records || records.length <= 40) return null;
    return records.map(function (r) {
      var tplId = null, key = null, ch = null, dir = '';
      for (var ti = 0; ti < NAME_TEMPLATES.length; ti++) {
        var m = NAME_TEMPLATES[ti].re.exec(r.name);
        if (m) {
          tplId = NAME_TEMPLATES[ti].id;
          key = m.length > 1 ? m[1] : r.name;
          // 通道/方向分解（模板 1/2 的 CH_Ref 参数与 Reverse/Forward 词）
          var cm = /\bCH_Ref\((\d+)\)/.exec(r.name);
          if (cm) ch = cm[1];
          var dm = /\b(Reverse|Forward)\b/.exec(r.name);
          if (dm) dir = dm[1];
          break;
        }
      }
      return { name: r.name, tplId: tplId, key: key, ch: ch !== null ? ch : '', dir: dir };
    });
  }

  /* -------- v1.1-I2 用户自定义规则（优先级：用户规则 > 自动推断 > 内置模板 > 旧行为） -------- */
  var nameRules = null; // {cond, ch, dir} 正则文本；null=未配置
  /* v1.1-I3：预览面板「应用并记住」的映射表（原名 → 条件名；最高优先，解析时直接取 key） */
  var nameManualMap = null;
  /* v1.2-I1：guided 块规则对象 { mode:'guided', parts:[{role,blockIndex,pattern}], compiled } */
  var guidedRule = null;
  /* R3/B：E36a 序号配对选项（默认关闭——不改变任何既有输出）——启用时：相邻同名（严格同名）且未判向的两条记录视为正反扫对（前正后反）
   * OBS-R7-2：本选项只对「原始文件」的相邻同名记录生效（原始 CSV/TXT→parseRawRecords 逐条记录的语境）；
   *   处理后文件（表格/汇总链路）不经过此配对；默认关闭，故任何基线输出不变。 */
  var pairAdjacentNames = false;
  function setPairingOption(v) { pairAdjacentNames = !!v; }
  function getPairingOption() { return pairAdjacentNames; }
  /** R3/B：E36a 序号配对——相邻同名（严格同名）且未判向的两条记录 → 前正后反（dir=1/-1——进入既有配对路径后 both/HI 可算）；返回配对数 */
  function applyAdjacentPairing(records) {
    var n = 0;
    for (var i = 0; i < records.length - 1; i++) {
      var a = records[i], b = records[i + 1];
      if (a.dir !== 0 || b.dir !== 0 || a.name === '' || a.name !== b.name) continue;
      a.dir = 1; b.dir = -1; // 仪器约定：同名两块相邻 = 正反扫对（Forward/Reverse）
      n++;
      i++;
    }
    return n;
  }

  /* ================================================================
   * v1.2-I1 块引擎（spec 6.1-6.4）：块切分 + 角色候选 + 内部规则对象 + 编译器 + 持久化
   *   块类型：sep（空白/点/括号外分隔）/ num（纯数字）/ word（含连字符的字母数字混）/ paren（括号块整体）
   * ================================================================ */
  function splitNameBlocks(name) {
    var s = String(name == null ? '' : name);
    var blocks = [];
    var i = 0, n = s.length;
    function isSep(ch) { return ch === ' ' || ch === '\t' || ch === '.'; }
    while (i < n) {
      var ch = s[i];
      if (isSep(ch)) {
        var j = i;
        while (j < n && isSep(s[j])) j++;
        blocks.push({ text: s.slice(i, j), start: i, end: j - 1, kind: 'sep' });
        i = j;
      } else if (ch === '(') {
        var k = i, depth = 0;
        do {
          if (s[k] === '(') depth++;
          else if (s[k] === ')') depth--;
          k++;
        } while (k < n && depth > 0);
        blocks.push({ text: s.slice(i, k), start: i, end: k - 1, kind: 'paren' });
        i = k;
      } else {
        var m = i;
        while (m < n && !isSep(s[m]) && s[m] !== '(' && s[m] !== ')') m++;
        var text = s.slice(i, m);
        // v1.2：word 无间隔紧接 '(' 括号 → 粘合为完整块（CH_Ref(1) 一块，kind='paren'——spec 6.2「CH_Ref(n) 完整块」）
        // v1.2 修正（t27 观察-1）：方向词不粘合（'Reverse(1)' 需拆成 word:Reverse + paren:(1)，让 direction 词独立可识别）
        if (m < n && s[m] === '(' && !/^(fwd|forward|rev|reverse)$/i.test(text)) {
          var k2 = m, depth2 = 0;
          do {
            if (s[k2] === '(') depth2++;
            else if (s[k2] === ')') depth2--;
            k2++;
          } while (k2 < n && depth2 > 0);
          blocks.push({ text: s.slice(i, k2), start: i, end: k2 - 1, kind: 'paren' });
          i = k2;
        } else {
          blocks.push({ text: text, start: i, end: m - 1, kind: /^\d+$/.test(text) ? 'num' : 'word' });
          i = m;
        }
      }
    }
    return blocks;
  }

  /** 角色候选引擎：每块 {recommended, alternatives, undecided}；
   *  paren 含 CH_Ref(n) → channel；num → channel|seq（紧邻 CH_Ref 則 channel）；fwd/rev 词 → direction；
   *  其余 word/num → cond（推荐）| ignored（备选）；sep → 无角色。 */
  function nameBlockRoles(name) {
    var blocks = splitNameBlocks(name);
    var out = [];
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      var rec = { blockIndex: bi, text: b.text, start: b.start, end: b.end, kind: b.kind, recommended: null, alternatives: [], undecided: false };
      if (b.kind === 'sep') { out.push(rec); continue; }
      var low = b.text.toLowerCase();
      var prev = bi > 0 ? blocks[bi - 1] : null;
      var next = bi < blocks.length - 1 ? blocks[bi + 1] : null;
      if (b.kind === 'paren' && /CH_Ref\(\d+\)/i.test(b.text)) {
        rec.recommended = 'channel'; rec.alternatives = ['ignored'];
      } else if (/^CH_Ref$/i.test(low)) {
        // v1.2 修正（t27 观察-1 连带）：CH_Ref 词块属通道标记（mid），不应误推荐 cond
        rec.recommended = 'ignored'; rec.alternatives = ['cond'];
      } else if (low === 'fwd' || low === 'forward' || low === 'rev' || low === 'reverse' || /^(fwd|forward|rev|reverse)[-_]\d+$/i.test(low)) {
        // v1.2 修正（t27 观察-2）：连字符/下划线方向段（'fwd-1'/'rev-2'）也识别为 direction
        rec.recommended = 'direction'; rec.alternatives = ['ignored'];
      } else if (b.kind === 'num' || (b.kind === 'paren' && /^\(\d+\)$/.test(b.text))) {
        var nearChRef = (prev && /CH_Ref/i.test(prev.text)) || (next && /CH_Ref/i.test(next.text));
        rec.recommended = nearChRef ? 'channel' : 'seq';
        rec.alternatives = ['channel', 'cond'];
        rec.undecided = !nearChRef; // 孤立数字：seq/channel/cond 均可能 → 未决
      } else {
        rec.recommended = 'cond'; rec.alternatives = ['ignored'];
      }
      out.push(rec);
    }
    return out;
  }

  /** guided 规则对象：{mode:'guided', parts:[{role,blockIndex,pattern}], compiled} */
  function setGuidedRule(rule) {
    guidedRule = (rule && rule.mode === 'guided' && rule.parts && rule.parts.length) ? rule : null;
  }
  function getGuidedRule() { return guidedRule ? JSON.parse(JSON.stringify(guidedRule)) : null; }
  /** guided 执行：条件键 = parts 中 role==='cond' 的块文本（按 blockIndex 原样），保持用户数据原样
   *  t65：语义名不取纯数字键（与预览 guideCondKeyFor 同判据）——cond 键为纯数字且名字无模板结构（CH_Ref/Device）→ 整名 */
  function guidedKey(name, rule) {
    var gr = (rule !== undefined && rule !== null) ? rule : guidedRule;
    if (!gr) return null;
    var blocks = splitNameBlocks(name);
    var key = '';
    for (var p = 0; p < gr.parts.length; p++) {
      var part = gr.parts[p];
      if (part.role !== 'cond') continue;
      var b = blocks[part.blockIndex];
      if (!b) return null; // 块索引越界（形状不匹配）→ 不归并（回退后续源）
      key += b.text;
    }
    if (key === '') return null;
    // t77：语义名整名判据（替代 t65/67 的「键无字母」代理判据）——名字无模板结构（CH_Ref/Device）→ 键=整名：
    // t67 判据对点分隔语义名失效（'MA0.05 150-1' 块0='MA0' 含字母 → 键撕裂 'MA0'）；模板命中型保持模板键
    if (!/(CH_Ref|Device)/.test(name)) return name;
    return key;
  }
  function loadGuidedRuleFromStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem('jv_name_rule_guided');
        if (raw) { var r = JSON.parse(raw); setGuidedRule(r); return; }
      }
    } catch (e) { /* 损坏 JSON 忽略 */ }
    guidedRule = null;
  }
  function saveGuidedRuleToStorage(rule) {
    try {
      if (typeof localStorage !== 'undefined') {
        if (rule && rule.mode === 'guided') localStorage.setItem('jv_name_rule_guided', JSON.stringify(rule));
        else localStorage.removeItem('jv_name_rule_guided');
      }
    } catch (e) { /* 忽略 */ }
    setGuidedRule(rule);
  }

  function setNameManualMap(map) {
    nameManualMap = (map && typeof map === 'object' && Object.keys(map).length) ? map : null;
  }
  function getNameManualMap() { return nameManualMap ? JSON.parse(JSON.stringify(nameManualMap)) : null; }
  function loadNameManualMapFromStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem('jv_name_rule_manual');
        if (raw) { setNameManualMap(JSON.parse(raw)); return; }
      }
    } catch (e) { /* 损坏 JSON 忽略 */ }
    nameManualMap = null;
  }
  function saveNameManualMapToStorage(map) {
    try {
      if (typeof localStorage !== 'undefined') {
        if (map && Object.keys(map).length) localStorage.setItem('jv_name_rule_manual', JSON.stringify(map));
        else localStorage.removeItem('jv_name_rule_manual');
      }
    } catch (e) { /* 忽略 */ }
    setNameManualMap(map);
  }

  function setNameRules(rules) {
    // rules: { cond:'...', ch:'...', dir:'...' }（字符串正则文本；cond 必填才有语义）
    nameRules = (rules && typeof rules.cond === 'string' && rules.cond !== '') ? { cond: rules.cond, ch: rules.ch || '', dir: rules.dir || '' } : null;
  }
  function getNameRules() { return nameRules ? { cond: nameRules.cond, ch: nameRules.ch, dir: nameRules.dir } : null; }

  /** 浏览器侧：设置面板保存/恢复 localStorage（jv_name_rules） */
  function loadNameRulesFromStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem('jv_name_rules');
        if (raw) {
          var r = JSON.parse(raw);
          setNameRules(r);
          return;
        }
      }
    } catch (e) { /* 损坏 JSON 忽略 */ }
    nameRules = null;
  }
  function saveNameRulesToStorage(rules) {
    try {
      if (typeof localStorage !== 'undefined') {
        if (rules && typeof rules.cond === 'string' && rules.cond !== '') localStorage.setItem('jv_name_rules', JSON.stringify({ cond: rules.cond, ch: rules.ch || '', dir: rules.dir || '' }));
        else localStorage.removeItem('jv_name_rules');
      }
    } catch (e) { /* 忽略 */ }
    setNameRules(rules);
  }

  /** 用户规则主键（组1 存在用组1，否则整匹配）；不匹配返回 null（该记录不参与规则归并） */
  function userRuleKey(name) {
    if (!nameRules) return null;
    var m;
    try {
      m = new RegExp(nameRules.cond).exec(name);
    } catch (e) { return null; } // 非法正则 → 忽略（不介入）
    if (!m) return null;
    var key = (m.length > 1 && m[1] !== undefined) ? m[1] : m[0];
    return key;
  }

  /* ================================================================
   * 5.3 参数记录判定：表头行之下，Name 非空且≥2 个数值字段，或（空名回退）任一数值字段为数值
   * ================================================================ */
  function isParamRecord(row, map) {
    var name = normalizeText(row[map['Name']]);
    var fs = ['Voc (V)', 'Efficiency (%)', 'Fill Factor (%)', 'Jsc (mA/cm^2)', 'Area (cm^2)'];
    if (name !== '') {
      // P2：Name 非空还需 ≥2 个参数列为数值——多文件拼接时通道字段行（Test Mode/Reverse data/Area…）
      // 落到表头之下，字段名进 Name 列曾被整行误收（垃圾条件 + 统计污染 + 渲染 10s 级放大）
      var nNum = 0;
      for (var i = 0; i < fs.length; i++) {
        if (isNum(toNumber(row[map[fs[i]]]))) nNum++;
      }
      return nNum >= 2;
    }
    return fs.some(function (f) { return isNum(toNumber(row[map[f]])); });
  }

  /* ================================================================
   * 格式 A：仪器原始格式解析（4.3-4.6、5.2-5.10）
   * ================================================================ */
  /** R1：格式 A records 提取段（原 parseRawFormat 前半——物理拆分，行为不变）；返回 null=表头缺失 */
  function parseRawRecords(grid) {
    /* P2 收敛：级联表头几何探测——多文件拼接/续测文件存在多个参数表头行，逐段（通道识别+字段解析+记录收集），
     * 段间记录合并后走原条件分组/配对逻辑（同名条件自动合并）。单表头文件 headers.length=1 时场景退化为原路径。
     * 段边界：下一段的 [Information]（首通道组）行——记录区在本段表头之后、下一段通道区之前。 */
    var headers = findAllParamHeaderRows(grid);
    if (!headers.length) return null;
    var maxCol = grid[0] ? grid[0].length : 0;
    /* 全网格段边界：每段通道区首行 = 首通道组 [Information] 行（c0 组必在段首；每行只查 col0） */
    var segInfoRows = [];
    for (var ri = 0; ri < grid.length; ri++) {
      var rc0 = grid[ri] || [];
      if (rc0.length && normalizeText(rc0[0]).toLowerCase() === '[information]') segInfoRows.push(ri);
    }
    var physOut = 0, dirInvalid = 0; // P3/P4：物理边界 / 方向标记无效计数（并入 stats.anomaly 初值）
    var channels = [];
    var records = [];

    for (var hi = 0; hi < headers.length; hi++) {
      var ph = headers[hi];
      var headerRow = ph.row, map = ph.map;
      var segStart = (hi === 0) ? 0 : headers[hi - 1].row + 1; // 本段起点 = 上一表头行的下一行
      /* 记录区段尾 = min(下一表头行-1, 下一段 [Information] 行-1)：前者覆盖「无通道段」（E28 第二表头），
       * 后者覆盖拼接文件（下一表头之前是下一段通道区）——双锚取先出现者；无下一段为文件尾 */
      var nextHeader = (hi < headers.length - 1) ? headers[hi + 1].row : grid.length;
      var segEnd = grid.length - 1;
      for (var qr = 0; qr < segInfoRows.length; qr++) {
        if (segInfoRows[qr] > headerRow) { segEnd = segInfoRows[qr] - 1; break; }
      }
      if (nextHeader - 1 < segEnd) segEnd = nextHeader - 1;

      /* ---- 5.4 原始通道识别（段内） ---- */
      var segChannels = [];
      for (var c = 0; c < maxCol; c++) {
        for (var r = segStart; r < headerRow; r++) {
          if (normalizeText(grid[r][c]).toLowerCase() === '[information]') {
            segChannels.push({ startCol: c, headerRow: r, isValid: false, jv: [], area: null });
            break;
          }
        }
      }
      for (var i = 0; i < segChannels.length; i++) {
        var ch = segChannels[i];
        var endCol = i < segChannels.length - 1 ? segChannels[i + 1].startCol - 1 : maxCol - 1;
        // 块内表头行定位三列
        var vCol = -1, iCol = -1, jCol = -1;
        for (var c2 = ch.startCol; c2 <= endCol && c2 < maxCol; c2++) {
          var t = normalizeText(grid[ch.headerRow][c2]).toLowerCase();
          if (t === '[volt (v)]') vCol = c2;
          else if (t === '[current (ma)]') iCol = c2;
          else if (t === '[j (ma/cm^2)]') jCol = c2;
        }
        if (vCol < 0 || iCol < 0 || jCol < 0) { ch.invalidReason = '缺JV列'; continue; } // 保留占位
        ch.isValid = true; ch.vCol = vCol; ch.iCol = iCol; ch.jCol = jCol;
        // JV 数据：表头行之下、段参数表头行之上，三列均数值的行
        for (var r2 = ch.headerRow + 1; r2 < headerRow; r2++) {
          var v = toNumber(grid[r2][vCol]), ic = toNumber(grid[r2][iCol]), jd = toNumber(grid[r2][jCol]);
          if (isNum(v) && isNum(ic) && isNum(jd)) ch.jv.push([v, ic, jd]);
        }
        // Area：块内字段名列（起始列）找 Area (cm^2)
        for (var r3 = ch.headerRow + 1; r3 < headerRow; r3++) {
          if (normalizeText(grid[r3][ch.startCol]).toLowerCase() === 'area (cm^2)') {
            ch.area = toNumber(grid[r3][ch.startCol + 1]);
            if (!isNum(ch.area)) ch.area = null;
            break;
          }
        }
        // Reverse data 字段（改动 1：单扫无方向标记时兜底判向；True→反扫、False→正扫、读不到→null）
        for (var r5 = ch.headerRow + 1; r5 < headerRow; r5++) {
          if (normalizeText(grid[r5][ch.startCol]).toLowerCase() === 'reverse data') {
            var rf = normalizeText(grid[r5][ch.startCol + 1]).toLowerCase();
            ch.reverseFlag = rf === 'true' ? true : (rf === 'false' ? false : null);
            if (ch.reverseFlag === null) dirInvalid++; // P4：Reverse data 字段存在但值非 true/false（方向标记无效应属用户应知事实，计数并入 anomaly）
            break;
          }
        }
        // t10（P2-2）：测量协议元数据——Step (V) / Delay (ms) / Temperature (degC) / Light Intensity (SUN)
        // 值取字段名右侧第 2 列（startCol+1）；供条件级协议一致性检查（迟滞指标跨协议不可比）
        for (var r6 = ch.headerRow + 1; r6 < headerRow; r6++) {
          var fname = normalizeText(grid[r6][ch.startCol]).toLowerCase();
          if (fname === 'step (v)') ch.stepV = toNumber(grid[r6][ch.startCol + 1]);
          else if (fname === 'delay (ms)') ch.delayMs = toNumber(grid[r6][ch.startCol + 1]);
          else if (fname === 'temperature (degc)') ch.tempDegC = toNumber(grid[r6][ch.startCol + 1]);
          else if (fname === 'light intensity (sun)') ch.lightSun = toNumber(grid[r6][ch.startCol + 1]);
        }
      }
      channels = channels.concat(segChannels);

      /* ---- 参数记录（段内；map 用本段表头，列布局不同的拼接段各自映射） ---- */
      var segRecStart = records.length;
      for (var r4 = headerRow + 1; r4 <= segEnd; r4++) {
        if (!isParamRecord(grid[r4], map)) continue;
        var name = normalizeText(grid[r4][map['Name']]);
        // R2：判向统一入口（resolveScanDir——判定序列与既有链一致：getScanDirection → 系统名 Reverse data 兜底 → JV 首末）
        var dir = getScanDirection(name);
        var ch0 = null;
        var jvDirAssigned = false;
        if (dir === 0 && isSystemNameLike(name)) {
          var segIdx = records.length - segRecStart; // P2 收敛：记录↔通道映射改为段内局部对齐（段间错位不再全局串位）
          ch0 = segChannels[segIdx];
          var s1 = resolveScanDir(name, ch0, null);
          dir = s1.dir; jvDirAssigned = s1.jvDirAssigned;
        } else if (dir === 0 && nameClusterKey(name) !== null) {
          var si2 = records.length - segRecStart;
          ch0 = segChannels[si2];
          var s2 = resolveScanDir(name, null, ch0);
          dir = s2.dir; jvDirAssigned = s2.jvDirAssigned;
        }
        var rec = {
          row: r4,
          pos: records.length,
          name: name,
          dir: dir,
          jvDirAssigned: jvDirAssigned,
          eff: toNumber(grid[r4][map['Efficiency (%)']]),
          voc: toNumber(grid[r4][map['Voc (V)']]),
          jsc: toNumber(grid[r4][map['Jsc (mA/cm^2)']]),
          ff: toNumber(grid[r4][map['Fill Factor (%)']]),
          area: toNumber(grid[r4][map['Area (cm^2)']]),
          // V2/V1 等效电路：Rs/Rsh（缺失列为 -1 → NaN）
          rs: map['Rs (ohm)'] >= 0 ? toNumber(grid[r4][map['Rs (ohm)']]) : NaN,
          rsh: map['Rsh (ohm)'] >= 0 ? toNumber(grid[r4][map['Rsh (ohm)']]) : NaN
        };
        // P3：物理边界计数（仅告警不改数据）——Area≤0 / Eff<0 / |Voc|>3V / |Jsc|>1000mA/cm²
        if ((isNum(rec.area) && rec.area <= 0) || (isNum(rec.eff) && rec.eff < 0) ||
            (isNum(rec.voc) && Math.abs(rec.voc) > 3) || (isNum(rec.jsc) && Math.abs(rec.jsc) > 1000)) {
          physOut++;
        }
        records.push(rec);
      }
    }
    return { records: records, channels: channels, physOut: physOut, dirInvalid: dirInvalid };
  }

  /** R1：条件分组/正反扫配对/JV 关联/统计（原 parseRawFormat 后半——唯一组装：parseFile 与 groupsToConditions 共用；行为不变） */
  function parseRawAssemble(pr) {
    var records = pr.records, channels = pr.channels, physOut = pr.physOut, dirInvalid = pr.dirInvalid;

    /* ---- 4.6 + 5.5 条件分组与正反扫配对（改动 1：落单降级为单方向器件） ---- */
    var conditions = [], conditionMap = {}, pendingForward = [];
    var stats = { conditionCount: 0, validDeviceCount: 0, paramRecordCount: records.length, channelCount: channels.length, unmatched: 0, anomaly: physOut + dirInvalid, areaFallback: 0, noRawData: 0, singleDir: 0 }; // P3/P4：异常初值并入；后续 HI/配对累加点均为 += 叠加不受影响
    var current = null;
    // R2：容器语义状态机——最近命名条件键（followers 归属）；与 current 同步维护（条件建立分支更新）。
    // 语义：系统名/回退容器行归属「最近命名的条件」（语义跟随，非位置依赖——R2 化声明；合并/重排段落后仍归属其 lastNamed）。
    var lastNamedKey = null;

    function freshCondition(name) {
      return { name: name, displayName: name, devices: [], maxDeviceIndex: -1, maxEff: -Infinity };
    }

    /** 构造器件：fwdRec/revRec 可为 null（单方向）；dir='both' 时计算 HI */
    function buildDevice(fwdRec, revRec, dir) {
      var d = {
        dir: dir,
        HI: null,
        fwdRow: fwdRec ? fwdRec.row : -1, fwdPos: fwdRec ? fwdRec.pos : -1,
        revRow: revRec ? revRec.row : -1, revPos: revRec ? revRec.pos : -1,
        userEff: null,
        fwd: null, rev: null
      };
      if (fwdRec) {
        d.fwdVoc = fwdRec.voc; d.fwdJsc = fwdRec.jsc; d.fwdFF = fwdRec.ff;
        d.rawFwdEff = fwdRec.eff;
      }
      if (revRec) {
        d.revVoc = revRec.voc; d.revJsc = revRec.jsc; d.revFF = revRec.ff;
        d.rawRevEff = revRec.eff; d.revArea = revRec.area;
      }
      if (dir === 'both') {
        if (!isNum(revRec.eff) || revRec.eff === 0) { d.HI = null; stats.anomaly++; }
        else if (!isNum(fwdRec.eff)) { d.HI = null; stats.anomaly++; }
        else { d.HI = Math.abs(fwdRec.eff - revRec.eff) / revRec.eff; }
      }
      return d;
    }

    /** 未配对的待配对正扫 → 转成单方向器件（dir:'fwd'），并参与最高判定 */
    function flushPendingForward() {
      while (pendingForward.length) {
        var f = pendingForward.pop();
        if (!current) { stats.unmatched++; continue; } // 理论上不会发生（仅在 current 存在后入栈）
        var dev = buildDevice(f, null, 'fwd');
        current.devices.push(dev);
        var effForMax = deviceParam(dev, 'pce');
        if (isNum(effForMax) && effForMax > current.maxEff) {
          current.maxEff = effForMax;
          current.maxDeviceIndex = current.devices.length - 1;
        }
      }
    }

    /* v1.2-I1 多源合一（优先级从高到低）：nameRules（正则）> guided（块规则对象）> manual（v1.1 行级映射）> 自动推断模板 > 旧行为。
     * 自动推断安全网：仅记录数 > 40 且全部名称匹配同一内置模板时介入（单模板高置信）；否则回退基线（48 用例/真实文件不变）。 */
    var clusterMode = null;      // 'user' | 'guided' | 'manual' | 模板 id
    var appliedTemplate = null;  // { source, id, signature } 透传
    if (nameRules) {
      // v1.1-I2 用户规则（正则）：最高优先（命中记录按规则主键归并，未命中保持原样——混合式安全）
      var userHit = 0;
      for (var __ui = 0; __ui < records.length; __ui++) {
        if (userRuleKey(records[__ui].name)) userHit++;
      }
      if (userHit) { // N-r6-1：非法/全不命中正则不置 user 模式（与 manual 分支 mapHit 预检同构）——appliedTemplate 不再声称未生效的规则
        clusterMode = 'user';
        appliedTemplate = { source: 'user', id: 'user.rule', signature: nameRules.cond || '(cond regex)' };
      }
    } else if (guidedRule) {
      // v1.2-I1 guided 块规则：次高（块索引越界记录回退后续源——混合式如 user）
      clusterMode = 'guided';
      appliedTemplate = { source: 'guided', id: 'guider.rule', signature: 'blocks:' + guidedRule.parts.map(function (p) { return p.role + '@' + p.blockIndex; }).join(',') };
    } else if (nameManualMap) {
      // v1.1-I3 预览「应用并记住」的映射：原名 → 条件名直取（全记录命中才激活）
      var mapHit = 0;
      for (var __mi = 0; __mi < records.length; __mi++) {
        if (nameManualMap[records[__mi].name] !== undefined) mapHit++;
      }
      if (mapHit && mapHit === records.length) {
        clusterMode = 'manual';
        appliedTemplate = { source: 'manual', id: 'user.manual', signature: '(preview map)' };
      }
    }
    if (!clusterMode && records.length > 40) {
      var __tmpl = inferNameTemplate(records.map(function (r) { return r.name; }));
      if (__tmpl) {
        clusterMode = __tmpl.id;
        appliedTemplate = { source: 'tpl', id: __tmpl.id, signature: __tmpl.signature };
      }
    }

    // R3/B：E36a 序号配对选项（默认 off——零差异）——开启时：相邻同名（严格同名）且未判向的两条记录视为正反扫对（前正后反）
    if (pairAdjacentNames) applyAdjacentPairing(records);

    for (var ri = 0; ri < records.length; ri++) {
      var rec = records[ri];
      // R1：唯一键判定（resolveConditionKey——从原内嵌 ck 链提取，行为等价）
      var rk = resolveConditionKey(rec, { mode: clusterMode, nameManualMap: nameManualMap });
      var ck = rk.key;
      var isSysGuided = rk.sys;
      if (rec.name !== '' && (rec.dir === 0 || ck !== null || clusterMode === 'user' || (clusterMode === 'guided' && !isSysGuided) || rec.jvDirAssigned === true)) {
        // v1.2：非聚类（mix/none 文件）的模板记录（dir 被 Bug1 JV 判向非 0）须进条件建立分支——否则全 unmatched 空守卫 NULL
        // user/guided 混合式下非命中记录（ck null，dir 可能已被 JV 判向非 0）同此；系统名记录（getScanDirection 判向）不受影响
        var key = ck !== null ? ('@cl:' + ck) : rec.name.toLowerCase();
        var isNewCond = !conditionMap[key];
        // BUG-R7-1：flush 分界改为「current 是否仍指向该键」——一行覆盖三形态：
        // 新条件出现 flush ✓（旧 pending 不落入新条件）；同键连续不 flush ✓（Bug1：模板记录同名两块正反配对保持）；
        // 同键跨段（A→B→A）flush ✓（current 已离开该键——上次遗留 pending 清空，不再错误并入重访条件——RA1 BASE×5+X×41+BASE×5 型）
        if (conditionMap[key] !== current) flushPendingForward();
        current = conditionMap[key];
        if (isNewCond) {
          current = freshCondition(ck !== null ? ck : rec.name); // 条件名=主键块原样（用户数据不规整）
          conditionMap[key] = current;
          conditions.push(current);
        }
        lastNamedKey = key; // R2：最近命名条件键（容器 followers 归属目标）
        if (rec.dir === 0) rec.dir = 1; // 条件首条按正扫（Bug1：模板记录已由 JV 首末 V 判向时不再拍平——否则破坏同名两块正反配对）
      }
      if (!current) { stats.unmatched++; continue; } // 条件出现前的系统记录（lastNamedKey 亦 null——容器无归属目标）
      if (rec.dir === 1) {
        pendingForward.push(rec);
      } else if (rec.dir === -1) {
        if (pendingForward.length === 0) {
          // 落单反扫 → 单方向器件（dir:'rev'）
          var revDev = buildDevice(null, rec, 'rev');
          current.devices.push(revDev);
          var effRev = deviceParam(revDev, 'pce');
          if (isNum(effRev) && effRev > current.maxEff) {
            current.maxEff = effRev;
            current.maxDeviceIndex = current.devices.length - 1;
          }
          continue;
        }
        var fwd = pendingForward.pop();
        var rev = rec;
        var device = buildDevice(fwd, rev, 'both');
        current.devices.push(device);
        var effForMax = deviceParam(device, 'pce');
        if (isNum(effForMax) && effForMax > current.maxEff) {
          current.maxEff = effForMax;
          current.maxDeviceIndex = current.devices.length - 1;
        }
      } else {
        stats.anomaly++;
      }
    }
    // 文件结束：剩余待配对正扫转单方向
    flushPendingForward();
    stats.conditionCount = conditions.length;

    /* ---- JV 数据与 Area 关联到器件（记录顺序 ↔ 通道顺序） ---- */
    for (var ci = 0; ci < conditions.length; ci++) {
      var cond = conditions[ci];
      for (var di = 0; di < cond.devices.length; di++) {
        var dev = cond.devices[di];
        var fwdCh = dev.fwdPos >= 0 && dev.fwdPos < channels.length ? channels[dev.fwdPos] : null;
        var revCh = dev.revPos >= 0 && dev.revPos < channels.length ? channels[dev.revPos] : null;
        dev.fwd = { points: fwdCh ? fwdCh.jv : [], area: fwdCh && isNum(fwdCh.area) ? fwdCh.area : null };
        dev.rev = { points: revCh ? revCh.jv : [], area: revCh && isNum(revCh.area) ? revCh.area : null };
        // t10（P2-2）：协议元数据关联（反扫优先，回退正扫）——条件级协议一致性检查用
        var mkProto = function (ch) { return ch ? { stepV: ch.stepV, delayMs: ch.delayMs, tempDegC: ch.tempDegC, lightSun: ch.lightSun } : null; };
        dev.protoRev = mkProto(revCh); dev.protoFwd = mkProto(fwdCh);
        var proto = revCh && isNum(revCh.stepV) ? revCh : (fwdCh && isNum(fwdCh.stepV) ? fwdCh : null);
        if (proto) {
          dev.stepV = proto.stepV; dev.delayMs = proto.delayMs; dev.tempDegC = proto.tempDegC; dev.lightSun = proto.lightSun;
        }
        // V2/V1 等效电路：Rs/Rsh（反扫优先，与 PCE 取数方向一致；缺失 NaN）
        var fr = dev.fwdPos >= 0 && records[dev.fwdPos] ? records[dev.fwdPos] : null;
        var rr = dev.revPos >= 0 && records[dev.revPos] ? records[dev.revPos] : null;
        var fRs = fr ? fr.rs : NaN, fRsh = fr ? fr.rsh : NaN;
        var rRs = rr ? rr.rs : NaN, rRsh = rr ? rr.rsh : NaN;
        dev.rs = isNum(rRs) ? rRs : fRs;
        dev.rsh = isNum(rRsh) ? rRsh : fRsh;
        // t8-2：方向级 Rs/Rsh（每通道参数表行各自有值）——正扫修正/展示用正扫自己的值
        if (fr) { dev.fwd.rs = fRs; dev.fwd.rsh = fRsh; }
        if (rr) { dev.rev.rs = rRs; dev.rev.rsh = rRsh; }
        // t9（专家审阅 P0-1）：面积归一化 Rs/Rsh = 原始值 × 器件面积（若仪器给的是绝对 Ω）
        // 面积取该器件有效面积（反扫优先，回退正扫）；审阅实测：本批 A=0.0625 cm²，Rs·A 中位≈1.94 Ω·cm²
        var devA = isNum(dev.rev && dev.rev.area) ? dev.rev.area : (isNum(dev.fwd && dev.fwd.area) ? dev.fwd.area : NaN);
        dev.area = devA; // 器件级面积（供展示/归一化口径）
        dev.rsArea = isNum(dev.rs) && isNum(devA) ? dev.rs * devA : NaN;
        dev.rshArea = isNum(dev.rsh) && isNum(devA) ? dev.rsh * devA : NaN;
        // Area 回退：通道块无 Area → 用参数记录 Area（单方向器件仅回退存在的方向）
        if (dev.fwdPos >= 0 && !isNum(dev.fwd.area)) {
          if (isNum(records[dev.fwdPos] && records[dev.fwdPos].area)) dev.fwd.area = records[dev.fwdPos].area;
          stats.areaFallback++;
        }
        if (dev.revPos >= 0 && !isNum(dev.rev.area)) {
          if (isNum(records[dev.revPos] && records[dev.revPos].area)) dev.rev.area = records[dev.revPos].area;
          stats.areaFallback++;
        }
        // 器件参数 Area 回退（单方向 rev 器件无 revArea 属正常，不计 anomaly）
        if (dev.revPos >= 0 && !isNum(dev.revArea)) {
          if (isNum(records[dev.revPos] && records[dev.revPos].area)) dev.revArea = records[dev.revPos].area;
          else stats.anomaly++;
        }
      }
    }

    // 有效器件数（含单方向）；单方向计数
    for (var ci2 = 0; ci2 < conditions.length; ci2++) {
      stats.validDeviceCount += conditions[ci2].devices.length;
      for (var di2 = 0; di2 < conditions[ci2].devices.length; di2++) {
        if (conditions[ci2].devices[di2].dir !== 'both') stats.singleDir++;
      }
    }
    // 无法输出原始数据的通道数
    stats.noRawData = channels.filter(function (c) { return !c.isValid; }).length;

    // P1：空壳文件守卫——只有表头行/全部通道无 JV 数据（conditions 为空）按「无法解析」处理，
    // 避免 0 条件走成功路径显示绿色「解析完成」却无任何图表（E02/E23/E39）
    if (!conditions.length) return null;

    return {
      fileName: '',
      sourceFormat: 'raw',
      conditions: conditions,
      stats: stats,
      appliedTemplate: appliedTemplate, // v1.1-I2：模板命中信息透传（{source:'user'|'tpl', id, signature} 或 null）
      namePreview: buildNamePreview(records) // v1.1-I3：解析预览（原名/模板/主键/通道/方向；>40 记录才附）
    };
  }

  /** R3 收尾：R1 分组模型重构的拆分解耦已完成——parseFile/parseRawFormat 与模型管线（buildGroupModel→groupsToConditions）
   * 共享同一判定（resolveConditionKey/resolveScroll 系列）与同一组装（parseRawRecords/parseRawAssemble）——单一实现达成，
   * 无旧路径死代码残留（标记 [DEPRECATED-MARK R2] 在 R1/R2 全绿后确认解除：保留函数均为在用入口，非死代码）。 */
  function parseRawFormat(grid) {
    var pr = parseRawRecords(grid);
    if (!pr) return null;
    return parseRawAssemble(pr);
  }

  /* ================================================================
   * 格式 B：处理后 CSV 解析（详情表 + 每条件最高器件 JV 曲线 + 汇总表）
   * ================================================================ */
  function parseProcessedFormat(grid) {
    // 1. 详情表头行：Device | Voc (V) | Jsc (mA/cm^2) | Fill Factor (%) | Efficiency (%) | HI
    var headerRow = -1;
    for (var r = 0; r < grid.length; r++) {
      var row = grid[r];
      if (normalizeText(row[0]).toLowerCase() === 'device' &&
          normalizeText(row[1]).toLowerCase() === 'voc (v)' &&
          normalizeText(row[2]).toLowerCase() === 'jsc (ma/cm^2)' &&
          normalizeText(row[3]).toLowerCase() === 'fill factor (%)' &&
          normalizeText(row[4]).toLowerCase() === 'efficiency (%)' &&
          normalizeText(row[5]).toLowerCase() === 'hi') {
        headerRow = r; break;
      }
    }
    if (headerRow < 0) return null;

    // 2. 条件名行：表头行上方最近的非空行；其非空单元格中，列位置 > 0 的即各 JV 区起始列
    var nameRow = headerRow - 1;
    while (nameRow > 0 && (grid[nameRow] || []).every(function (c) { return normalizeText(c) === ''; })) nameRow--;
    var jvCols = [];
    var nonEmpty = [];
    for (var c0 = 0; c0 < (grid[nameRow] || []).length; c0++) {
      var t0 = normalizeText(grid[nameRow][c0]);
      if (t0 !== '') nonEmpty.push({ col: c0, name: t0 });
    }
    // 第一个非空列（列 0）是详情区名；其后每 7 列一个 JV 区
    if (nonEmpty.length > 1) {
      var startCol = nonEmpty[1].col;
      for (var c1 = startCol; c1 < (grid[nameRow] || []).length; c1 += 7) {
        var t1 = normalizeText(grid[nameRow][c1]);
        if (t1 === '') break;
        jvCols.push({ col: c1, name: t1 });
      }
    }

    // 3. 详情块解析：'Device' 表头行 → 器件行（数字序号）→ 'Average' 行结束
    var blocks = [];
    var curDevices = null;
    for (var r2 = headerRow; r2 < grid.length; r2++) {
      var row2 = grid[r2];
      var d0 = normalizeText(row2[0]);
      var isHeader = d0.toLowerCase() === 'device' && normalizeText(row2[1]).toLowerCase() === 'voc (v)';
      if (isHeader) { curDevices = []; blocks.push(curDevices); continue; }
      if (curDevices === null) continue;
      if (/^\d+$/.test(d0)) {
        curDevices.push({
          voc: toNumber(row2[1]),
          jsc: toNumber(row2[2]),
          ff: toNumber(row2[3]),
          effDisplay: toNumber(row2[4]),
          hi: toNumber(row2[5]),
          revEff: isNum(toNumber(row2[7])) ? toNumber(row2[7]) : toNumber(row2[4]) // 列 7 = 未舍入反扫效率
        });
      }
      // Average / 条件标记 / 空行：跳过
    }

    // 4. JV 区解析：'[Volt (V)]' 表头行之下为数据点（正扫 3 列 + 反扫 3 列）
    var jvCurves = [];
    for (var k = 0; k < jvCols.length; k++) {
      var jc = jvCols[k];
      var vHeader = -1;
      for (var r3 = nameRow; r3 < grid.length; r3++) {
        if (normalizeText(grid[r3][jc.col]).toLowerCase() === '[volt (v)]') { vHeader = r3; break; }
      }
      var fwd = [], rev = [];
      if (vHeader >= 0) {
        for (var r4 = vHeader + 1; r4 < grid.length; r4++) {
          var g = grid[r4];
          var v1 = toNumber(g[jc.col]), i1 = toNumber(g[jc.col + 1]), j1 = toNumber(g[jc.col + 2]);
          var v2 = toNumber(g[jc.col + 3]), i2 = toNumber(g[jc.col + 4]), j2 = toNumber(g[jc.col + 5]);
          if (isNum(v1) && isNum(i1) && isNum(j1)) fwd.push([v1, i1, j1]);
          if (isNum(v2) && isNum(i2) && isNum(j2)) rev.push([v2, i2, j2]);
          // 该区 6 列全空 → 数据结束
          if (normalizeText(g[jc.col]) === '' && normalizeText(g[jc.col + 1]) === '' && normalizeText(g[jc.col + 2]) === '' &&
              normalizeText(g[jc.col + 3]) === '' && normalizeText(g[jc.col + 4]) === '' && normalizeText(g[jc.col + 5]) === '') break;
        }
      }
      // Area 与效率标题（正扫区在 jc.col，反扫区在 jc.col+3）
      var area = null, fwdEff = null, revEff = null;
      for (var r5 = nameRow; r5 < (vHeader >= 0 ? vHeader : grid.length); r5++) {
        for (var cc = 0; cc <= 3; cc += 3) {
          var col = jc.col + cc;
          var f = normalizeText(grid[r5][col]);
          var fl = f.toLowerCase();
          if (fl === 'area (cm^2)') { area = toNumber(grid[r5][col + 1]); }
          else if (fl.indexOf('正扫') >= 0 || fl.indexOf('forward') >= 0) {
            var mf = /[Ee]fficiency[：:]\s*([\d.]+)/.exec(f);
            if (mf) fwdEff = parseFloat(mf[1]);
          } else if (fl.indexOf('反扫') >= 0 || fl.indexOf('reverse') >= 0) {
            var mr = /[Ee]fficiency[：:]\s*([\d.]+)/.exec(f);
            if (mr) revEff = parseFloat(mr[1]);
          }
        }
      }
      jvCurves.push({ fwd: fwd, rev: rev, area: isNum(area) ? area : null, fwdEff: fwdEff, revEff: revEff });
    }

    // 5. 组装 conditions（条件名以 JV 区为准；JV 曲线赋给最高器件）
    var conditions = [];
    var stats = { conditionCount: 0, validDeviceCount: 0, paramRecordCount: 0, channelCount: 0, unmatched: 0, anomaly: 0, areaFallback: 0, noRawData: 0, singleDir: 0 };
    for (var k2 = 0; k2 < jvCols.length; k2++) {
      var devList = (blocks[k2] || []).map(function (d) {
        return {
          dir: 'both', // 处理后 CSV 均为反扫参数（配对器件口径）
          revVoc: d.voc, revJsc: d.jsc, revFF: d.ff, revEff: d.revEff,
          HI: d.hi, userEff: null, fwd: null, rev: null
        };
      });
      var maxIdx = -1, maxEff = -Infinity;
      for (var di = 0; di < devList.length; di++) {
        if (isNum(devList[di].revEff) && devList[di].revEff > maxEff) { maxEff = devList[di].revEff; maxIdx = di; }
      }
      if (maxIdx >= 0 && jvCurves[k2]) {
        devList[maxIdx].fwd = { points: jvCurves[k2].fwd, area: jvCurves[k2].area };
        devList[maxIdx].rev = { points: jvCurves[k2].rev, area: jvCurves[k2].area };
      }
      conditions.push({ name: jvCols[k2].name, displayName: jvCols[k2].name, devices: devList, maxDeviceIndex: maxIdx, maxEff: maxEff, titleFwdEff: jvCurves[k2].fwdEff, titleRevEff: jvCurves[k2].revEff });
      stats.validDeviceCount += devList.length;
      stats.paramRecordCount += devList.length;
    }
    stats.conditionCount = conditions.length;
    stats.noRawData = stats.validDeviceCount - conditions.length; // 仅最高器件有原始数据

    if (!conditions.length) return null; // P1：同 parseRawFormat（格式 B 只有表头，E39）

    return {
      fileName: '',
      sourceFormat: 'processed',
      conditions: conditions,
      stats: stats,
      appliedTemplate: null // 格式 B 无差分聚类模板
    };
  }

  /* ================================================================
   * 4.1 编码自动识别：先按 UTF-8 读，出现大量乱码（U+FFFD）则按 GBK 重读
   * ================================================================ */
  function decodeBufferText(buf) {
    var utf8 = new TextDecoder('utf-8').decode(buf);
    var repl = (utf8.match(/\uFFFD/g) || []).length;
    if (repl === 0) return utf8;
    try {
      var gbk = new TextDecoder('gbk').decode(buf);
      var repl2 = (gbk.match(/\uFFFD/g) || []).length;
      return repl2 < repl ? gbk : utf8;
    } catch (e) {
      return utf8;
    }
  }

  /* ================================================================
   * 入口：识别格式并解析
   * ================================================================ */
  function parseGrid(grid, fileName) {
    var result = parseRawFormat(grid);
    if (result) {
      result.fileName = fileName || '';
      return result;
    }
    result = parseProcessedFormat(grid);
    if (result) {
      result.fileName = fileName || '';
      return result;
    }
    return null;
  }

  /** R1：集群模式判定（从 parseRawFormat 的条件判定段提取——行为不变；rules 显式覆盖模块态，缺省用模块态） */
  function resolveMode(records, rules) {
    var nR = (rules && rules.nameRules !== undefined) ? rules.nameRules : nameRules;
    var gR = (rules && rules.guidedRule !== undefined) ? rules.guidedRule : guidedRule;
    var mM = (rules && rules.nameManualMap !== undefined) ? rules.nameManualMap : nameManualMap;
    var mode = null, applied = null;
    if (nR) {
      var uh = 0;
      for (var i = 0; i < records.length; i++) { if (userRuleKey(records[i].name)) uh++; }
      if (uh) { mode = 'user'; applied = { source: 'user', id: 'user.rule', signature: nR.cond || '(cond regex)' }; }
    } else if (gR) {
      mode = 'guided';
      applied = { source: 'guided', id: 'guider.rule', signature: 'blocks:' + gR.parts.map(function (p) { return p.role + '@' + p.blockIndex; }).join(',') };
    } else if (mM) {
      var mh = 0;
      for (var j = 0; j < records.length; j++) { if (mM[records[j].name] !== undefined) mh++; }
      if (mh && mh === records.length) { mode = 'manual'; applied = { source: 'manual', id: 'user.manual', signature: '(preview map)' }; }
    }
    if (!mode && records.length > 40) {
      var t = inferNameTemplate(records.map(function (r) { return r.name; }));
      if (t) { mode = t.id; applied = { source: 'tpl', id: t.id, signature: t.signature }; }
    }
    return { mode: mode, applied: applied, nameManualMap: mM };
  }

  /** R1：组模型构建（归属层）——records 提取 + resolveConditionKey 全量 + 组聚合/系统名跟随视图
   *  返回：{ records, channels, physOut, dirInvalid, mode, nameManualMap, appliedTemplate, groups, keyOrder, fileName }
   *  groups[i] = { key, name, members:[ri], followers:[ri] }（members=命名记录行；followers=容器/回退行——跟随最近命名组）
   *  注：本模型是「归属视图」——条件装配（配对/JV/统计）由 groupsToConditions（唯一转换）完成。
   *  OBS-R7-3：本函数的「组键」是条件名层次的键（gKey = resolveConditionKey 产出 / 全小写记录名兜底），
   *    即「记录名 → 条件名」映射后的条件名，而非原始记录名；组名取该组首条命名的记录名（rec.name），
   *    members 存的也是记录索引（ri）而非器件名/记录名——与组装器 parseRawAssemble 的键判定语义保持一致。 */
  function buildGroupModel(rawText, fileName, rules) {
    var grid = parseText(rawText, fileName == null ? '' : fileName);
    var pr = parseRawRecords(grid);
    if (!pr) return null;
    var rm = resolveMode(pr.records, rules);
    var groups = [], byKey = {};
    var keyOrder = [];
    var lastNamed = null;
    pr.records.forEach(function (rec, ri) {
      var rk = resolveConditionKey(rec, { mode: rm.mode, nameManualMap: rm.nameManualMap, guidedRule: rm.guidedRule });
      var gKey = rk.key;
      // 复刻组装器的「进条件分支」键判定（L1027-1032）：ck 为 null 时，dir=0（新命名）→ 全文小写键；其余回退容器
      if (gKey === null && rec.name !== '' && (rec.dir === 0 || rm.mode === 'user' || (rm.mode === 'guided' && !rk.sys) || rec.jvDirAssigned === true)) {
        gKey = rec.name.toLowerCase();
      }
      if (gKey !== null) {
        lastNamed = gKey;
        if (!byKey[gKey]) {
          byKey[gKey] = { key: gKey, name: rec.name, members: [], followers: [] };
          keyOrder.push(gKey);
        }
        byKey[gKey].members.push(ri);
      } else {
        // 容器/回退行（系统名 guided 回退/手动恒等方向回退/键空）→ 跟随最近命名组（与组装器「current 容器」语义一致的模型视图；
        // R2 顺序无关化即此 follow 跟踪的强化）
        if (lastNamed && byKey[lastNamed]) byKey[lastNamed].followers.push(ri);
        else lastNamed = null; // 前置无命名组 → 无跟随（组装器 unmatched 语义的模型视图）
      }
    });
    keyOrder.forEach(function (k) { groups.push(byKey[k]); });
    return {
      records: pr.records, channels: pr.channels, physOut: pr.physOut, dirInvalid: pr.dirInvalid,
      mode: rm.mode, nameManualMap: rm.nameManualMap, appliedTemplate: rm.applied,
      groups: groups, keyOrder: keyOrder, fileName: fileName || ''
    };
  }

  /** R1：模型→条件的唯一转换（行为等价——条件装配 = 原组装器 parseRawAssemble）
   *  注意：组装器内的 clusterMode 判定用模块态 rules（main.js 应用/恢复链先 setNameManualMap 等——与旧 parseFile 路径一致）。 */
  function groupsToConditions(model) {
    var r = parseRawAssemble(model);
    if (r) r.fileName = model.fileName || '';
    return r;
  }

  function parseFile(text, fileName) {
    var grid = parseText(text, fileName);
    return parseGrid(grid, fileName);
  }

  /* ========== 导出（浏览器挂 window，Node 挂 globalThis） ========== */
  global.JVParser = {
    parseFile: parseFile,
    parseText: parseText,
    parseGrid: parseGrid,
    decodeBufferText: decodeBufferText,
    normalizeText: normalizeText,
    toNumber: toNumber,
    isNum: isNum,
    roundSig: roundSig,
    roundSigText: roundSigText,
    quartiles: quartiles,
    boxStats: boxStats,
    whiskers: whiskers,
    getScanDirection: getScanDirection,
    deviceParam: deviceParam,
    isSystemNameLike: isSystemNameLike,
    seriesCore: seriesCore,
    seriesTailCore: seriesTailCore, // t99：系列尾部序号剥离（候选/系列归并/落地统一判据）
    detectGroupCandidates: detectGroupCandidates,
    // v1.1 名称解释器·差分聚类引擎 API
    NAME_CLUSTER_RE: NAME_CLUSTER_RE,
    NAME_TEMPLATES: NAME_TEMPLATES,
    inferNameTemplate: inferNameTemplate,
    nameClusterKey: nameClusterKey,
    isUnnamedSystemName: isUnnamedSystemName,
    setNameRules: setNameRules,
    getNameRules: getNameRules,
    loadNameRulesFromStorage: loadNameRulesFromStorage,
    saveNameRulesToStorage: saveNameRulesToStorage,
    userRuleKey: userRuleKey,
    detectNameTemplateMix: detectNameTemplateMix,
    buildNamePreview: buildNamePreview,
    // v1.2-I1 块引擎 API
    splitNameBlocks: splitNameBlocks,
    nameBlockRoles: nameBlockRoles,
    setGuidedRule: setGuidedRule,
    getGuidedRule: getGuidedRule,
    guidedKey: guidedKey,
    loadGuidedRuleFromStorage: loadGuidedRuleFromStorage,
    saveGuidedRuleToStorage: saveGuidedRuleToStorage,
    setNameManualMap: setNameManualMap,
    getNameManualMap: getNameManualMap,
    loadNameManualMapFromStorage: loadNameManualMapFromStorage,
    saveNameManualMapToStorage: saveNameManualMapToStorage,
    applyGroupDecisions: applyGroupDecisions,
    mergeConditions: mergeConditions,
    splitConditions: splitConditions,
    // R1：分组决策模型
    resolveConditionKey: resolveConditionKey,
    resolveMode: resolveMode,
    buildGroupModel: buildGroupModel,
    groupsToConditions: groupsToConditions,
    // R2：判向统一入口
    resolveScanDir: resolveScanDir,
    // R3/B：E36a 序号配对选项
    setPairingOption: setPairingOption,
    getPairingOption: getPairingOption,
    applyAdjacentPairing: applyAdjacentPairing
  };

})(typeof window !== 'undefined' ? window : globalThis);
