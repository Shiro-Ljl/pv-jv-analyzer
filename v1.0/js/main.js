/**
 * main.js —— 入口：事件绑定、状态管理、联动调度（实施规格书第 7 章）
 *
 *   状态：files[]（每个文件一份 fileData）、currentIndex、prefs（条件勾选/改名/首个条件记忆）
 *   调度：解析 → 警告条 → 条件面板 → S2 汇总/箱线图 → S3 详情 → S4 JV
 *   联动：详情表 Efficiency 编辑 → 重算最高器件 → 汇总表/箱线图刷新（5.8）
 */
(function (global) {
  'use strict';

  var P = global.JVParser;
  var T = global.JVTable;
  var C = global.JVChart;
  var UI = global.JVUI;

  /* ---------- 主题色 ----------
   * 表格用 9.4 柔和色板，图表用 8.3 饱和色板；按「显示顺序」索引分配（与 Origin 一致） */
  var THEME = {
    soft: ['#C6E0B4', '#BDD7EE', '#FFE699', '#F4B084', '#D9D2E9', '#B4E5DE', '#F8CBAD', '#D6DCE5', '#FFC7CE', '#E2EFDA'],
    chart: ['#8A8F98', '#E2574C', '#3B82F6', '#22A06B', '#E8912D', '#7C6BD9', '#2AA7B8', '#8D6E63', '#D4568F', '#7A9E42'] // 第八批：微调色板（保持灰/红/蓝/绿前四顺序）
  };
  function softColor(i) { return THEME.soft[i % THEME.soft.length]; }
  // 第二十四批：chartColor 读 chartStyle 调色板（PALETTES.origin = THEME.chart 微调色板，零回归）
  // 第二十五批：condName 命中 condColors 时返回该条件指定色（面板色块/banner 与图一致）
  function chartColor(i, condName) {
    if (condName && C.chartStyle.condColors && C.chartStyle.condColors[condName]) {
      return C.chartStyle.condColors[condName];
    }
    var p = C.PALETTES[C.chartStyle.palette] || C.PALETTES.origin;
    return p[i % p.length];
  }

  var state = {
    files: [],            // [{ name, data }]
    currentIndex: -1,
    prefs: {},            // 条件名(小写) → { checked, displayName, first }
    options: { meanMark: true, rawPoints: true },
    axisTitlePos: 'left', // 第十六批：固定纵轴左侧（删除切换 UI 与 localStorage）
    // 第十六批：JV 图固定聚焦第四象限（删除切换按钮与 jvFoci）
    view: 'combined',     // 'single' | 'combined' | 'jv'（箱线图/JV 叠加视图；默认合并，第十八批；P5 三态）
    jvOverlay: { direction: 'rev', selNames: null }, // P5：叠加图方向 + 二次筛选（null=全部已勾选）
    detailSel: {}, // P5：详情 JV 图选中器件（条件名 → devIdx）
    chartInstances: [],   // 当前页所有 ECharts 实例（统一 resize/销毁）
    condMergeMode: false, // 第三十七批方案B：条件整理模式（合并选择）
    condMergeSelected: [] // 整理模式下被选中的条件名
  };

  function $(id) { return document.getElementById(id); }

  /* ================================================================
   * 条件偏好（按条件名记忆，跨文件保持同名条件状态，7.2）
   * ================================================================ */
  function getPref(cond) {
    var key = String(cond.name || cond.displayName || '').toLowerCase();
    if (!state.prefs[key]) state.prefs[key] = { checked: true, displayName: cond.name, first: false };
    return state.prefs[key];
  }

  /** 显示顺序：首个条件排最前，其余按原始顺序（7.3） */
  function orderedConditions(data) {
    // 第十八批：与 ui.js orderConditions 同逻辑——prefs.__order 拖拽顺序 + Base 置顶（五处渲染顺序一致）
    var saved = state.prefs.__order || [];
    var all = data.conditions.slice();
    all.sort(function (a, b) {
      var ia = saved.indexOf(a.name.toLowerCase());
      var ib = saved.indexOf(b.name.toLowerCase());
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });
    var first = [], rest = [];
    all.forEach(function (c) {
      if (getPref(c).first) first.push(c);
      else rest.push(c);
    });
    return first.concat(rest);
  }

  function checkedConditions(data) {
    return orderedConditions(data).filter(function (c) { return getPref(c).checked; });
  }

  function currentData() {
    var f = state.files[state.currentIndex];
    return f ? f.data : null;
  }

  /* ================================================================
   * 初始化与事件绑定
   * ================================================================ */
  function init() {
    // 第二十八批：自包含 HTML 打开时直接恢复状态（跳过导入引导）
    if (window.__SAVED__ && window.__SAVED__.files && window.__SAVED__.files.length) {
      try {
        state.files = window.__SAVED__.files;
        state.currentIndex = 0;
        state.prefs = window.__SAVED__.prefs || {};
        if (window.__SAVED__.chartStyle) C.applyChartStyle(window.__SAVED__.chartStyle);
        if (window.__SAVED__.options) state.options = window.__SAVED__.options;
        if (window.__SAVED__.axisTitlePos) state.axisTitlePos = window.__SAVED__.axisTitlePos;
        if (window.__SAVED__.view) state.view = window.__SAVED__.view;
        if (window.__SAVED__.jvOverlay) state.jvOverlay = window.__SAVED__.jvOverlay; // P5
        if (window.__SAVED__.detailSel) state.detailSel = window.__SAVED__.detailSel; // P5
        renderAll();
      } catch (e) {
        console.error('LOAD_SAVED_ERR:', e && e.stack ? e.stack : e);
      }
    }
    // 空状态初始：导航占位（第三批）
    UI.renderPageNav(null, { colorOf: chartColor });
    // v1.1-I2：恢复名称规则（localStorage jv_name_rules，优先于自动推断）
    if (P && P.loadNameRulesFromStorage) P.loadNameRulesFromStorage();
    // v1.1-I3：恢复预览「应用并记住」映射（jv_name_rule_manual，最高优先）
    if (P && P.loadNameManualMapFromStorage) P.loadNameManualMapFromStorage();
    // v1.2-I2：恢复 guided 块规则（jv_name_rule_guided）
    if (P && P.loadGuidedRuleFromStorage) P.loadGuidedRuleFromStorage();

    var btnOpen = $('btn-open');
    var fileInput = $('file-input');
    if (btnOpen) btnOpen.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleFiles(e.target.files);
      fileInput.value = '';
    });

    // i18n：语言切换器（分段 中/EN，点选即切；激活态由 syncLangSwitch 保持）
    function syncLangSwitch() {
      var cur = (typeof I18N !== 'undefined') ? I18N.getLang() : 'zh';
      var z = $('btn-lang-zh'), e = $('btn-lang-en');
      if (z) z.classList.toggle('active', cur === 'zh');
      if (e) e.classList.toggle('active', cur === 'en');
    }
    var btnLangZh = $('btn-lang-zh'), btnLangEn = $('btn-lang-en');
    if (btnLangZh) btnLangZh.addEventListener('click', function () {
      if (typeof I18N !== 'undefined') I18N.setLang('zh'); // N4：i18n:changed 监听器统一 renderAll+refreshMergeBtn+syncLangSwitch（单入口防双重渲染）
    });
    if (btnLangEn) btnLangEn.addEventListener('click', function () {
      if (typeof I18N !== 'undefined') I18N.setLang('en'); // N4：同上
    });
    syncLangSwitch();
    // i18n:changed 广播（脚本触发 setLang 时也重绘动态区 + 同步分段激活）
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n:changed', function () { renderAll(); refreshMergeBtn(); syncLangSwitch(); var mm = $('merge-modal'); if (mm && !mm.hidden) paintMergeMsg(); var gm = $('group-modal'); if (gm && !gm.hidden && pendingGroupData) showGroupModal(pendingGroupData, pendingGroupCands); var gm2 = $('name-guide-modal'); if (gm2 && !gm2.hidden && guideData && typeof renderGuide === 'function') renderGuide(); var pe = $('name-preview-modal'); if (pe && !pe.hidden && previewData && typeof renderBlockEditor === 'function') renderBlockEditor(); }); // N3：切语言后整理模式按钮计数归零——补刷新合并按钮；i18n: 导入弹窗正文随语言重绘；i-7：group 弹窗行内按钮随语言重绘；v1.2-I3：name-guide 向导随语言重绘；t32：块编辑器随语言重绘（消除英文态中文残留）
    }

    // 整页拖放（7.1：dragover/drop + 全页遮罩）
    // 第十九批：仅文件拖放（types 含 'Files'）触发遮罩——条件把手内部拖拽不显示「松开以载入文件」、
    // 不劫持 drop（此前遮罩盖住条件列表导致把手拖拽放下无反应）
    function isFileDrag(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      return Array.prototype.indexOf.call(t, 'Files') >= 0;
    }
    var mask = $('drop-mask');
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); dragDepth++; mask.hidden = false;
    });
    document.addEventListener('dragover', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    });
    document.addEventListener('dragleave', function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; mask.hidden = true; }
    });
    document.addEventListener('drop', function (e) {
      if (!isFileDrag(e)) return; // 内部拖拽的 drop 交给条件 row 处理
      e.preventDefault();
      dragDepth = 0;
      mask.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    // 警告条关闭
    var warnClose = $('warn-close');
    if (warnClose) warnClose.addEventListener('click', function () { UI.hideWarnBar(); });

    // 导入方式弹窗按钮（第二个文件起）
    var btnSplit = $('merge-btn-split');
    var btnCombine = $('merge-btn-combine');
    var btnCancel = $('merge-btn-cancel');
    if (btnSplit) btnSplit.addEventListener('click', function () {
      hideMergeModal();
      if (pendingFile) { addFile(pendingFile.name, pendingFile.data); pendingFile = null; }
      processQueue();
    });

    var helpNG = $('help-namegroups');
    if (helpNG && global.JVEquiv && global.JVEquiv.openHelp) helpNG.addEventListener('click', function () { global.JVEquiv.openHelp('namegroups'); });
    if (btnCombine) btnCombine.addEventListener('click', function () {
      hideMergeModal();
      if (pendingFile) { mergeWithCurrent(pendingFile); pendingFile = null; }
      processQueue();
    });
    if (btnCancel) btnCancel.addEventListener('click', function () {
      hideMergeModal();
      pendingFile = null;
      processQueue();
    });

    /* ---------- 第十三批：导出 PDF（window.print 方案） ---------- */
    var btnPdf = $('btn-export-pdf');
    var pdfModal = $('pdf-modal');
    if (btnPdf) btnPdf.addEventListener('click', function () {
      if (!currentData() || !checkedConditions(currentData()).length) {
        T.showToast('请先加载数据并勾选条件');
        return;
      }
      $('pdf-title').value = '';
      $('pdf-note').value = '';
      if (pdfModal) pdfModal.hidden = false;
    });
    /* ---------- 第二十八批：导出 HTML（自包含单文件，双击即看） ---------- */
    var btnHtml = $('btn-export-html');
    if (btnHtml) btnHtml.addEventListener('click', function () {
      if (!currentData() || !checkedConditions(currentData()).length) {
        T.showToast('请先加载数据并勾选条件');
        return;
      }
      exportHtml();
    });
    var pdfOk = $('pdf-btn-ok');
    var pdfCancel = $('pdf-btn-cancel');
    if (pdfOk) pdfOk.addEventListener('click', function () {
      var title = $('pdf-title').value.trim();
      if (!title) { T.showToast('请填写标题'); return; }
      var note = $('pdf-note').value;
      if (pdfModal) pdfModal.hidden = true;
      exportPdf(title, note);
    });
    if (pdfCancel) pdfCancel.addEventListener('click', function () { if (pdfModal) pdfModal.hidden = true; });

    /* ---------- 第三十七批：条件系列合并建议弹窗 ---------- */
    var grpCancel = $('group-btn-cancel');
    var grpSplitAll = $('group-btn-split-all');
    var grpMergeAll = $('group-btn-merge-all');
    var grpApply = $('group-btn-apply');
    var grpModal = $('group-modal');
    if (grpCancel) grpCancel.addEventListener('click', cancelGrouping);
    if (grpSplitAll) grpSplitAll.addEventListener('click', function () { setAllGroupRows(false); });
    if (grpMergeAll) grpMergeAll.addEventListener('click', function () { setAllGroupRows(true); });
    if (grpApply) grpApply.addEventListener('click', confirmGrouping);
    if (grpModal) grpModal.addEventListener('click', function (e) { if (e.target === grpModal) cancelGrouping(); });

    /* ---------- v1.2-I2：名字分组·块编辑器（升级名称解析预览面板，spec 5.3/6） ---------- */
    var previewData = null; // { rows:[{name, blocks, roles, tplId}], mix:{state,ids} }——roles=块索引→角色
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      });
    }
    /** 初始角色分配：块引擎推荐（cond/channel/seq/direction/ignored；sep 无角色） */
    function initBlockRoles(name) {
      var cands = P.nameBlockRoles(name);
      var roles = [];
      cands.forEach(function (r) {
        if (r.kind === 'sep') roles[r.blockIndex] = 'sep';
        else roles[r.blockIndex] = r.recommended || 'ignored';
      });
      return roles;
    }
    /** 模板级候选 parts（首行角色分配——与应用落盘 guided 规则同一来源） */
    function candidatePartsFromRow(row) {
      var parts = [];
      for (var i = 0; i < row.blocks.length; i++) {
        var role = row.roles[i];
        if (role === 'cond' || role === 'channel' || role === 'direction') {
          parts.push({ role: role, blockIndex: i, pattern: row.blocks[i].text });
        }
      }
      return parts;
    }
    /** 键语义 = guidedKey（越界/缺失整名回退原名）——预览与应用后完全一致（t34 ISSUE-1）
     *  t65：语义名不取纯数字键——cond 键为「纯数字」且名字不含模板结构（CH_Ref/Device——未命中任何模板的语义命名，
     *  如 '0.5 Mod'/'0.1 Mod'/'1.0 Mod'）→ 键改用完整语义名（原文原样——与解析器条件一致化，260814 型 8 卡=8 条件）。
     *  模板命中型（'25.CH_Ref(1)' 键 '25'）与系统名容器语义（isUnnamedSystemName 行不建组）不受影响。 */
    function guideCondKeyFor(name, parts) {
      if (!parts || !parts.length) return name;
      // R1：预览候选键 = 落地 guided 键同一实现（resolveConditionKey 的 guided 分支——ctx 以候选 parts 构造 guidedRule；
      // 与 guidedKey 同判据（t77：名无模板结构→整名）——预览/落地同源）
      var rk = P.resolveConditionKey(name, { mode: 'guided', guidedRule: { mode: 'guided', parts: parts }, nameManualMap: null });
      if (rk.key === null) return name; // 越界/键空 → 整名回退（预览语义，与原实现一致）
      return rk.key;
    }
    /** t37：稳定哈希（组键→0..11，同组同色） */
    function stableHash(s) {
      var str = String(s);
      var h = 5381;
      for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
      return h % 12;
    }
    function groupColor(gid) { return 'bgc-' + stableHash(gid); }
    /** t37：行级自定义？roles ≠ 初始推荐 */
    function refreshRowCustom(row) {
      if (!row || !row.baseRoles) return;
      row.custom = false;
      for (var i = 0; i < row.baseRoles.length; i++) {
        if (row.roles[i] !== row.baseRoles[i]) { row.custom = true; break; }
      }
    }
    /** t37：行条件键——行级自定义 → 行 parts 键；组操作 → 操作键；组内唯一名=1 → 该名（恒等，解析侧回退容器基线）；
     *  否则组键（=模板级键）。预览与落地 manual map 使用同一键函数（t34 教训：一致必须同源）。 */
    function rowKeyOf(ri, group) {
      var row = previewData.rows[ri];
      if (row && row.custom) return guideCondKeyFor(row.name, candidatePartsFromRow(row));
      var op = previewData.groupOps[group.key];
      if (op) {
        if (op.op === 'exclude' || op.op === 'split') return row.name; // 每名一条件（同名多条=同一条件）
        if (op.op === 'mergeAsCond') return op.newName || group.repName;
        if (op.op === 'rename') return op.newName || group.key;
      }
      if (group.uniqName) return group.uniqName; // t45：恒等（名→名）——解析器回退容器（防 '1 3.*' 类记录名拆成独立条件）
      if (group.dirGroup) return row.name; // t45：方向记录组（名全含 Reverse/Forward）→ 每名恒等 → 解析回退容器（并入容器条件）
      return group.key;
    }
    /** t37：组操作下该组的条件贡献数（split/exclude=组内唯一名数；mergeAsCond/rename=1；merge/默认=成员行键 distinct） */
    function groupCondCount(g) {
      if (!g.members.length) return 0;
      var op = previewData.groupOps[g.key];
      if (op && (op.op === 'exclude' || op.op === 'split')) {
        var names = {}, n0 = 0;
        g.members.forEach(function (ri) {
          var nm = previewData.rows[ri].name;
          if (!names[nm]) { names[nm] = true; n0++; }
        });
        return n0;
      }
      if (op && (op.op === 'mergeAsCond' || op.op === 'rename')) return 1;
      var seen = {}, n = 0;
      g.members.forEach(function (ri) {
        var k = rowKeyOf(ri, g);
        // t45：键=行名且行名含方向词（Reverse/Forward→方向记录）→ 解析侧回退容器并入（不独立成条件）→ 预览同步不计
        if (k === previewData.rows[ri].name && /\b(Reverse|Forward)\b/i.test(k)) return;
        if (!seen[k]) { seen[k] = true; n++; }
      });
      return n;
    }
    function groupsViewCount() {
      var n = 0;
      (previewData.groups || []).forEach(function (g) { n += groupCondCount(g); });
      return n;
    }
    /** 即时分组预览（模板级候选 parts）→ 组数组 [{key,count,members,repName,color,singleTpl}] */
    function computeGroups() {
      var parts = candidatePartsFromRow(previewData.rows[0]);
      var groups = {};
      var order = [];
      previewData.rows.forEach(function (row, ri) {
        // t105：系列成员行（memberOf——拆分数据源）不单独建组
        if (row.memberOf) return;
        // t55：仪器系统名（未命名记录，与解析器容器语义一致）→ 归属最近命名组（前置无命名组则跳过不建组）
        if (P.isUnnamedSystemName && P.isUnnamedSystemName(row.name)) {
          if (order.length) {
            var lastK = order[order.length - 1];
            groups[lastK].count++;
            groups[lastK].devCount += row.devN; // t87：跟随器计入总器件（行 devN——普通行=1）
            groups[lastK].members.push(ri);
          }
          return;
        }
        var k = guideCondKeyFor(row.name, parts);
        if (!groups[k]) {
          groups[k] = { key: k, count: 0, devCount: 0, members: [], repName: row.name, color: groupColor(k), singleTpl: true, srcNames: row.srcNames || null, memRowIdxs: (row.memRowIdxs || []).slice() }; // t105：系列成员快照透传（拆分源）
          order.push(k);
        }
        groups[k].count++;
        groups[k].devCount += row.devN; // t87：命名行计入条件器件数（应用态行=完整条件器件数；普通行=1）
        groups[k].members.push(ri);
      });
      var out = order.map(function (k) { return groups[k]; });
      // t49：显式按组内首个记录出现序号排序（文件/测试顺序——防组哈希/键序错乱）
      out.sort(function (a, b) { return a.members[0] - b.members[0]; });
      // t37：组内模板状态（single → 「套用当前模板」；mix/none → 「逐条」）
      out.forEach(function (g) {
        var un = {}, cnt = 0, name0 = null, allDir = true; // t45：唯一名=1 → uniqName；全方向名 → dirGroup
        g.members.forEach(function (ri) {
          var nm = previewData.rows[ri].name;
          if (!un[nm]) { un[nm] = true; cnt++; name0 = nm; }
          if (!/\b(Reverse|Forward)\b/i.test(nm)) allDir = false;
        });
        g.uniqName = (cnt === 1) ? name0 : null;
        g.dirGroup = allDir && cnt >= 2; // 方向记录组（Reverse/Forward 两名字同模板键）——行级恒等（防拆独立条件）
        if (g.count < 2) return;
        g.singleTpl = P.detectNameTemplateMix(g.members.map(function (ri) { return previewData.rows[ri].name; })).state === 'single';
      });
      previewData.groups = out;
      previewData.rowGroup = [];
      out.forEach(function (g) {
        g.members.forEach(function (ri) { previewData.rowGroup[ri] = g; });
      });
      return out;
    }
    var ROLE_LABEL = { cond: 'nameBlocks.cond', channel: 'nameBlocks.channel', seq: 'nameBlocks.seq', direction: 'nameBlocks.direction', ignored: 'nameBlocks.ignored', auto: 'nameBlocks.auto' };
    /** t93：系列归并——同主体系列组卡合并（26-1/2/3/4→组名 26；主体≥2 组才触发——单组/异主体不误并）
     *  t95：主体组（自身 core=null 如 '32'）纳入成员集——32+32-2（单子成员）时也触发（否则 32-2 残留独立）
     *  t99：主体判定=共享 P.seriesTailCore（候选弹窗/系列归并/落地统一判据） */
    function seriesMerge() {
      var groups = computeGroups();
      var byCore = {}, order = [];
      groups.forEach(function (g) {
        var core = P.seriesTailCore(g.key);
        if (!core) return;
        if (!byCore[core]) { byCore[core] = []; order.push(core); }
        if (byCore[core].indexOf(g.key) < 0) byCore[core].push(g.key);
      });
      // 主体组加入（keys 中存在主体——32 组被 32-2 剥离指向）
      groups.forEach(function (g) {
        var base = String(g.key).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim();
        if (byCore[base] && byCore[base].indexOf(g.key) < 0) byCore[base].push(g.key);
      });
      var hit = 0;
      order.forEach(function (core) {
        var keys = byCore[core];
        if (keys.length < 2) return; // 单组不动（不误并）
        keys.forEach(function (k) {
          if (previewData.groupOps[k]) return; // 已有操作保留（不覆盖）
          previewData.groupOps[k] = { op: 'mergeAsCond', newName: core };
        });
        hit++;
      });
      if (hit) renderBlockEditor();
      return hit;
    }
    function roleLabel(r) {
      var key = ROLE_LABEL[r] || (r === 'sep' ? '' : r);
      if (!key) return '';
      return (typeof I18N !== 'undefined') ? I18N.t(key) : key;
    }
    function showNamePreview(data) {
      var m = $('name-preview-modal');
      var body = $('name-preview-body');
      if (!m || !body) return;
      if (!m.hidden) return; // ISSUE-1（t22）：弹窗已开则不重建——保留用户未提交编辑
      var pv = data && data.namePreview;
      // t95：无 namePreview 但 conditions 为事实源（导入合并绘制数据等）→ 也打开（下方 fallback 重建）；两源皆空才返回
      if ((!pv || !pv.length) && (!data.conditions || !data.conditions.length)) return;
      // t85：应用后（合并态）重开画板——基于当前 data.conditions 重建预览行（组卡=应用后分组，不再显示合并前原始分类）；
      // 恢复原始分组后（state.groupApplied=false）回到原始 namePreview
      if (state.groupSeriesSnap && data.conditions && data.conditions.length) {
        // t105/t107：series 态重建优先（t85 的 manual 反查是记录名级——不适用于系列合并；成员行/memRowIdxs 缺失则拆分失效）
        var snapS = state.groupSeriesSnap;
        pv = [];
        data.conditions.forEach(function (c) {
          var mems = snapS[c.name] || null;
          var row = { name: c.name, tplId: null, key: c.name, ch: '', dir: '', devN: c.devices.length, srcNames: null, memRowIdxs: [] };
          pv.push(row);
          if (mems && mems.length) {
            row.srcNames = mems.map(function (m) { return m.name; });
            mems.forEach(function (m) {
              row.memRowIdxs.push(pv.length);
              pv.push({ name: m.name, tplId: null, key: m.name, ch: '', dir: '', devN: m.devN, srcNames: null, memberOf: c.name });
            });
          }
        });
      } else if (state.groupApplied && data.conditions && data.conditions.length) {
        // t87：重建行附带 devN（条件器件数——卡 ×N 显示成员+跟随器总器件）与 srcNames（来源成员名——合并明细展开）
        var snap = state.groupRulesSnapshot && state.groupRulesSnapshot.manual;
        pv = data.conditions.map(function (c) {
          var src = null;
          if (snap) {
            var keys = Object.keys(snap).filter(function (k) { return snap[k] === c.name; });
            if (keys.length) src = keys;
          }
          return { name: c.name, tplId: null, key: c.name, ch: '', dir: '', devN: c.devices.length, srcNames: src };
        });
      } else if ((!pv || !pv.length) && data.conditions && data.conditions.length) {
        // t95：无 namePreview 的事实源（导入合并绘制数据 mergeData 产物等）→ 依当前条件重建（分组面板=合并后条件集，非原始全部）
        // t105：系列合并快照——主体行带 srcNames/memRowIdxs（成员条件行——拆分数据源）；成员行带 memberOf（不单独建组）
        var snapS = state.groupSeriesSnap || null;
        pv = [];
        data.conditions.forEach(function (c) {
          var mems = (snapS && snapS[c.name]) ? snapS[c.name] : null;
          var row = { name: c.name, tplId: null, key: c.name, ch: '', dir: '', devN: c.devices.length, srcNames: null, memRowIdxs: [] };
          pv.push(row);
          if (mems && mems.length) {
            row.srcNames = mems.map(function (m) { return m.name; });
            mems.forEach(function (m) {
              row.memRowIdxs.push(pv.length);
              pv.push({ name: m.name, tplId: null, key: m.name, ch: '', dir: '', devN: m.devN, srcNames: null, memberOf: c.name });
            });
          }
        });
      }
      var mix = P.detectNameTemplateMix(pv.map(function (p) { return p.name; }));
      previewData = { rows: pv.slice(), mix: mix, srcData: data }; // t61④：源数据引用（应用后立即重算）
      previewData.rows.forEach(function (row) {
        row.blocks = P.splitNameBlocks(row.name);
        row.roles = initBlockRoles(row.name);
        row.baseRoles = row.roles.slice(); // t37：行级自定义检测基线（初始推荐）
        row.custom = false;
        // t87：行器件数（应用态重建行带条件器件数——卡 ×N 显示成员+跟随器总器件；普通行=1 行语义）；srcNames 保留（来源明细）
        if (row.devN === undefined) row.devN = 1;
      });
      previewData.groups = [];        // t37：组卡数组（computeGroups 填充）
      previewData.rowGroup = [];      // t37：行 → 基础组
      previewData.groupOps = {};      // t37：组操作 {组键: {op,newName?}}（组级确认）
      previewData.selGid = null;      // t37：点选组（成员高亮/展开）
      previewData.menuGid = null;     // t37：更多菜单展开的组
      previewData.renameGid = null;   // t37：重命名输入展开的组
      previewData.boardView = 'manual'; // t39：视图（手动分组画板=默认（用户 9.5 反馈），自动分组可切换）
      previewData.board = null;       // t39：手动画板状态（首次切换手动视图时初始化）
      renderBlockEditor();
      m.hidden = false;
    }
    function shorten(s, n) {
      var str = String(s);
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    }
    /** t37：组卡内更多菜单（合并为条件/保持分开/重命名组/应用规则到全部） */
    function bgMenuHtml(g) {
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; };
      return '<span class="bg-menu">' +
        '<button type="button" class="bg-cbtn" data-op="mergeAsCond" data-gid="' + esc(g.key) + '">' + esc(t('bg.mergeAsCond')) + '</button>' +
        '<button type="button" class="bg-cbtn" data-op="split" data-gid="' + esc(g.key) + '">' + esc(t('bg.keepSplit')) + '</button>' +
        '<button type="button" class="bg-cbtn" data-op="rename" data-gid="' + esc(g.key) + '">' + esc(t('bg.rename')) + '</button>' +
        '<button type="button" class="bg-cbtn" data-op="applyAll" data-gid="' + esc(g.key) + '">' + esc(t('bg.applyAll')) + '</button>' +
        (previewData.groupOps[g.key]
          ? '<button type="button" class="bg-cbtn" data-op="restoreGroup" data-gid="' + esc(g.key) + '">' + esc(t('bg.restoreGroup')) + '</button>' // t95：单组复原（取消该组操作——还原为原成员组）
          : '') + '</span>';
    }
    function bgRenameHtml(g, op) {
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; };
      return '<span class="bg-renamerow"><input type="text" class="bg-renamein" data-gid="' + esc(g.key) + '" placeholder="' + esc(t('bg.newName')) + '" value="' + esc((op && op.newName) || g.repName) + '">' +
        '<button type="button" class="bg-cbtn" data-op="renameOk" data-gid="' + esc(g.key) + '">' + esc(t('bg.confirm')) + '</button></span>';
    }
    function bgMembersHtml(g) {
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; };
      var html = '<span class="bg-members"><b>' + esc(shorten(g.key, 40)) + '</b> · ' + esc(t('bg.members')) + ' (' + g.count + '): ';
      var shown = false;
      g.members.forEach(function (ri, i) {
        var row = previewData.rows[ri];
        // t87：合并态重开（应用后）——来源成员名（srcNames）展开显示（合并明细不丢失）
        var names = (row && row.srcNames && row.srcNames.length) ? row.srcNames : [row ? row.name : ''];
        names.forEach(function (nm) {
          if (shown) html += ' · ';
          html += esc(nm);
          shown = true;
        });
      });
      if (!shown) html += esc(g.repName || '');
      return html + '</span>';
    }
    /* ---------- t39：手动分组画板（spec 13 追加：第二视图，兜底用） ---------- */
    function nbT(k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; }
    function nbBaseCards() {
      return computeGroups().map(function (g) {
        return { key: g.key, repName: g.repName, color: g.color, ri: g.members.slice(), grouped: true, sel: false, uniqName: g.uniqName, dirGroup: g.dirGroup, devCount: g.devCount, srcNames: g.srcNames, memRowIdxs: g.memRowIdxs }; // t45：带 uniqName/dirGroup（恒等键回退容器）；t87：devCount（成员+跟随器总器件）；t105：srcNames/memRowIdxs（系列成员拆分源）
      });
    }
    function nbInitBoard() {
      var cards = nbBaseCards();
      previewData.board = { cards: cards, undo: [], history: [], search: '', onlyUn: false, groupName: '', persist: false, initSig: JSON.stringify(cards) }; // t69：密度切换已删（仅常规 155px 单档）；t115：history=条目化操作日志（审计）
    }
    function nbDirty() { return previewData.board && JSON.stringify(previewData.board.cards) !== previewData.board.initSig; }
    /** t115：条目化撤销栈——每操作一条 {type,target,members,expect}（审计）+ 快照（逆操作回放）
     *  type: 'group'(合并) | 'split'(拆分) | 'remove'(移出)；撤销=栈内快照回退 + history.pop（仅撤销，无重做） */
    function nbPushUndo(type, meta) {
      if (!previewData.board) return;
      previewData.board.undo.push(JSON.stringify(previewData.board.cards));
      var h = meta || {};
      previewData.board.history.push({ type: type || 'op', target: h.target || '', members: (h.members || []).slice(0, 8), expect: h.expect || '', at: Date.now() });
      if (previewData.board.undo.length > 20) { previewData.board.undo.shift(); previewData.board.history.shift(); }
    }
    function nbVisible(card) {
      var b = previewData.board;
      if (b.search && card.repName.toLowerCase().indexOf(b.search.toLowerCase()) < 0) return false;
      if (b.onlyUn && card.grouped) return false;
      return true;
    }
    /** t103：拆分合并卡——组卡 → 成员唯一名卡（单项还原——即时预览；与 t95「还原此组」同语义但卡片直显）
     *  t105：系列合并卡（srcNames/memRowIdxs——快照成员）→ 拆成成员条件卡（devN 来自快照） */
    function nbSplitCard(ci) {
      var b = previewData.board;
      if (!b) return;
      var card = b.cards[ci];
      if (!card || !card.grouped) return;
      if (card.srcNames && card.srcNames.length && card.memRowIdxs && card.memRowIdxs.length) {
        nbPushUndo('split', { target: card.repName, members: card.srcNames, expect: 'series-split' }); // t115：条目化（type/target/members/expect）
        var newCards = [];
        // 主体行保留（恒等卡——bm 全命中不退化；与成员卡并列为独立条件）
        if (card.ri && card.ri.length) {
          newCards.push({ key: card.key, repName: card.repName, color: card.color, ri: card.ri.slice(), grouped: false, sel: false, devCount: card.devCount });
        }
        card.memRowIdxs.forEach(function (mi) {
          var mrow = previewData.rows[mi];
          newCards.push({ key: mrow.name, repName: mrow.name, color: groupColor(mrow.name), ri: [mi], grouped: false, sel: false, devCount: (mrow.devN !== undefined ? mrow.devN : 1) });
        });
        var arr = b.cards.slice();
        Array.prototype.splice.apply(arr, [ci, 1].concat(newCards));
        b.cards = arr;
        b.groupName = '';
        nbRerenderGrid();
        return;
      }
      if (card.ri.length <= 1) return;
      var byName = {}, order = [];
      card.ri.forEach(function (ri) {
        var nm = previewData.rows[ri].name;
        if (!byName[nm]) { byName[nm] = []; order.push(nm); }
        byName[nm].push(ri);
      });
      nbPushUndo('split', { target: card.repName, members: order, expect: 'split' }); // t115：条目化（type/target/members/expect——order 已构建）
      var newCards = order.map(function (nm) {
        return { key: nm, repName: nm, color: groupColor(nm), ri: byName[nm].slice(), grouped: false, sel: false, devCount: byName[nm].length };
      });
      var arr = b.cards.slice();
      Array.prototype.splice.apply(arr, [ci, 1].concat(newCards));
      b.cards = arr;
      b.groupName = '';
      nbRerenderGrid();
    }
    /** t113：移出单个成员（与 ⛓ 拆分同构——从合并态还原单个成员；组卡 ×N-1 + 独立卡；可撤销）
     *  series 卡按 srcNames 快照成员；ri 卡按成员名（同名多行整组移出）；空/单成员组拒绝（返回 false） */
    function nbRemoveMember(ci, name) {
      var b = previewData.board;
      if (!b) return false;
      var card = b.cards[ci];
      if (!card || !card.grouped) return false;
      var ml = nbMemberListOf(card);
      if (ml.members.length <= 1) return false; // 空/单成员组不可移出
      nbPushUndo('remove', { target: card.repName, members: [name], expect: 'remove1' }); // t115：条目化（移出=一条）
      if (ml.kind === 'series') {
        var idx = -1;
        card.srcNames.forEach(function (n, i) { if (idx < 0 && n === name) idx = i; });
        if (idx < 0) return false;
        var mi = (card.memRowIdxs && card.memRowIdxs[idx] !== undefined) ? card.memRowIdxs[idx] : null;
        var mrow = (mi !== null && previewData.rows[mi]) ? previewData.rows[mi] : null;
        var devN = (mrow && mrow.devN !== undefined) ? mrow.devN : 1;
        var movedName = card.srcNames[idx];
        var sN = card.srcNames.slice(); sN.splice(idx, 1);
        var mN = (card.memRowIdxs || []).slice(); if (idx < mN.length) mN.splice(idx, 1);
        var nc = { key: card.key, repName: card.repName, color: card.color, ri: card.ri.slice(), grouped: true, sel: false, uniqName: card.uniqName, dirGroup: card.dirGroup, devCount: (card.devCount !== undefined ? card.devCount : card.ri.length) - devN, srcNames: sN, memRowIdxs: mN };
        var newCards = [{ key: movedName, repName: movedName, color: groupColor(movedName), ri: (mi !== null ? [mi] : []), grouped: false, sel: false, devCount: devN }];
        var arr = b.cards.slice();
        Array.prototype.splice.apply(arr, [ci, 1].concat([nc].concat(newCards)));
        b.cards = arr;
        b.groupName = '';
        nbRerenderGrid();
        return true;
      }
      // ri 卡：按成员名移出（该名全部行）
      var riMoved = [];
      card.ri.forEach(function (ri) {
        var nm = previewData.rows[ri] ? previewData.rows[ri].name : '';
        if (nm === name) riMoved.push(ri);
      });
      if (!riMoved.length) return false;
      var newCards2 = [{ key: name, repName: name, color: groupColor(name), ri: riMoved.slice(), grouped: false, sel: false, devCount: riMoved.length }];
      var riRest = card.ri.filter(function (ri) { return riMoved.indexOf(ri) < 0; });
      var nc2 = { key: card.key, repName: card.repName, color: card.color, ri: riRest, grouped: true, sel: false, uniqName: card.uniqName, dirGroup: card.dirGroup, devCount: (card.devCount !== undefined ? card.devCount : card.ri.length) - riMoved.length, srcNames: card.srcNames, memRowIdxs: card.memRowIdxs };
      var arr2 = b.cards.slice();
      Array.prototype.splice.apply(arr2, [ci, 1].concat([nc2].concat(newCards2)));
      b.cards = arr2;
      b.groupName = '';
      nbRerenderGrid();
      return true;
    }
    /** t113：成员清单面板（body 层浮动）——点合并卡成员预览打开；每成员「移出」；空/单成员组禁用；点击外部关闭 */
    function nbOpenMemberList(ci, anchorEl) {
      var b = previewData.board;
      if (!b) return;
      var card = b.cards[ci];
      if (!card || !card.grouped) return;
      var ml = nbMemberListOf(card);
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; };
      var cnt = (card.devCount !== undefined ? card.devCount : card.ri.length);
      var disAll = ml.members.length <= 1;
      var html = '<div class="nb-ml-head">' + esc(card.repName) + ' · ×' + cnt + ' <span class="nb-ml-headcnt">' + esc(isEn ? '(' + ml.members.length + ' members)' : '（' + ml.members.length + ' 成员）') + '</span>' +
        '<button type="button" class="nb-ml-close" title="' + esc(isEn ? 'Close' : '关闭') + '">✕</button></div>';
      html += '<div class="nb-ml-items">';
      if (ml.members.length === 0) {
        html += '<div class="nb-ml-empty">' + esc(isEn ? 'No removable members' : '无成员可移出') + '</div>';
      }
      ml.members.forEach(function (m) {
        html += '<div class="nb-ml-item"><i class="nb-srcdot bgc-' + stableHash(m.name) + '"></i><span class="nb-ml-name" title="' + esc(m.name) + '">' + esc(m.name) + '</span>' +
          '<button type="button" class="nb-ml-rm" data-name="' + esc(m.name) + '"' + (disAll ? ' disabled' : '') + ' title="' + esc(isEn ? 'Restore this member as its own card (single removal)' : '将成员还原为独立卡（单项移出）') + '">' + esc(t('nameBoard.removeMember')) + '</button></div>';
      });
      if (disAll && ml.members.length === 1) {
        html += '<div class="nb-ml-hint">' + esc(isEn ? 'A group needs at least 2 members to remove one.' : '组内至少 2 名成员才可移出。') + '</div>';
      }
      html += '</div>';
      html += '<div class="nb-ml-foot">' + esc(isEn ? 'Remove = restore as its own card (undoable via Undo)' : '移出 = 还原为独立卡（可用「撤销」恢复）') + '</div>';
      var old = $('nb-memlist');
      if (!old) {
        var div = document.createElement('div');
        div.id = 'nb-memlist';
        div.className = 'nb-memlist';
        document.body.appendChild(div);
      }
      var el = $('nb-memlist');
      el.innerHTML = html;
      el.classList.remove('nb-ml-hidden');
      el.setAttribute('data-ci', String(ci));
      if (anchorEl && anchorEl.getBoundingClientRect) {
        var r = anchorEl.getBoundingClientRect();
        var w = el.offsetWidth || 240;
        var h = el.offsetHeight || 220;
        var left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8));
        var top = r.bottom + 4;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
      }
    }
    function nbCloseMemberList() {
      var el = $('nb-memlist');
      if (el) el.classList.add('nb-ml-hidden');
    }
    function nbSelCards() {
      return previewData.board.cards.filter(function (c) { return c.sel; });
    }
    function nbCommitGroup() { // 归为一组：选中卡 → 一张组卡（组名=输入框/第一张选中卡名）
      var b = previewData.board;
      if (!b) return;
      var sels = nbSelCards();
      if (!sels.length) return;
      var name = (b.groupName && b.groupName.trim()) ? b.groupName.trim() : nbDefaultName(sels[0]);
      nbPushUndo('group', { target: name, members: sels.map(function (c) { return c.repName; }), expect: 'merge' }); // t115：条目化（合并=一条）
      var riAll = [];
      // t87：归并卡继承 devCount（成员+跟随器总器件——×N 显示不因归并丢失）
      var devAll = 0;
      sels.forEach(function (c) {
        c.sel = false;
        riAll = riAll.concat(c.ri);
        devAll += (c.devCount !== undefined ? c.devCount : c.ri.length);
      });
      var firstIdx = b.cards.indexOf(sels[0]);
      var excluded = sels.slice();
      var rest = b.cards.filter(function (c) { return excluded.indexOf(c) < 0; });
      var exist = null;
      rest.forEach(function (c) { if (c.key === name) exist = c; });
      if (exist) {
        exist.ri = exist.ri.concat(riAll);
        exist.devCount = (exist.devCount !== undefined ? exist.devCount : exist.ri.length) + devAll;
        exist.grouped = true;
        exist.dirty = true; // t45：被归并卡 = 用户操作卡（应用写组名键）
        b.cards = rest;
      } else {
        var arr = rest.slice();
        arr.splice(firstIdx, 0, { key: name, repName: name, color: groupColor(name), ri: riAll, grouped: true, sel: false, dirty: true, devCount: devAll }); // t45：归组卡 dirty；t87：devCount
        b.cards = arr;
      }
      b.groupName = '';
      nbRerenderGrid();
    }
    /** t45：board 卡的应用键（预览/落地同源）——dirty 卡=组名（用户操作）；名卡=卡名（恒等）；
     *  未操作组卡按初始组语义（方向恒等/唯一名恒等/模板键） */
    function boardKeyFor(card, ri) {
      if (card.dirty) return card.key;
      if (!card.grouped) return card.key; // 名卡（含拆分态）= 恒等（名→名）
      var g = previewData.rowGroup[ri];
      if (!g) return card.key;
      if (g.dirGroup) return previewData.rows[ri].name; // 方向记录组 → 行名恒等（解析回退容器）
      if (g.uniqName) return g.uniqName;
      return g.key;
    }
    function boardCountView() {
      var keys = {}, n = 0;
      previewData.board.cards.forEach(function (card) {
        card.ri.forEach(function (ri) {
          var row = previewData.rows[ri];
          var k = boardKeyFor(card, ri);
          if (k === row.name && /\b(Reverse|Forward)\b/i.test(k)) return; // 方向恒等 → 回退容器并入（预览同步不计）
          if (!keys[k]) { keys[k] = true; n++; }
        });
      });
      return n;
    }
    /** t113：来源条件名列表（来源色块数据源）——合并卡=成员来源条件名（srcNames/去重成员名）；普通卡=自身条件名
     *  注：来源色=groupColor(src)（12 色稳定系，与卡背景色同语义「同条件同色」）；多文件文件色待行带 file 索引后接入（paletteColor(fileIdx)） */
    function nbSrcList(card) {
      if (card.grouped && card.srcNames && card.srcNames.length) return card.srcNames.slice();
      if (card.grouped) {
        var out = [], seen = {};
        card.ri.forEach(function (ri) {
          var nm = previewData.rows[ri] ? previewData.rows[ri].name : '';
          if (!nm || (P.isUnnamedSystemName && P.isUnnamedSystemName(nm))) return;
          if (seen[nm]) return;
          seen[nm] = true; out.push(nm);
        });
        return out;
      }
      return [card.repName];
    }
    /** t113：系列主体徽标文本——有尾号→主体名（23-2→23）；自身被其他卡指为系列主体→自身（23）；否则 null（不显示徽章）
     *  （与 detectGroupCandidates/seriesMerge 的 P.seriesTailCore 统一判据一致） */
    function nbFamilyCoreOf(name) {
      var core = P.seriesTailCore(name);
      if (core) return core;
      var cards = previewData.board.cards;
      for (var i = 0; i < cards.length; i++) {
        if (P.seriesTailCore(cards[i].repName) === name) return name;
      }
      return null;
    }
    /** t113：成员清单数据——{ kind:'series'|'ri'|'none', members:[{name,mi}] }（mi=系列快照行索引；ri 卡为 null） */
    function nbMemberListOf(card) {
      if (card.grouped && card.srcNames && card.srcNames.length) {
        var ms = [];
        card.srcNames.forEach(function (n, i) {
          var mi = (card.memRowIdxs && card.memRowIdxs[i] !== undefined) ? card.memRowIdxs[i] : null;
          ms.push({ name: n, mi: mi });
        });
        return { kind: 'series', members: ms };
      }
      if (card.grouped) {
        var out = [], seen = {};
        card.ri.forEach(function (ri) {
          var nm = previewData.rows[ri] ? previewData.rows[ri].name : '';
          if (!nm || (P.isUnnamedSystemName && P.isUnnamedSystemName(nm))) return;
          if (seen[nm]) return;
          seen[nm] = true; out.push({ name: nm, mi: null });
        });
        return { kind: 'ri', members: out };
      }
      return { kind: 'none', members: [] };
    }
    function nbGridHtml() {
      var cards = previewData.board.cards;
      var html = '';
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      cards.forEach(function (card, ci) {
        if (!nbVisible(card)) return;
        var condName = nbDefaultName(card); // t43：主文本=条件名（主键短名；未命中模板→原名兜底）
        var cnt = (card.devCount !== undefined ? card.devCount : card.ri.length); // t87：×N=成员+跟随器总器件（devCount；旧卡兼容 ri.length）
        // t103：合并卡成员真实名预览（前 3 + N 更多——去重+排除系统名）；title 全名列表；「⛓ 拆分」按钮（单项还原）
        var memPrev = '', titleTxt = card.repName;
        if (card.grouped && card.srcNames && card.srcNames.length) {
          // t105：系列合并卡（srcNames 快照）——成员条件名预览（前 3 + N 更多）
          memPrev = card.srcNames.slice(0, 3).join(' · ') + (card.srcNames.length > 3 ? ' +' + (card.srcNames.length - 3) + (isEn ? ' more' : ' 更多') : '');
          titleTxt = card.repName + (isEn ? '\nMembers: ' : '\n成员: ') + card.srcNames.join(', ');
        } else if (card.grouped && card.ri.length > 1) {
          var seen = {}, mns = [], total = 0;
          card.ri.forEach(function (ri, rii) {
            var nm = previewData.rows[ri] ? previewData.rows[ri].name : '';
            if (!nm || (P.isUnnamedSystemName && P.isUnnamedSystemName(nm))) return; // 系统名（跟随器）不预览
            if (seen[nm]) return;
            seen[nm] = true; total++;
            if (mns.length < 3) mns.push(nm);
            titleTxt += (total === 1 ? (isEn ? '\nMembers: ' : '\n成员: ') : ', ') + nm;
          });
          if (total > 0) memPrev = mns.join(' · ') + (total > 3 ? ' +' + (total - 3) + (isEn ? ' more' : ' 更多') : '');
          else memPrev = '';
        }
        // t113：右上角角标——来源色块（来源条件色点：普通卡=自身 1 点；合并卡=成员来源条件色点组；最大 4 点 +N）+ 系列主体徽标（家族主体名）
        var badges = '';
        var srcs = nbSrcList(card);
        var srcDots = '';
        srcs.slice(0, 4).forEach(function (s) {
          srcDots += '<i class="nb-srcdot bgc-' + stableHash(s) + '" title="' + esc(s) + '"></i>';
        });
        if (srcs.length > 4) srcDots += '<i class="nb-srcmore" title="' + esc(srcs.slice(4).join(', ')) + '">+' + (srcs.length - 4) + '</i>';
        badges += '<span class="nb-srcbadge" title="' + esc((isEn ? 'Source: ' : '来源: ') + srcs.join(', ')) + '">' + srcDots + '</span>';
        var fam = nbFamilyCoreOf(card.repName);
        if (fam) badges += '<span class="nb-fambadge" title="' + esc((isEn ? 'Series family: ' : '系列主体: ') + fam) + '">' + esc(fam) + '</span>';
        html += '<div class="nb-card ' + card.color + (card.sel ? ' sel' : '') + '" data-ci="' + ci + '" title="' + esc(titleTxt) + '">' +
          (badges ? '<span class="nb-badges">' + badges + '</span>' : '') +
          '<span class="nb-cname">' + esc(condName) + '</span>' +
          '<span class="nb-cname2" title="' + esc(card.repName) + '">' + esc(card.repName) + '</span>' +
          (memPrev ? '<span class="nb-cmem" data-ci="' + ci + '" title="' + esc(isEn ? 'Member list — click to open' : '成员清单 — 点击打开') + '">' + esc(memPrev) + '</span>' : '') +
          '<span class="nb-ccount">' + (card.grouped ? '🗂 ' : '') + '×' + cnt + (card.grouped && (card.ri.length > 1 || (card.srcNames && card.srcNames.length))
            ? '<button type="button" class="nb-split" data-ci="' + ci + '" title="' + esc(isEn ? 'Split this group back to member cards' : '拆分此组为成员卡（单项还原）') + '">' + (isEn ? '⛓ Split' : '⛓ 拆分') + '</button>' : '') + '</span></div>';
      });
      return html;
    }
    function nbSelInfo() {
      var b = previewData.board;
      if (!b) return '';
      var n = nbSelCards().length;
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      return (isEn ? 'Selected ' : '已选 ') + n + (isEn ? ' card(s)' : ' 张卡');
    }
    function nbRerenderGrid() {
      var g = $('nb-grid');
      if (g) g.innerHTML = nbGridHtml();
      var si = $('nb-selinfo');
      if (si) si.textContent = nbSelInfo();
      var ub = document.querySelector('.nb-toolbar [data-nbop="undo"]'); // t115：撤销栈计数恒同步（操作后局部刷新）
      if (ub && previewData.board) {
        var n = previewData.board.undo.length;
        var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
        ub.textContent = isEn ? '↺ Undo (' + n + ')' : '↺ 撤销（' + n + '）';
      }
    }
    function nbToolbarHtml() {
      var b = previewData.board;
      // t101：取消合并（toggleMerge）已移除——语义冗余（显示展开破坏 dirty 组决策；恢复合并与「还原此组/恢复原始分组」重复）——
      // 由视图切换（viewseg）+ 组操作（还原此组 t95）+ 全盘恢复（t75）承担
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      var html = '<div class="nb-toolbar">' +
        '<input type="text" class="nb-search" placeholder="' + esc(nbT('nameBoard.search')) + '" value="' + esc(b.search) + '">' +
        '<label><input type="checkbox" class="nb-chk-un"' + (b.onlyUn ? ' checked' : '') + '> ' + esc(nbT('nameBoard.onlyUn')) + '</label>' +
        '<button type="button" class="nb-btn" data-nbop="selAll">' + esc(nbT('nameBoard.selAll')) + '</button>' +
        '<button type="button" class="nb-btn" data-nbop="clearSel">' + esc(nbT('nameBoard.clear')) + '</button>' +
        '<button type="button" class="nb-btn" data-nbop="undo">' + esc(isEn ? '↺ Undo (' + b.undo.length + ')' : '↺ 撤销（' + b.undo.length + '）') + '</button>' +
        '<label><input type="checkbox" class="nb-chk-save"' + (b.persist ? ' checked' : '') + '> ' + esc(nbT('nameBoard.persist')) + '</label></div>'; // t115：撤销栈计数（可回退 N 步）
      html += '<div class="nb-hint">' + esc(isEn ? 'Drag a rectangle to select; Ctrl+click for multi-select.' : '拖拽矩形框选；Ctrl+点击多选。') + '</div>';
      return html;
    }
    function nbActionsHtml() {
      var b = previewData.board;
      var sels = nbSelCards();
      return '<div class="nb-actions">' +
        '<button type="button" class="nb-btn" data-nbop="group">' + esc(nbT('nameBoard.group')) + '</button>' +
        '<input type="text" class="nb-gname" placeholder="' + esc(nbT('nameBoard.groupName')) + '" value="' + esc(b.groupName || (sels.length ? nbDefaultName(sels[0]) : '')) + '">' +
        '<button type="button" class="nb-btn" data-nbop="groupOk">' + esc(nbT('bg.confirm')) + '</button>' +
        '<span class="nb-selinfo" id="nb-selinfo">' + esc(nbSelInfo()) + '</span></div>';
    }
    function nbViewsegHtml() {
      var v = previewData.boardView;
      return '<div class="nb-viewseg">' +
        '<button type="button" class="nb-seg' + (v === 'auto' ? ' on' : '') + '" data-nbview="auto">' + esc(nbT('nameBoard.viewAuto')) + '</button>' +
        '<button type="button" class="nb-seg' + (v === 'manual' ? ' on' : '') + '" data-nbview="manual">' + esc(nbT('nameBoard.viewManual')) + '</button></div>';
    }
    function nbDefaultName(card) {
      var k = (typeof P !== 'undefined' && P.nameClusterKey) ? P.nameClusterKey(card.repName || '') : null;
      return k || (card.repName || '');
    }
    function renderBlockEditor() {
      var body = $('name-preview-body');
      if (!body || !previewData) return;
      nbCloseMemberList(); // t113：画板重渲染（切视图/应用/撤销）时成员清单面板关闭（data-ci 已失效）
      body.classList.toggle('nb-bodyManual', previewData.boardView === 'manual');
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; };
      var groups = computeGroups();
      var html = nbViewsegHtml(); // t39：视图切换（自动分组=默认 / 手动分组画板）
      // t103：系列归并/合并建议入口两视图共有且醒目（viewseg 下公共行——manual 同位置）
      html += '<div class="nb-toolbar"><button type="button" class="nb-btn" data-nbop="seriesMerge" title="' + esc(isEn ? 'Merge series groups (e.g. 26-1/2/3/4 -> 26) — based on the same root series' : '按同主体系列归并（如 26-1/2/3/4 → 26）——仅当同主体多于一组') + '">' + esc(isEn ? '⧉ Merge series' : '⧉ 系列归并') + '</button>' +
        '<button type="button" class="nb-btn" data-nbop="suggestMerge" title="' + esc(isEn ? 'Re-open condition-series merge suggestions for the current conditions' : '重新检测条件合并建议（当前条件集）——与导入时同款候选窗') + '">' + esc(isEn ? '↺ Merge suggestions' : '↺ 合并建议') + '</button></div>';
      html += '<div class="nb-scrollbody">'; // t71：滚动区（操作条/摘要固定在外，内容区独立滚动）
      // N-r6-3：纯系统名文件空屏引导（两视图通用——默认手动视图 0 卡也提示）
      var isEmptySystem = previewData.rows.length > 0 && previewData.rows.every(function (r) { return P.isUnnamedSystemName(r.name); });
      if (isEmptySystem) {
        html += '<div class="bg-card bg-empty-system">' + esc(t('bg.emptySystem').replace('N', String(previewData.rows.length))) + '</div>';
      }
      var n;
      if (previewData.boardView === 'manual') {
        // t39：手动画板（分组规则面板第二视图，兜底）
        if (!previewData.board) nbInitBoard();
        html += nbToolbarHtml() + '<div class="nb-grid" id="nb-grid">' + nbGridHtml() + '</div>'; // t69：单档 155px 网格（密度切换已删）；t71：操作条移到滚动区外（固定可见）
        n = boardCountView(); // t45：应用语义条件数（方向恒等回退容器不计）
      } else {
        // t37：组卡区（分组候选：组名=代表名 + 条数 + [归并][排除][详情][套用|逐条][▾]）
        // 系列归并/合并建议入口已上移公共行（t103——两视图同位置）
        html += '<div class="bg-cards">';
        groups.slice(0, 200).forEach(function (g) {
          var op = previewData.groupOps[g.key];
          var flag = '';
          if (op) {
            if (op.op === 'merge') flag = '<span class="bg-flag">✓ ' + esc(t('bg.applied')) + '</span>';
            else if (op.op === 'exclude') flag = '<span class="bg-flag">✗ ' + esc(t('bg.exclude')) + '</span>';
            else if (op.op === 'split') flag = '<span class="bg-flag">⧉ ' + esc(t('bg.keepSplit')) + '</span>';
            else if (op.op === 'mergeAsCond') flag = '<span class="bg-flag">➕ ' + esc(t('bg.mergeAsCond')) + '</span>';
            else if (op.op === 'rename') flag = '<span class="bg-flag">✎ ' + esc(t('bg.rename')) + '</span>';
          }
          var selCls = previewData.selGid === g.key ? ' sel' : '';
          var gid = esc(g.key);
          html += '<div class="bg-card ' + g.color + selCls + '" data-gid="' + gid + '" title="' + esc(g.repName) + '"><span class="bg-name" data-gid="' + gid + '">' +
            esc(shorten(g.repName, 26)) + '</span><span class="bg-count">×' + (g.devCount !== undefined ? g.devCount : g.count) + '</span>' + flag +
            '<span class="bg-btns">' +
            '<button type="button" class="bg-cbtn" data-op="merge" data-gid="' + gid + '">' + esc(t('bg.merge')) + '</button>' +
            '<button type="button" class="bg-cbtn" data-op="exclude" data-gid="' + gid + '">' + esc(t('bg.exclude')) + '</button>' +
            '<button type="button" class="bg-cbtn" data-op="detail" data-gid="' + gid + '">' + esc(t('bg.detail')) + '</button>' +
            '<button type="button" class="bg-cbtn" data-op="apply" data-gid="' + gid + '">' + esc(g.singleTpl ? t('bg.applyTemplate') : t('bg.oneByOne')) + '</button>' +
            '<button type="button" class="bg-cbtn" data-op="menu" data-gid="' + gid + '">▾</button></span>' +
            (previewData.menuGid === g.key ? bgMenuHtml(g) : '') +
            (previewData.renameGid === g.key ? bgRenameHtml(g, op) : '') +
            (previewData.selGid === g.key ? bgMembersHtml(g) : '') +
            '</div>';
        });
        html += (groups.length > 200 ? '<div class="bg-card">… ' + (isEn ? 'showing first 200 groups' : '已截断显示前 200 组') + '</div>' : '') + '</div>';
        // 积木列表（每名字一行；块可点击弹菜单分配角色；行/块=组色）
        html += '<div class="np-scroll">';
        previewData.rows.forEach(function (row, ri) {
          var g = previewData.rowGroup[ri];
          var gcls = g ? ' ' + g.color : '';
          var selm = (g && previewData.selGid === g.key) ? ' selm' : '';
          html += '<div class="np-row' + gcls + selm + '" data-i="' + ri + '"><span class="np-name">' + esc(row.name) + '</span><span class="np-blocks">';
          for (var bi = 0; bi < row.blocks.length; bi++) {
            var blk = row.blocks[bi];
            var role = row.roles[bi];
            var rcls = role && role !== 'sep' && role !== 'ignored' ? ('rb-' + role) : '';
            html += '<span class="np-block ' + rcls + (g ? ' bgcb-' + g.color.slice(4) : '') + '" data-i="' + ri + '" data-bi="' + bi + '" role="' + esc(role || '') + '">' +
              esc(blk.text) + (role && role !== 'sep' ? ' <b>' + esc(roleLabel(role)) + '</b>' : '') + '</span>'; // roleLabel 内含 typeof I18N 守卫（t34 观察③）
          }
          html += '</span></div>';
        });
        html += '</div>';
        n = groupsViewCount();
      }
      // t71：组列表（自动视图）移入滚动区尾（避免撐高固定区）
      if (previewData.boardView !== 'manual') {
        html += '<div class="np-groups">';
        groups.slice(0, 200).forEach(function (g) {
          html += '<div class="np-group">' + esc(g.key) + ' · ' + g.count + (isEn ? ' meas' : ' 测量') + ' · ' + esc(g.repName) + '</div>';
        });
        html += (groups.length > 200 ? '<div class="np-group">… ' + (isEn ? 'showing first 200 groups' : '已截断显示前 200 组') + '</div>' : '') + '</div>';
      }
      html += '</div>'; // t71：滚动区结束
      // t71：操作条固定（手动视图——始终可见，不随内容滚动）
      if (previewData.boardView === 'manual') html += nbActionsHtml();
      // 即时预览（当前视图方案条件数）+ 汇总句（固定尾）
      html += '<div class="np-summary-pane"><div class="np-summary">' + previewData.rows.length + ' ' +
        (isEn ? 'names grouped into' : '个名字归为') + ' <b>' + n + '</b> ' +
        (isEn ? 'conditions' : '个条件') + '</div></div>';
      html += '<div class="np-skipfooter"><button type="button" class="btn btn-sm" id="guide-skip-reset">' + esc(t('nameGuide.skipReset')) + '</button></div>'; // v1.2-I3 追加：重置「不再提示」（t31 观察-1）
      body.innerHTML = html;
      var sr = $('guide-skip-reset');
      if (sr) sr.addEventListener('click', function () {
        saveGuideSkip(false);
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'The guide will ask again on the next import.' : '向导将在下次导入时再次提示。');
      });
      if (typeof I18N !== 'undefined' && I18N.applyTo) { try { I18N.applyTo(body); } catch (e) {} } // ISSUE-4（t22）：裸 typeof I18N
    }
    /** 块点击弹菜单（角色选项） */
    function openBlockMenu(blockEl) {
      closeBlockMenu();
      var menu = document.createElement('div');
      menu.className = 'np-menu';
      var items = [
        { r: 'cond', k: 'nameBlocks.thisCond' },
        { r: 'channel', k: 'nameBlocks.thisChannel' },
        { r: 'direction', k: 'nameBlocks.thisDir' },
        { r: 'ignored', k: 'nameBlocks.ignore' }
      ];
      if (blockEl.getAttribute('role') !== 'ignored') items.push({ r: 'auto', k: 'nameBlocks.autoBack' });
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'np-menu-item';
        b.textContent = I18N.t(it.k);
        b.addEventListener('click', function () {
          var ri = parseInt(blockEl.getAttribute('data-i'), 10);
          var bi = parseInt(blockEl.getAttribute('data-bi'), 10);
          var row = previewData && previewData.rows[ri];
          if (row) {
            row.roles[bi] = (it.r === 'auto') ? (P.nameBlockRoles(row.name)[bi] && P.nameBlockRoles(row.name)[bi].recommended || 'ignored') : it.r;
            refreshRowCustom(row); // t37：行级标注（自定义=true → 行键进 manual map）
          }
          closeBlockMenu();
          renderBlockEditor(); // 即时预览
        });
        menu.appendChild(b);
      });
      document.body.appendChild(menu);
      var r = blockEl.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
      menu.style.top = (r.bottom + 4) + 'px';
    }
    function closeBlockMenu() {
      var m = document.querySelector('.np-menu');
      if (m) m.parentNode.removeChild(m);
    }
    document.addEventListener('click', function (e) {
      var blk = e.target && e.target.closest ? e.target.closest('.np-block') : null;
      if (blk) { openBlockMenu(blk); return; }
      if (e.target && !(e.target && e.target.classList && e.target.classList.contains('np-menu'))) closeBlockMenu();
    }, true);
    /** t37/t39：块编辑器事件委托（body 常驻一次性；视图切换/组卡/画板均从此处理） */
    var nbBlockClick = false; // t41：框选拖拽后抑制点选（须显式声明——严格模式下未声明赋值=ReferenceError）
    var pvBody = $('name-preview-body');
    if (pvBody) pvBody.addEventListener('click', function (e) {
      if (!previewData) return;
      if (nbBlockClick) {
        nbBlockClick = false;
        return; // t73：阈值 8px 后微动不再进框选分支（点选走 click toggle）；>8px 框选均视为明确拖动——click 统一抑制（防 Ctrl 框选后 click toggle 抵消框选结果）；t61② 的「ctrl 放行」场景（微动框选）已由阈值修复从根上消灭
      }
      var tgt = e.target;
      // t39：视图切换（自动分组 / 手动分组画板——segmented 两视图共用）
      var seg = tgt && tgt.closest ? tgt.closest('.nb-seg') : null;
      if (seg) {
        var nv = seg.getAttribute('data-nbview');
        if (nv !== previewData.boardView) { previewData.boardView = nv; renderBlockEditor(); }
        return;
      }
      // t93：系列归并按钮（组卡区工具条）
      if (tgt && tgt.closest && tgt.closest('[data-nbop="seriesMerge"]')) {
        seriesMerge();
        return;
      }
      // t101：「↺ 合并建议」——重新检测当前条件集（候选窗与导入时机同——确认后走 t97/t99 崩溃路径：namePreview=null → 事实源重建）
      if (tgt && tgt.closest && tgt.closest('[data-nbop="suggestMerge"]')) {
        var cdata = currentData();
        if (cdata) {
          var cands = P.detectGroupCandidates(cdata.conditions);
          if (cands.length) showGroupModal(cdata, cands);
          else T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'No merge candidates found.' : '未发现可合并的系列候选。');
        }
        return;
      }
      // t39：手动画板交互（画板按钮/卡片点选=ctrl 多选）
      if (previewData.boardView === 'manual' && previewData.board) {
        var nbBtn = tgt && tgt.closest ? tgt.closest('.nb-btn') : null;
        if (nbBtn) {
          var op = nbBtn.getAttribute('data-nbop');
          if (op === 'selAll') {
            previewData.board.cards.forEach(function (c) { if (nbVisible(c)) c.sel = true; });
            nbRerenderGrid();
          } else if (op === 'clearSel') {
            previewData.board.cards.forEach(function (c) { c.sel = false; });
            nbRerenderGrid();
          } else if (op === 'undo') {
            if (previewData.board.undo.length) {
              previewData.board.cards = JSON.parse(previewData.board.undo.pop()); // t113：撤销含移出——面板同步关闭（ci 已失效）
              if (previewData.board.history && previewData.board.history.length) previewData.board.history.pop(); // t115：条目日志同步消费（仅撤销无重做）
              nbCloseMemberList();
              previewData.board.groupName = '';
              renderBlockEditor();
            }
          } else if (op === 'group') {
            var sels0 = nbSelCards();
            if (!sels0.length) {
              T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Select at least one card first.' : '请先选中至少一张卡。');
              return;
            }
            previewData.board.groupName = nbDefaultName(sels0[0]); // 默认=第一张选中卡的主键短名（观察①）
            renderBlockEditor();
          } else if (op === 'groupOk') {
            nbCommitGroup();
            renderBlockEditor();
          }
          return;
        }
        var nbCard = tgt && tgt.closest ? tgt.closest('.nb-card') : null;
        // t103：拆分按钮（卡内）——优先于卡片点选（单项还原）
        var nbSplit = tgt && tgt.closest ? tgt.closest('.nb-split') : null;
        if (nbSplit) {
          var sci = parseInt(nbSplit.getAttribute('data-ci'), 10);
          nbSplitCard(sci);
          return;
        }
        // t113：成员预览 → 成员清单面板（点开/再点关闭）
        var nbCmem = tgt && tgt.closest ? tgt.closest('.nb-cmem') : null;
        if (nbCmem) {
          var mci = parseInt(nbCmem.getAttribute('data-ci'), 10);
          var mlEl = $('nb-memlist');
          if (mlEl && !mlEl.classList.contains('nb-ml-hidden') && mlEl.getAttribute('data-ci') === String(mci)) nbCloseMemberList();
          else nbOpenMemberList(mci, nbCmem);
          return;
        }
        if (nbCard) {
          var ci = parseInt(nbCard.getAttribute('data-ci'), 10);
          var nbC = previewData.board.cards[ci];
          if (nbC) {
            if (e.ctrlKey) {
              nbC.sel = !nbC.sel;
              nbCard.classList.toggle('sel', nbC.sel); // 不重建 DOM：连续多选期间引用稳定
            } else {
              previewData.board.cards.forEach(function (c) { c.sel = false; });
              Array.prototype.forEach.call(document.querySelectorAll('.nb-card.sel'), function (el) { el.classList.remove('sel'); });
              nbC.sel = true;
              nbCard.classList.add('sel');
            }
            var si = $('nb-selinfo');
            if (si) si.textContent = nbSelInfo();
          }
          return;
        }
        return;
      }
      // t37：自动视图组卡事件
      if (!previewData.groups) return;
      var card = tgt && tgt.closest ? tgt.closest('.bg-card') : null;
      if (!card) return;
      var gidRaw = card.getAttribute('data-gid');
      var g = null;
      for (var i = 0; i < previewData.groups.length; i++) {
        if (previewData.groups[i].key === gidRaw) { g = previewData.groups[i]; break; }
      }
      if (!g) return;
      var btn = tgt && tgt.closest ? tgt.closest('.bg-cbtn') : null;
      if (btn) {
        var op = btn.getAttribute('data-op');
        var gid = g.key;
        if (op === 'merge') { previewData.groupOps[gid] = { op: 'merge' }; previewData.menuGid = null; }
        else if (op === 'exclude') { previewData.groupOps[gid] = { op: 'exclude' }; previewData.menuGid = null; }
        else if (op === 'split') { previewData.groupOps[gid] = { op: 'split' }; previewData.menuGid = null; }
        else if (op === 'mergeAsCond') { previewData.groupOps[gid] = { op: 'mergeAsCond', newName: g.repName }; previewData.menuGid = null; }
        else if (op === 'apply') {
          if (!g.singleTpl) {
            // t57（恢复）：auto 视图无积木列表，「逐条」（混合组）→ 跳切手动分组画板（行级/逐条操作入口）
            previewData.boardView = 'manual';
            renderBlockEditor();
            return;
          }
          previewData.groupOps[gid] = { op: 'merge' };
          previewData.renameGid = null;
        }
        else if (op === 'menu') { previewData.menuGid = (previewData.menuGid === gid) ? null : gid; previewData.renameGid = null; }
        else if (op === 'rename') { previewData.menuGid = null; previewData.renameGid = gid; }
        else if (op === 'renameOk') {
          var inp = card.querySelector('.bg-renamein');
          var v = (inp && inp.value && inp.value.trim()) ? inp.value.trim() : g.repName;
          previewData.groupOps[gid] = { op: 'rename', newName: v };
          previewData.menuGid = null; previewData.renameGid = null;
        }
        else if (op === 'restoreGroup') { delete previewData.groupOps[gid]; previewData.menuGid = null; } // t95：单组复原（取消该组操作）
        else if (op === 'applyAll') { previewData.groupOps = {}; previewData.menuGid = null; previewData.renameGid = null; }
        else if (op === 'detail') { previewData.selGid = (previewData.selGid === gid) ? null : gid; }
        renderBlockEditor();
        return;
      }
      // 卡片空白处：选中/展开成员
      previewData.selGid = (previewData.selGid === g.key) ? null : g.key;
      renderBlockEditor();
    });
    /** t113：成员清单面板——body 层浮动；移出/关闭按钮 + 点击面板外关闭（捕获阶段：先于 pvBody 冒泡处理） */
    document.addEventListener('click', function (e) {
      var ml = $('nb-memlist');
      if (!ml || ml.classList.contains('nb-ml-hidden')) return;
      var inside = e.target && e.target.closest ? e.target.closest('#nb-memlist') : null;
      if (!inside) { nbCloseMemberList(); return; }
      var rm = e.target && e.target.closest ? e.target.closest('.nb-ml-rm') : null;
      if (rm) {
        var ci = parseInt(ml.getAttribute('data-ci'), 10);
        var nm = rm.getAttribute('data-name');
        if (nbRemoveMember(ci, nm)) nbCloseMemberList();
        return;
      }
      var cls = e.target && e.target.closest ? e.target.closest('.nb-ml-close') : null;
      if (cls) nbCloseMemberList();
    }, true);
    /** t39：画板输入/勾选/框选事件（搜索、仅显示未分组、保存开关、拖拽矩形框选） */
    var nbSelRect = null; // 框选状态 {x1,y1,grid,rectEl}
    if (pvBody) pvBody.addEventListener('input', function (e) {
      if (!previewData || !previewData.board || previewData.boardView !== 'manual') return;
      var tg = e.target;
      if (tg.classList && tg.classList.contains('nb-search')) {
        previewData.board.search = tg.value;
        nbRerenderGrid();
      } else if (tg.classList && tg.classList.contains('nb-gname')) {
        previewData.board.groupName = tg.value;
      }
    });
    if (pvBody) pvBody.addEventListener('change', function (e) {
      if (!previewData || !previewData.board || previewData.boardView !== 'manual') return;
      var tg = e.target;
      if (tg.classList && tg.classList.contains('nb-chk-un')) {
        previewData.board.onlyUn = tg.checked;
        nbRerenderGrid();
      } else if (tg.classList && tg.classList.contains('nb-chk-save')) {
        previewData.board.persist = tg.checked;
      }
    });
    if (pvBody) pvBody.addEventListener('mousedown', function (e) {
      if (!previewData || !previewData.board || previewData.boardView !== 'manual') return;
      var grid = e.target && e.target.closest ? e.target.closest('#nb-grid') : null;
      if (!grid) return;
      nbSelRect = { x1: e.clientX, y1: e.clientY, grid: grid, rectEl: null, moved: false };
      e.preventDefault(); // 开始记录——移动超过阈值即框选（卡片上按住拖也能框选，点击仍走 click 点选）
    });
    document.addEventListener('mousemove', function (e) {
      if (!nbSelRect) return;
      // t73：点选阈值 4px→8px（业界常用拖拽阈值；触控板/鼠标微动 5-7px 容差——微动视为点击，click handler 走点选 toggle）
      if (!nbSelRect.moved && Math.abs(e.clientX - nbSelRect.x1) < 8 && Math.abs(e.clientY - nbSelRect.y1) < 8) return;
      if (!nbSelRect.rectEl) {
        nbSelRect.moved = true;
        var r0 = document.createElement('div');
        r0.className = 'nb-selrect';
        var g0 = nbSelRect.grid.getBoundingClientRect();
        r0.style.left = (nbSelRect.x1 - g0.left) + 'px';
        r0.style.top = (nbSelRect.y1 - g0.top) + 'px';
        r0.style.width = '0'; r0.style.height = '0';
        nbSelRect.grid.appendChild(r0);
        nbSelRect.rectEl = r0;
      }
      var gr = nbSelRect.grid.getBoundingClientRect();
      var L = Math.min(nbSelRect.x1, e.clientX) - gr.left;
      var T = Math.min(nbSelRect.y1, e.clientY) - gr.top;
      nbSelRect.rectEl.style.left = L + 'px';
      nbSelRect.rectEl.style.top = T + 'px';
      nbSelRect.rectEl.style.width = Math.abs(e.clientX - nbSelRect.x1) + 'px';
      nbSelRect.rectEl.style.height = Math.abs(e.clientY - nbSelRect.y1) + 'px';
    });
    document.addEventListener('mouseup', function (e) {
      if (!nbSelRect) return;
      var grid = nbSelRect.grid, rectEl = nbSelRect.rectEl, moved = nbSelRect.moved;
      var isCard = e.target && e.target.closest ? !!e.target.closest('.nb-card') : false;
      var needRerender = false;
      if (moved) {
        var L = Math.min(nbSelRect.x1, e.clientX), T = Math.min(nbSelRect.y1, e.clientY);
        var R = Math.max(nbSelRect.x1, e.clientX), B = Math.max(nbSelRect.y1, e.clientY);
        var hit = [];
        Array.prototype.forEach.call(grid.querySelectorAll('.nb-card'), function (el) {
          var r = el.getBoundingClientRect();
          if (L < r.right && R > r.left && T < r.bottom && B > r.top) hit.push(el);
        });
        if (!e.ctrlKey) previewData.board.cards.forEach(function (c) { c.sel = false; });
        hit.forEach(function (el) {
          var ci = parseInt(el.getAttribute('data-ci'), 10);
          if (previewData.board.cards[ci]) previewData.board.cards[ci].sel = true;
        });
        nbBlockClick = true; // 拖选后抑制随后的 click（防误点选）
        needRerender = true;
      } else {
        if (!e.ctrlKey && !isCard) {
          previewData.board.cards.forEach(function (c) { c.sel = false; }); // 空白处点击=清选区
          needRerender = true;
        }
        // t73：卡上微动（moved=false & isCard）→ 不重建 grid：点选 toggle 由后续浏览器 click 完成（classList 直改）；
        // 此处若无条件 nbRerenderGrid()，grid 重建会分离旧卡节点——click 派发在已分离节点上冒泡失效，点选丢失（用户实测「点选不切换」根因之一）
      }
      if (rectEl && rectEl.parentNode) rectEl.parentNode.removeChild(rectEl);
      nbSelRect = null;
      if (needRerender) nbRerenderGrid();
      if (nbBlockClick) {
        // t73：nbBlockClick 只为「紧随框选同元素的 click」服务（浏览器 mouseup→click 同步序列）；
        // 若框选收在不同元素（click 不触发），定时清除——残留 true 会误吞用户下一次点击（框选后首次点击丢失）
        setTimeout(function () { nbBlockClick = false; }, 0);
      }
    });
    var pvKeep = $('name-preview-keep');
    if (pvKeep) pvKeep.addEventListener('click', function () {
      var m = $('name-preview-modal');
      if (m) m.hidden = true;
      previewData = null;
    });
    /** t61④：应用=立即在当前数据重算生效（parseFile(rawText)→替换当前 data + renderAll；无 rawText 兜底提示重载） */
    function applyRebuildCurrent() {
      var src = previewData && previewData.srcData;
      if (!src || !src.rawText) {
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Applied — re-load the file to see the result.' : '已应用——重新加载文件后生效。');
        return;
      }
      try {
        // R1：应用重算切换分组模型管线（buildGroupModel→groupsToConditions——行为等价，模型层承载归属视图）
        var nd = P.buildGroupModel(src.rawText, src.fileName || '');
        if (nd) nd = P.groupsToConditions(nd);
        if (!nd) throw new Error('reparse null');
        // t75：空壳清理——应用合并/组操作后 0 器件条件自动移除（不留全 — 空行；防 processed 列空块或被归并后的残留条件）
        nd.conditions = nd.conditions.filter(function (c) { return c.devices.length > 0; });
        nd.stats.conditionCount = nd.conditions.length;
        // t89：合并来源标注——名称分组应用后器件显示来源（条件名≠器件记录名时 → srcCond=记录名）；
        // 系统名记录（跟随器）不作为独立来源标注（噪音——其归属即所属条件）；与左栏整理（mergeConditions 打标）同一显示路径
        if (nd.namePreview) {
          nd.conditions.forEach(function (c) {
            c.devices.forEach(function (d) {
              if (d.srcCond) return; // 旧整理路径已标注
              var srcIdx = d.fwdPos >= 0 ? d.fwdPos : d.revPos;
              if (srcIdx >= 0 && nd.namePreview[srcIdx]) {
                var nm = nd.namePreview[srcIdx].name;
                if (nm !== c.name && !(P.isUnnamedSystemName && P.isUnnamedSystemName(nm))) d.srcCond = nm;
              }
            });
          });
        }
        nd.rawText = src.rawText; // t75：恢复可逆——重算产物保留原文（后续「恢复原始分组」仍可还原）
        // R3：可逆状态机——应用完成 = 规则快照 + GROUP_APPLIED 状态位（恢复=快照清零+规则清除+模型重算——与 t75 恢复语义统一）
        state.groupApplied = true;
        state.groupRulesSnapshot = {
          guided: (P.getGuidedRule ? P.getGuidedRule() : null),
          manual: (P.getNameManualMap ? P.getNameManualMap() : null)
        };
        var f = state.files[state.currentIndex];
        if (f) f.data = nd;
        renderAll();
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Applied — the current data has been recalculated.' : '已应用——当前数据已立即重算生效。');
      } catch (e) {
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Applied — re-load the file to see the result.' : '已应用——重新加载文件后生效。');
      }
    }
    /** 应用：t39 手动画板 / t37 组级确认——存在方案改动 → manual map 全覆盖（清 guided 防优先级覆盖）；
     *  否则按首行角色分配生成 guided 规则（cond 必选；无 cond → 提示）。
     *  t39 保存开关：persist ON=持久化（下次导入自动应用）；OFF=仅本次会话生效（清持久残留）。 */
    function applyPreview() {
      if (!previewData || !previewData.rows.length) return;
      computeGroups(); // 保 rowGroup 就绪
      // t107：series 态无操作确认（合并建议后未做任何改动点「应用」）——直接关闭面板（不保存 guided——数据保持合并集）
      if (state.groupSeriesSnap && previewData.boardView === 'manual' && previewData.board && !nbDirty() &&
          Object.keys(previewData.groupOps).length === 0 && !previewData.rows.some(function (r) { return r.custom; })) {
        var mm0 = $('name-preview-modal');
        if (mm0) mm0.hidden = true;
        previewData = null;
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Confirmed — current grouping kept.' : '已确认——当前分组保持。');
        return;
      }
      // t39：手动分组画板方案（视图=manual 且方案相对初始有改动）
      if (previewData.boardView === 'manual' && previewData.board && nbDirty()) {
        var bm = {};
        previewData.board.cards.forEach(function (card) {
          card.ri.forEach(function (ri) {
            var row = previewData.rows[ri];
            if (!row) return;
            // t75：系统名行写恒等映射——同名（Reverse/Forward）跨数据段：恒等值无覆盖问题（bm 键唯一但值恒等）；
            // 并保证 mapHit 全命中激活 manual；解析器对「恒等+方向记录」走容器语义段归属（与初始解析同源——归组/恢复往返一致）
            if (P.isUnnamedSystemName && P.isUnnamedSystemName(row.name)) {
              bm[row.name] = row.name;
              return;
            }
            bm[row.name] = boardKeyFor(card, ri); // t45：board 键（dirty 组名/恒等/方向回退）——条件名=用户数据不翻译
          });
        });
        // t91：连续应用规则链式累计——应用态下再次分组：本轮 bm 键=上一轮映射值（条件名）→ 合成后
        // （记录名→上一轮条件名→本轮组名）再以 rawText 重算——叠加合并语义（23→20→18；不丢第一轮）
        // t107：series 态链式——board 出现成员卡（bm 键=记录名 strip 后条件名）时成员优先（拆分态拆回）
        var prev = (state.groupApplied && state.groupRulesSnapshot && state.groupRulesSnapshot.manual) ? state.groupRulesSnapshot.manual : null;
        if (prev) {
          var chained = {};
          Object.keys(prev).forEach(function (k) {
            var mid = prev[k];
            var b0 = String(k).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim(); // 记录名→条件名/成员名
            chained[k] = (bm[b0] !== undefined) ? bm[b0] : ((bm[mid] !== undefined) ? bm[mid] : mid); // 拆分态成员优先；否则链式
          });
          bm = chained;
        }
        P.saveGuidedRuleToStorage(null); // manual 必须生效（防旧 guided 覆盖）
        if (previewData.board.persist) {
          P.saveNameManualMapToStorage(bm); // 保存规则勾选：持久化（下次导入自动应用）
        } else {
          P.setNameManualMap(bm);           // t61④：应用=立即生效（仅内存，不动 storage——解耦 persist）
        }
        if (P.getNameRules && P.getNameRules()) {
          T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en')
            ? 'Note: a saved custom regex rule has the highest priority — it may override this grouping.'
            : '注意：已保存的自定义规则（最高优先）可能覆盖本次分组。');
        }
        applyRebuildCurrent(); // t61④：应用=立即在当前数据重算生效
        var mm = $('name-preview-modal');
        if (mm) mm.hidden = true;
        previewData = null;
        return;
      }
      var hasOps = false, ok;
      for (ok in previewData.groupOps) {
        if (Object.prototype.hasOwnProperty.call(previewData.groupOps, ok)) { hasOps = true; break; }
      }
      var hasRowCust = previewData.rows.some(function (r) { return r.custom; });
      if (hasOps || hasRowCust) {
        // t37：组级批量操作落地 = manual 映射（零新对象；优先级链不变：guided 清空后 manual 生效）
        var map = {};
        previewData.rows.forEach(function (row, ri) {
          // t75：系统名行写恒等（防同名跨段覆盖 + 保 mapHit 全命中激活 manual；解析器按容器语义段归属）
          if (P.isUnnamedSystemName && P.isUnnamedSystemName(row.name)) {
            map[row.name] = row.name;
            return;
          }
          var g = previewData.rowGroup[ri];
          map[row.name] = rowKeyOf(ri, g);
        });
        // t91：组级路径同样链式累计（应用态下再分组叠加）；t107：成员优先公式（同手动）
        var prevM = (state.groupApplied && state.groupRulesSnapshot && state.groupRulesSnapshot.manual) ? state.groupRulesSnapshot.manual : null;
        if (prevM) {
          var chainedM = {};
          Object.keys(prevM).forEach(function (k) {
            var mid = prevM[k];
            var b0 = String(k).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim();
            chainedM[k] = (map[b0] !== undefined) ? map[b0] : ((map[mid] !== undefined) ? map[mid] : mid);
          });
          map = chainedM;
        }
        P.saveGuidedRuleToStorage(null); // manual 必须生效（防旧 guided 覆盖）
        P.saveNameManualMapToStorage(map);
        // t38 观察③：用户自定义正则（最高优先）存在时——提示可能覆盖本次分组（语义透明）
        if (P.getNameRules && P.getNameRules()) {
          T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en')
            ? 'Note: a saved custom regex rule has the highest priority — it may override this grouping.'
            : '注意：已保存的自定义规则（最高优先）可能覆盖本次分组。');
        }
      } else {
        var row0 = previewData.rows[0];
        var parts = [];
        for (var i = 0; i < row0.blocks.length; i++) {
          var role = row0.roles[i];
          if (role === 'cond' || role === 'channel' || role === 'direction') {
            parts.push({ role: role, blockIndex: i, pattern: row0.blocks[i].text });
          }
        }
        var hasCond = parts.some(function (p) { return p.role === 'cond'; });
        if (!hasCond) {
          var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
          T.showToast(isEn ? 'Mark at least one block as the condition first.' : '请先标记至少一个「条件」块。');
          return;
        }
        P.saveGuidedRuleToStorage({ mode: 'guided', parts: parts, compiled: '' });
        P.saveNameManualMapToStorage(null); // 清旧 manual 残留（自动路径）
      }
      applyRebuildCurrent(); // t75：组级应用同样立即在当前数据重算生效（与手动路径一致——应用即时生效，恢复才有对称语义）
      var m = $('name-preview-modal');
      if (m) m.hidden = true;
      previewData = null;
    }
    var pvApply = $('name-preview-apply');
    if (pvApply) pvApply.addEventListener('click', applyPreview);
    var pvClear = $('name-preview-clear');
    if (pvClear) pvClear.addEventListener('click', function () {
      // t75：恢复原始分组（应用可逆）——清规则（guided/manual 内存+存储）→ 原始文本无规则重解析 → 还原数据 + 条件列表回流
      P.saveGuidedRuleToStorage(null);
      P.saveNameManualMapToStorage(null);
      var restored = false;
      var cur = currentData();
      if (cur && cur.rawText) {
        try {
          // R1：恢复走分组模型管线（buildGroupModel→groupsToConditions——与应用同源；行为等价）
          var nd = P.buildGroupModel(cur.rawText, cur.fileName || '');
          if (nd) nd = P.groupsToConditions(nd);
          if (nd) {
            nd.rawText = cur.rawText; // t75：保持原文（下次恢复仍可还原）
            var f = state.files[state.currentIndex];
            if (f) f.data = nd;
            restored = true;
          }
        } catch (e) { /* 还原失败 → 回退提示 */ }
      }
      // R3：可逆状态机——恢复 = GROUP_ORIGINAL（快照清零）+ 规则清除 + 模型重算（与应用对称）
      state.groupApplied = false;
      state.groupRulesSnapshot = null;
      state.groupSeriesSnap = null; // t105：系列合并决策快照一并清除（恢复=全量）
      renderAll(); // 左侧条件列表/汇总/详情/图表同步回流（含 prefs 按名匹配）
      var m = $('name-preview-modal');
      if (m) m.hidden = true;
      previewData = null;
      T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? (restored ? 'Restored — original grouping recalculated.' : 'Rules cleared — re-load the file to restore.')
        : (restored ? '已恢复原始分组——当前数据已还原。' : '规则已清除——重新加载文件以还原。'));
    });
    var pvModal = $('name-preview-modal');
    if (pvModal) {
      pvModal.addEventListener('click', function (e) { if (e.target === pvModal) pvModal.hidden = true; });
      // t61③：滚轮穿透——面板内滚动容器（np-scroll/滚动区）滚到边界时阻止，主页面不随滚；t71：滚动容器换为 .nb-scrollbody（nb-grid 已在滚动区内自然伸展，不再自滚）
      // t93：np-scroll 已取消内滚（t85 单滚动层）——非滚动容器不作边界判定（否则 scrollTop=0/无余量 → 全部 preventDefault——内容区滚轮偶发失效）
      pvModal.addEventListener('wheel', function (e) {
        var sc = null, tgt = e.target;
        if (tgt && tgt.closest) {
          sc = tgt.closest('.nb-scrollbody .np-scroll');
          if (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = null; // t93：无滚动余量的 np-scroll → 下移滚动层
          if (!sc) sc = tgt.closest('.nb-scrollbody');
          if (!sc) sc = tgt.closest('.name-preview-body');
        }
        if (sc) {
          var top = sc.scrollTop <= 0;
          var bottom = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) <= 1;
          if ((e.deltaY < 0 && top) || (e.deltaY > 0 && bottom)) e.preventDefault();
        } else {
          e.preventDefault(); // modal 内非滚动区（标题/msg/actions）→ 主页面不滚
        }
      });
    }
    /** t63-F2：maybeShowNamePreview 死代码清理——t47 轻提示改造后不再被调用（触发走 maybeShowNameGuideOrPreview）；手动入口 btn-name-groups 直接 showNamePreview */
    var ngBtn = $('btn-name-groups');
    if (ngBtn) ngBtn.addEventListener('click', function () {
      var cur = currentData();
      // t99：合并落地后 namePreview=null（t97）——按钮仍可打开（conditions 事实源 fallback）
      if (cur && (cur.namePreview || (cur.conditions && cur.conditions.length))) showNamePreview(cur);
    });
    JVMain.showNamePreview = showNamePreview; // 供强制打开/测试

    /* ---------- v1.2-I3：名字理解向导（导入自动弹，spec 5.1/5.2） ---------- */
    var guideData = null; // { data, step, choice, mode, samples }
    var guideSkip = false;
    function loadGuideSkip() { guideSkip = false; try { guideSkip = localStorage.getItem('jv_guide_skip') === '1'; } catch (e) {} }
    function saveGuideSkip(v) { try { v ? localStorage.setItem('jv_guide_skip', '1') : localStorage.removeItem('jv_guide_skip'); } catch (e) {} guideSkip = !!v; }
    /** 触发：mix/none 非单一明确 → 弹向导（skip 记忆则不弹）；single 高置信不弹 */
    function maybeShowNameGuide(data) {
      if (guideSkip) return false;
      if (!data || data.sourceFormat !== 'raw' || !data.namePreview || !data.namePreview.length) return false;
      var mix = P.detectNameTemplateMix(data.namePreview.map(function (p) { return p.name; }));
      if (mix.state === 'single') return false;
      showNameGuide(data);
      return true;
    }
    function showNameGuide(data) {
      var m = $('name-guide-modal'), body = $('name-guide-body');
      if (!m || !body) return;
      if (!m.hidden) return;
      var seen = {}, samples = [];
      data.namePreview.forEach(function (p) { if (!seen[p.name] && samples.length < 4) { seen[p.name] = true; samples.push(p.name); } });
      guideData = { data: data, step: 1, choice: 'recommended', mode: 'mode2', samples: samples };
      m.hidden = false;
      renderGuide();
    }
    function guideRoleLabel(r) {
      var map = { cond: 'nameBlocks.cond', channel: 'nameBlocks.channel', seq: 'nameBlocks.seq', direction: 'nameBlocks.direction', ignored: 'nameBlocks.ignored' };
      var key = map[r];
      return key ? (typeof I18N !== 'undefined' ? I18N.t(key) : key) : '';
    }
    /** 由 choice/mode 生成候选 guided parts（首行块索引；'whole'/'mode1'=整名=null 特殊） */
    function guideCandidate() {
      if (!guideData || !guideData.data.namePreview.length) return null;
      if (guideData.choice === 'whole' || guideData.mode === 'mode1') return null; // 整名=条件（旧行为）
      var row0 = guideData.data.namePreview[0];
      var blocks = P.splitNameBlocks(row0.name);
      var roles = P.nameBlockRoles(row0.name);
      var parts = [];
      var condIdx = null;
      blocks.forEach(function (b, i) {
        var rec = roles[i];
        if (guideData.mode === 'mode3') { if (i === 0) condIdx = 0; return; }
        if (!rec || !rec.recommended) return;
        if (rec.recommended === 'cond') condIdx = i;
        else if (rec.recommended === 'channel') parts.push({ role: 'channel', blockIndex: i, pattern: b.text });
        else if (rec.recommended === 'direction') parts.push({ role: 'direction', blockIndex: i, pattern: b.text });
      });
      if (condIdx === null && guideData.mode !== 'mode3') return null; // 无 cond 候选 → 走手动
      if (condIdx === null && guideData.mode === 'mode3') condIdx = 0;
      parts.unshift({ role: 'cond', blockIndex: condIdx, pattern: blocks[condIdx].text });
      return { mode: 'guided', parts: parts, compiled: '' };
    }
    /** 按候选 parts 模拟分组（预览） */
    function groupsForCandidate(cand) {
      var groups = {}, order = [];
      guideData.data.namePreview.forEach(function (p) {
        var k;
        if (!cand) k = p.name; // 整名=条件
        else {
          var blocks = P.splitNameBlocks(p.name);
          k = '';
          var ok = true;
          cand.parts.forEach(function (part) {
            if (part.role !== 'cond') return;
            var b = blocks[part.blockIndex];
            if (!b) { ok = false; return; }
            k += b.text;
          });
          if (!ok || k === '') k = p.name;
        }
        if (!groups[k]) { groups[k] = { key: k, count: 0, example: p.name }; order.push(k); }
        groups[k].count++;
      });
      return order.map(function (k) { return groups[k]; });
    }
    function renderGuide() {
      var body = $('name-guide-body');
      if (!body || !guideData) return;
      var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      var html = '';
      var t = function (k) { return (typeof I18N !== 'undefined') ? I18N.t(k) : k; }; // t34 观察③：typeof 守卫统一
      if (guideData.step === 1) {
        html += '<div class="np-step-title"><b>' + (isEn ? 'Step 1 · ' : '第 1 步 · ') + esc(t('nameGuide.step1')) + '</b></div>';
        html += '<div class="np-step-desc">' + esc(t('nameGuide.step1Desc')) + '</div>';
        guideData.samples.forEach(function (nm) {
          var blocks = P.splitNameBlocks(nm);
          var roles = P.nameBlockRoles(nm);
          html += '<div class="np-row"><span class="np-name">' + esc(nm) + '</span><span class="np-blocks">';
          blocks.forEach(function (b, i) {
            var r = roles[i];
            var lbl = r && r.recommended ? guideRoleLabel(r.recommended) : '';
            var rcls = r && r.recommended ? ('rb-' + r.recommended) : '';
            html += '<span class="np-block ' + rcls + '">' + esc(b.text) + (lbl ? ' <b>' + esc(lbl) + '</b>' : '') + '</span>';
          });
          html += '</span></div>';
        });
      } else if (guideData.step === 2) {
        html += '<div class="np-step-title"><b>' + (isEn ? 'Step 2 · ' : '第 2 步 · ') + esc(t('nameGuide.step2')) + '</b></div>';
        html += '<div class="np-step-desc">' + esc(t('nameGuide.step2Desc')) + '</div>';
        var choiceKey = guideData.choice === 'whole' ? 'whole' : (guideData.choice === 'none' ? 'none' : 'recommended');
        html += '<div class="np-choices">';
        [['recommended', 'nameGuide.optRecommended'], ['whole', 'nameGuide.optWhole'], ['none', 'nameGuide.optNone']].forEach(function (c) {
          html += '<label class="np-choice"><input type="radio" name="guide-choice" value="' + c[0] + '"' + (choiceKey === c[0] ? ' checked' : '') + '> ' + esc(t(c[1])) + '</label>';
        });
        html += '</div>';
        html += '<div class="np-modes">';
        [['mode1', 'nameGuide.modeCard1', 'nameGuide.modeCard1Desc'], ['mode2', 'nameGuide.modeCard2', 'nameGuide.modeCard2Desc'], ['mode3', 'nameGuide.modeCard3', 'nameGuide.modeCard3Desc']].forEach(function (c) {
          html += '<label class="np-mode' + (guideData.mode === c[0] ? ' np-mode-sel' : '') + '"><input type="radio" name="guide-mode" value="' + c[0] + '"' + (guideData.mode === c[0] ? ' checked' : '') + '><b>' + esc(t(c[1])) + '</b><span>' + esc(t(c[2])) + '</span></label>';
        });
        html += '</div>';
      } else {
        var cand = guideCandidate();
        var groups = groupsForCandidate(cand);
        html += '<div class="np-step-title"><b>' + (isEn ? 'Step 3 · ' : '第 3 步 · ') + esc(t('nameGuide.step3')) + '</b></div>';
        html += '<div class="np-summary">' + guideData.data.namePreview.length + ' ' +
          (isEn ? 'names grouped into' : '个名字归为') + ' <b>' + groups.length + '</b> ' + (isEn ? 'conditions' : '个条件') + '</div>';
        html += '<div class="np-groups">';
        groups.slice(0, 200).forEach(function (g) {
          html += '<div class="np-group">' + esc(g.key) + ' · ' + g.count + (isEn ? ' meas' : ' 测量') + ' · ' + esc(g.example) + '</div>';
        });
        html += (groups.length > 200 ? '<div class="np-group">… ' + (isEn ? 'showing first 200 groups' : '已截断显示前 200 组') + '</div>' : '') + '</div>';
        html += '<div class="np-step-actions">' +
          '<button type="button" class="btn btn-primary" data-gid="confirm">' + esc(t('nameGuide.confirm')) + '</button>' +
          '<button type="button" class="btn" data-gid="review">' + esc(t('nameGuide.review')) + '</button>' +
          '<button type="button" class="btn" data-gid="keep">' + esc(t('nameGuide.keep')) + '</button></div>';
      }
      body.innerHTML = html;
      var backB = $('name-guide-back'), nextB = $('name-guide-next');
      if (backB) backB.hidden = guideData.step === 1;
      if (nextB) nextB.hidden = guideData.step === 3;
    }
    /** body 事件委托：单选/模式卡/step3 按钮 */
    var gBody = $('name-guide-body');
    if (gBody) gBody.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'guide-choice') { guideData.choice = t.value; if (t.value !== 'none') guideData.mode = 'mode2'; }
      else if (t.name === 'guide-mode') { guideData.mode = t.value; guideData.choice = 'recommended'; }
    });
    if (gBody) gBody.addEventListener('click', function (e) {
      var g = e.target && e.target.getAttribute ? e.target.getAttribute('data-gid') : null;
      if (!g) return;
      if (g === 'confirm') {
        var cand = guideCandidate();
        if (cand) { P.saveGuidedRuleToStorage(cand); saveGuideSkip(true); }
        else { saveGuideSkip(true); } // 整名=条件：无规则（旧行为），记忆 skip
        closeGuide();
        T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Applied — re-load the file to see the result.' : '已应用——重新加载文件后生效。');
      } else if (g === 'review') { guideData.step = 2; renderGuide(); }
      else if (g === 'keep') { closeGuide(); }
    });
    function closeGuide() { var m = $('name-guide-modal'); if (m) m.hidden = true; guideData = null; }
    var gBack = $('name-guide-back');
    if (gBack) gBack.addEventListener('click', function () {
      if (guideData && guideData.step > 1) { guideData.step--; renderGuide(); }
      else closeGuide();
    });
    var gNext = $('name-guide-next');
    if (gNext) gNext.addEventListener('click', function () {
      if (!guideData) return;
      if (guideData.step === 1) { guideData.step = 2; renderGuide(); }
      else if (guideData.step === 2) {
        if (guideData.choice === 'none') { closeGuide(); var cur = currentData(); if (cur && cur.namePreview) showNamePreview(cur); return; } // 手动 → 块编辑器
        guideData.step = 3; renderGuide();
      }
    });
    var gModal = $('name-guide-modal');
    if (gModal) gModal.addEventListener('click', function (e) { if (e.target === gModal) closeGuide(); });
    /** 触发集成（t47）：addFile 后默认**不弹**分组 modal——多模板/低置信仅轻提示（手动入口 🧩）；
     *  single 高置信静默；已有规则（nameRules/guided/manual 全覆盖）生效时静默（语义不变）。 */
    function maybeShowNameGuideOrPreview(data) {
      if (!data || data.sourceFormat !== 'raw' || !data.namePreview || !data.namePreview.length) return;
      var mix = P.detectNameTemplateMix(data.namePreview.map(function (p) { return p.name; }));
      if (mix.state === 'single') return; // 单模板高置信：自动归并，静默
      if (P.getNameRules && P.getNameRules()) return; // 自定义正则（最高优先）已生效 → 静默
      var guided = P.getGuidedRule && P.getGuidedRule();
      if (guided) return; // guided 块规则已生效 → 静默
      var manual = P.getNameManualMap && P.getNameManualMap();
      if (manual && Object.keys(manual).length) {
        var hit = 0;
        data.namePreview.forEach(function (p) { if (manual[p.name] !== undefined) hit++; });
        if (hit === data.namePreview.length) return; // 手动映射记忆全覆盖：解析时已自动应用 → 静默
      }
      T.showToast((typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? 'Multiple name patterns detected — open "🧩 Condition Grouping" if you need to group them.'
        : '检测到多种命名模式——如需分组请打开「🧩 条件分组」。');
    }
    loadGuideSkip();
    JVMain.showNameGuide = showNameGuide; // 供强制打开/测试
    JVMain._nbBoard = function () { return previewData ? previewData.board : null; }; // t115：只读审计口——条目化撤销栈/操作日志（history）
    JVMain._maybeShowNameGuideOrPreview = maybeShowNameGuideOrPreview;
    JVMain._loadGuideSkip = loadGuideSkip; // 供测试（重置「不再提示」场景同步模块变量）

    /* ---------- 第三十七批方案B：手动合并/拆分（整理模式） ---------- */
    var condMode = $('cond-merge-mode');
    var condMergeBtn = $('cond-merge-btn');
    var condExit = $('cond-merge-exit');
    if (condMode) condMode.addEventListener('click', toggleMergeMode);
    if (condMergeBtn) condMergeBtn.addEventListener('click', doMergeSelected);
    if (condExit) condExit.addEventListener('click', toggleMergeMode);
    var cmModal = $('cond-merge-modal');
    var cmOk = $('cond-merge-ok');
    var cmCancel = $('cond-merge-cancel');
    if (cmOk) cmOk.addEventListener('click', confirmManualMerge);
    if (cmCancel) cmCancel.addEventListener('click', function () { if (cmModal) cmModal.hidden = true; });
    if (cmModal) cmModal.addEventListener('click', function (e) { if (e.target === cmModal) cmModal.hidden = true; });
    if (pdfModal) pdfModal.addEventListener('click', function (e) { if (e.target === pdfModal) pdfModal.hidden = true; });

    // 第三十二批：均值标记/原始数据点复选框已删除（⚙ 调整格式器内已有对应开关，避免重复入口）
    // 第十六批：轴标题位置固定 'left'，控件已删除

    // 图表点击放大（Lightbox）关闭：✕ / 暗区点击 / Esc
    var lightboxClose = $('lightbox-close');
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    var lightboxMask = $('chart-lightbox');
    if (lightboxMask) lightboxMask.addEventListener('click', function (e) { if (e.target === lightboxMask) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lightboxMask && !lightboxMask.hidden) closeLightbox();
      if (e.key === 'Escape' && $('style-editor') && !$('style-editor').hidden) closeStyleEditor(); // 第二十四批
    });
    // 第二十四批：样式编辑器关闭（✕ / 遮罩点击）
    var styleClose = $('style-editor-close');
    if (styleClose) styleClose.addEventListener('click', closeStyleEditor);
    var styleMask = $('style-editor');
    if (styleMask) styleMask.addEventListener('click', function (e) { if (e.target === styleMask) closeStyleEditor(); });
    // 图型切换 tab（第二十四批补）
    ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
      var btn = $('style-kind-' + k);
      if (btn) btn.addEventListener('click', function () { switchStyleKind(k); });
    });
    // 编辑器内复制/下载/恢复默认
    var scCopy = $('style-copy'), scSvg = $('style-svg'), scReset = $('style-reset');
    if (scCopy) scCopy.addEventListener('click', function () {
      C.exportChartOffscreen(makePreviewRender(styleEditorKind), exportSizeFor(styleEditorKind), 'chart');
    });
    if (scSvg) scSvg.addEventListener('click', function () {
      C.exportChartOffscreen(makePreviewRender(styleEditorKind), exportSizeFor(styleEditorKind), 'chart', true);
    });
    if (scReset) scReset.addEventListener('click', function () {
      if (!confirm((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Reset all chart styles to defaults?' : '恢复所有图像格式到默认值？')) return; // N1：英文态 confirm 双语化
      C.resetChartStyle();
      buildStyleConsole();
      renderStylePreview();
      renderAll();
    });
    var lbCopy = $('lightbox-copy');
    var lbSvg = $('lightbox-svg');
    // 根修：lightbox 导出也走离屏（exportMode 白边收窄 + 关动画），不再直接导页面 grid 的实例
    if (lbCopy) lbCopy.addEventListener('click', function () {
      if (lightboxChart && lightboxRender) C.exportChartOffscreen(lightboxRender, exportSizeFor(lightboxKind), lightboxBase);
    });
    if (lbSvg) lbSvg.addEventListener('click', function () {
      if (lightboxChart && lightboxRender) C.exportChartOffscreen(lightboxRender, exportSizeFor(lightboxKind), lightboxBase, true);
    });
    initLightboxInteractions(); // 滚轮缩放 / 拖拽平移 / ➕➖重置（改动 4）

    // 图表视图分段按钮（P5-2：单张箱线 / 合并箱线 / JV 叠加 直接跳转，不再循环点击）
    var viewTabs = [
      ['btn-view-single', 'single'],
      ['btn-view-combined', 'combined'],
      ['btn-view-jv', 'jv']
    ];
    viewTabs.forEach(function (pair) {
      var b = $(pair[0]);
      if (b) b.addEventListener('click', function () {
        if (state.view === pair[1]) return;
        state.view = pair[1];
        renderAll();
      });
    });

    // 面板收起/展开
    var btnCollapse = $('btn-collapse');
    if (btnCollapse) btnCollapse.addEventListener('click', function () {
      var panel = $('cond-panel');
      panel.classList.toggle('collapsed');
      btnCollapse.textContent = panel.classList.contains('collapsed') ? '»' : '«';
      renderAll();
    });
  }

  /* ================================================================
   * 文件读取与解析（4.1：编码自动识别 UTF-8 / GBK）
   * 第二个文件起弹窗询问：分开两页 / 合并绘制 / 取消（7.2 扩展）
   * ================================================================ */
  var fileQueue = [];   // 待处理文件队列（一次拖入多个时串行）
  var pendingFile = null; // 正在等待弹窗决策的文件

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    fileQueue = fileQueue.concat(files);
    processQueue();
  }

  /** 串行处理队列：第一个文件直接导入；其后弹窗询问导入方式 */
  function processQueue() {
    if (fileQueue.length === 0) return;
    var file = fileQueue.shift();
    readFile(file).then(function (data) {
      if (!data) {
        T.showToast('无法解析「' + file.name + '」：不是支持的仪器原始格式或处理后格式');
        processQueue();
        return;
      }
      // 同名文件提示并跳过（7.1）
      var dup = state.files.some(function (f) { return f.name === file.name; });
      if (dup) {
        T.showToast('已存在同名文件「' + file.name + '」，已跳过');
        processQueue();
        return;
      }
      if (state.files.length === 0) {
        addFile(file.name, data);
        processQueue();
      } else {
        pendingFile = { name: file.name, data: data };
        showMergeModal(file.name);
      }
    }).catch(function (err) {
      T.showToast('读取文件失败：' + err.message);
      processQueue();
    });
  }

  function addFile(name, data) {
    // 第十九批：初始无显式 Base 时，自动把第一个条件设为 Base（画 ⚑、参与对比，一切与手动点选相同；
    // 用户点「设为Base」取消后 first=false，不再自动重设——与隐式对比（第十八批）的差别就在可取消）
    var anyFirst = false;
    data.conditions.forEach(function (c) { if (getPref(c).first) anyFirst = true; });
    if (!anyFirst && data.conditions.length) getPref(data.conditions[0]).first = true;
    state.files.push({ name: name, data: data });
    state.currentIndex = state.files.length - 1;
    renderAll();
    // 第三十七批：检测条件系列命名歧义 → 未决候选弹窗让用户决定合并/分开
    maybeSuggestGrouping(data);
    // v1.1-I3：低置信/多模板 → 名称解析预览（交互兜底；记忆映射已覆盖则不弹）
    if (JVMain._maybeShowNameGuideOrPreview) JVMain._maybeShowNameGuideOrPreview(data); // v1.2-I3：名字理解向导优先（skip 后回退块编辑器/预览）
  }

  /* ---------- 导入方式弹窗 ---------- */
  var mergeNewName = null; // 当前待决策的新文件名（切语言重绘用）
  function paintMergeMsg() {
    var cur = state.files[state.currentIndex];
    var en = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
    $('merge-msg').textContent = en
      ? ('Already imported "' + (cur ? cur.name : '') + '", how to open "' + mergeNewName + '"?\n' +
         '· Open Separately: the two files are opened in separate top tabs;\n' +
         '· Merge & Plot: conditions of both files are listed side by side in one chart (same-name conditions are NOT merged; a file-name prefix is added).')
      : ('已导入「' + (cur ? cur.name : '') + '」，如何处理「' + mergeNewName + '」？\n' +
         '· 分开两页：两个文件在顶部标签独立查看；\n' +
         '· 合并绘制：两个文件的条件并列到同一张图对比（同名条件不合并，条件名前加文件前缀）。');
  }
  function showMergeModal(newName) {
    mergeNewName = newName;
    paintMergeMsg();
    $('merge-modal').hidden = false;
  }

  function hideMergeModal() { $('merge-modal').hidden = true; }

  /* ================================================================
   * 第三十七批：条件系列合并建议弹窗
   *   检测到同主体多后缀命名（PVK-1/2/3/4、QX1/QX2）→ 用户决定合并/分开；
   *   勾选"记住"写入 localStorage（jv_cond_group_decisions），下次同主体自动应用。
   * ================================================================ */
  var pendingGroupData = null;   // 正在决策的数据对象
  var pendingGroupCands = null;  // 候选组缓存（i-7：弹窗开态切语言重绘用）
  var groupRows = [];            // [{ core, merge, bMerge, bSplit }]

  function maybeSuggestGrouping(data) {
    if (!data || !data.conditions || !data.conditions.length) return;
    var candidates = P.detectGroupCandidates(data.conditions);
    if (!candidates.length) return;
    // 六项修复 5：不再应用历史记忆，每次导入检测到候选组都弹窗询问
    showGroupModal(data, candidates);
  }

  function showGroupModal(data, candidates) {
    pendingGroupData = data;
    pendingGroupCands = candidates;
    groupRows = [];
    var list = $('group-list');
    if (!list) return;
    list.innerHTML = '';
    candidates.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'group-row';
      var info = document.createElement('span');
      info.className = 'group-row-info';
      if (typeof I18N !== 'undefined' && I18N.getLang() === 'en') {
        info.textContent = g.names.join(', ') + ' (' + g.devices + ' devices) → merge as "' + g.core + '"';
      } else {
        info.textContent = g.names.join('、') + '（共 ' + g.devices + ' 器件）→ 合并为 "' + g.core + '"';
      }
      var btns = document.createElement('span');
      btns.className = 'group-row-btns';
      function mkBtn(label, isMerge) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn group-btn' + (isMerge ? '' : ' group-btn-active');
        b.textContent = label;
        b.addEventListener('click', function () {
          var r = groupRows.filter(function (x) { return x.core === g.core; })[0];
          if (!r) return;
          r.merge = isMerge;
          r.bMerge.className = 'btn group-btn' + (isMerge ? ' group-btn-active' : '');
          r.bSplit.className = 'btn group-btn' + (!isMerge ? ' group-btn-active' : '');
        });
        return b;
      }
      var bMerge = mkBtn((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Merge' : '合并', true); // i-7：行内按钮双语（与 modal.keepAll/mergeAll 批量按钮词条区分）
      var bSplit = mkBtn((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Keep separate' : '保持分开', false);
      btns.appendChild(bMerge);
      btns.appendChild(bSplit);
      row.appendChild(info);
      row.appendChild(btns);
      list.appendChild(row);
      groupRows.push({ core: g.core, merge: false, bMerge: bMerge, bSplit: bSplit });
    });
    $('group-modal').hidden = false;
  }

  function setAllGroupRows(merge) {
    groupRows.forEach(function (r) {
      r.merge = merge;
      r.bMerge.className = 'btn group-btn' + (merge ? ' group-btn-active' : '');
      r.bSplit.className = 'btn group-btn' + (!merge ? ' group-btn-active' : '');
    });
  }

  function confirmGrouping() {
    var data = pendingGroupData;
    if (!data) return;
    var decisions = {};
    groupRows.forEach(function (r) { if (r.merge) decisions[r.core] = 'merge'; });
    if (Object.keys(decisions).length) {
      // t105：系列合并决策快照（成员名+设备数——预览/拆分数据源；拆分=单组决策删除+重算语义）
      var seriesSnap = {};
      Object.keys(decisions).forEach(function (core) {
        var mems = data.conditions.filter(function (c) {
          return P.seriesTailCore(c.name) === core && c.name !== core;
        }).map(function (c) { return { name: c.name, devN: c.devices.length }; });
        if (mems.length) seriesSnap[core] = mems;
      });
      state.groupSeriesSnap = seriesSnap;
      // t107：series 态置 GROUP_APPLIED + 快照转 chain（记录名→合并后条件名——apply 重算的 manual 激活与键域对齐；前提 namePreview 尚未置 null）
      var prevMap = {};
      (data.namePreview || []).forEach(function (p) {
        var baseName = String(p.name).replace(/\.CH_Ref\(\d+\)|\.Device\(\d+\)\s*$/g, '').trim();
        var target = baseName;
        Object.keys(seriesSnap).forEach(function (core) {
          if (baseName === core || seriesSnap[core].some(function (m) { return m.name === baseName; })) target = core;
        });
        prevMap[p.name] = target;
      });
      state.groupApplied = true;
      state.groupRulesSnapshot = { guided: null, manual: prevMap };
      migratePrefsForMerge(data, decisions);
      data.conditions = P.applyGroupDecisions(data.conditions, decisions);
      data.stats.conditionCount = data.conditions.length;
      data.namePreview = null; // t97：系列合并落地后预览失效——分组面板打开按当前 conditions 重建（事实源——不复显示原始条件集）
      // t101：分组面板开着时（↺ 合并建议 → 确认）——失效重建为合并态（事实源）；showNamePreview 的 !hidden 守卫需先隐藏
      // （previewData/showNamePreview 在 init 作用域不可达——用顶层 JVMain.showNamePreview 重建）
      var pvModalOpen = $('name-preview-modal');
      if (pvModalOpen && !pvModalOpen.hidden) {
        pvModalOpen.hidden = true;
        if (JVMain.showNamePreview) JVMain.showNamePreview(data);
      }
    }
    $('group-modal').hidden = true;
    pendingGroupData = null;
    groupRows = [];
    renderAll();
  }

  function cancelGrouping() {
    $('group-modal').hidden = true;
    pendingGroupData = null;
    groupRows = [];
  }

  /** 合并后 prefs 迁移：成员（PVK-1…）的 checked/first/displayName/__order 归并到主体（PVK） */
  function migratePrefsForMerge(data, decisions) {
    Object.keys(decisions).forEach(function (core) {
      var ck = core.toLowerCase();
      var names = [];
      data.conditions.forEach(function (c) {
        if (P.seriesCore(c.name) === core && String(c.name).toLowerCase() !== ck) names.push(c.name);
      });
      if (!names.length) return;
      migratePrefsMerge(core, names);
    });
  }

  /** 合并后 prefs 迁移（第三十七批方案B 通用版）：成员 checked/first/displayName/__order 归并到目标条件 */
  function migratePrefsMerge(targetName, memberNames) {
    var ck = String(targetName).toLowerCase();
    var names = memberNames.filter(function (n) { return String(n).toLowerCase() !== ck; });
    var merged = { checked: true, displayName: targetName, first: false };
    names.forEach(function (n) {
      var p = state.prefs[String(n).toLowerCase()];
      if (p) {
        if (!p.checked) merged.checked = false;
        if (p.first) merged.first = true;
        if (p.displayName && p.displayName !== n) merged.displayName = p.displayName;
      }
      delete state.prefs[String(n).toLowerCase()];
    });
    if (state.prefs[ck]) {
      if (!state.prefs[ck].checked) merged.checked = false;
      if (state.prefs[ck].first) merged.first = true;
      if (state.prefs[ck].displayName && state.prefs[ck].displayName !== targetName) merged.displayName = state.prefs[ck].displayName;
    }
    state.prefs[ck] = merged;
    var order = state.prefs.__order || [];
    var newOrder = [], inserted = false;
    order.forEach(function (o) {
      var isMember = names.some(function (n) { return String(n).toLowerCase() === o; });
      if (isMember) {
        if (!inserted) { newOrder.push(ck); inserted = true; }
      } else newOrder.push(o);
    });
    state.prefs.__order = newOrder;
  }

  /* ================================================================
   * 第三十七批方案B：条件面板手动合并/拆分（整理模式）
   * ================================================================ */
  function refreshMergeBtn() {
    var btn = $('cond-merge-btn');
    if (btn) btn.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('Merge selected (' + state.condMergeSelected.length + ')') : ('合并所选（' + state.condMergeSelected.length + '）');
    if (btn) btn.disabled = state.condMergeSelected.length < 2;
  }
  function toggleMergeMode() {
    state.condMergeMode = !state.condMergeMode;
    state.condMergeSelected = [];
    var mode = $('cond-merge-mode'), mergeBtn = $('cond-merge-btn'), exitBtn = $('cond-merge-exit');
    if (mode) mode.hidden = state.condMergeMode;
    if (mergeBtn) mergeBtn.hidden = !state.condMergeMode;
    if (exitBtn) exitBtn.hidden = !state.condMergeMode;
    refreshMergeBtn();
    renderAll();
  }
  function doMergeSelected() {
    var data = currentData();
    if (!data || state.condMergeSelected.length < 2) return;
    // 预填合并名：第一个选中条件名（用户可改）
    var input = $('cond-merge-name');
    if (input) input.value = state.condMergeSelected[0];
    var msg = $('cond-merge-msg');
    if (msg) msg.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('Merge ' + state.condMergeSelected.length + ' selected conditions into one statistic (devices carry source tags, see detail table; can be split later): ' + state.condMergeSelected.join(', ')) : ('将所选 ' + state.condMergeSelected.length + ' 个条件合并为一个条件统计（器件会标注来源，详情表可查；拆分可随时还原）：' + state.condMergeSelected.join('、'));
    var modal = $('cond-merge-modal');
    if (modal) modal.hidden = false;
  }
  function confirmManualMerge() {
    var data = currentData();
    if (!data) return;
    var input = $('cond-merge-name');
    var target = input ? input.value.trim() : '';
    if (!target) { T.showToast('请输入合并后的条件名'); return; }
    if (state.condMergeSelected.indexOf(target) < 0 && data.conditions.some(function (c) { return c.name === target; })) {
      // 目标已存在且不在选中集：允许（并入现有同名条件）
    }
    migratePrefsMerge(target, state.condMergeSelected);
    data.conditions = P.mergeConditions(data.conditions, target, state.condMergeSelected);
    data.stats.conditionCount = data.conditions.length;
    $('cond-merge-modal').hidden = true;
    toggleMergeMode(); // 退出整理模式并重渲染
    T.showToast('已合并为「' + target + '」');
  }
  function splitCondition(name) {
    var data = currentData();
    if (!data) return;
    var cond = data.conditions.filter(function (c) { return c.name === name; })[0];
    if (!cond || !cond.merged) return;
    var tEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // N1：拆分确认框双语化
    var memberNames = (cond.mergedFrom || []).length ? (cond.mergedFrom || []).join(tEn ? ', ' : '、') : (tEn ? 'member conditions' : '成员条件');
    if (!window.confirm(tEn ? ('Split "' + name + '"? Will restore to: ' + memberNames) : ('确定拆分「' + name + '」吗？将还原为：' + memberNames))) return;
    data.conditions = P.splitConditions(data.conditions, name);
    data.stats.conditionCount = data.conditions.length;
    // prefs：目标键移除（拆出的成员条件按默认状态重建）
    delete state.prefs[name.toLowerCase()];
    var order = state.prefs.__order || [];
    var idx = order.indexOf(name.toLowerCase());
    if (idx >= 0) order.splice(idx, 1);
    state.prefs.__order = order;
    renderAll();
    T.showToast('已拆分「' + name + '」');
  }

  /** 合并绘制：条件并列（B 文件每个条件名加文件名前缀），器件数据各自保留 */
  function mergeData(dataA, fileNameB, dataB) {
    var prefixB = stripExt(fileNameB);
    var prefixA = stripExt(dataA.fileName || '');
    // 第十八批：只对重名条件加文件前缀（统计两侧全部条件名出现次数）
    var nameCount = {};
    [dataA, dataB].forEach(function (d) {
      d.conditions.forEach(function (c) {
        var k = (c.displayName || c.name).toLowerCase();
        nameCount[k] = (nameCount[k] || 0) + 1;
      });
    });
    function copyCond(c, filePrefix, selfName) {
      var dup = nameCount[(c.displayName || c.name).toLowerCase()] >= 2;
      var pfx = dup ? filePrefix + ':' : ''; // 重名才加「文件名:」
      return {
        name: pfx + c.name,
        displayName: pfx + (c.displayName || c.name),
        devices: c.devices.map(function (d) { return Object.assign({}, d); }),
        maxDeviceIndex: c.maxDeviceIndex,
        maxEff: c.maxEff,
        titleFwdEff: c.titleFwdEff,
        titleRevEff: c.titleRevEff
      };
    }
    var condsA = dataA.conditions.map(function (c) { return copyCond(c, prefixA, c); });
    var condsB = dataB.conditions.map(function (c) { return copyCond(c, prefixB, c); });
    return {
      fileName: (dataA.fileName || '') + ' + ' + prefixB,
      sourceFormat: 'merged',
      conditions: condsA.concat(condsB),
      stats: {
        conditionCount: condsA.length + condsB.length,
        validDeviceCount: (dataA.stats.validDeviceCount || 0) + (dataB.stats.validDeviceCount || 0),
        paramRecordCount: (dataA.stats.paramRecordCount || 0) + (dataB.stats.paramRecordCount || 0),
        channelCount: (dataA.stats.channelCount || 0) + (dataB.stats.channelCount || 0),
        unmatched: 0, anomaly: 0, areaFallback: 0, noRawData: 0
      }
    };
  }

  function mergeWithCurrent(newFile) {
    var cur = state.files[state.currentIndex];
    if (!cur) { addFile(newFile.name, newFile.data); return; }
    var merged = mergeData(cur.data, newFile.name, newFile.data);
    addFile(cur.name + ' + ' + stripExt(newFile.name), merged);
  }

  function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var text = decodeText(reader.result);
          var data = P.parseFile(text, file.name);
          data.rawText = text; // t61④：保留原文——「应用」立即重算当前数据（不依赖保存）
          resolve(data);
        } catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(new Error('FileReader 错误')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 编码检测委托给 parser（先 UTF-8，出现替换字符则试 GBK） */
  function decodeText(buf) {
    return P.decodeBufferText(buf);
  }

  /* ================================================================
   * 渲染调度
   * ================================================================ */
  function renderAll() {
    var data = currentData();
    if (!data) {
      UI.renderPageNav(null, { colorOf: chartColor }); // 空状态导航占位（第三批）
      return;
    }

    // 重渲染前释放旧图表实例（避免反复勾选/切换累积内存）
    disposeCharts();

    UI.renderParseSummary(data.stats);
    UI.renderWarnBar(data.stats, data.fileName);
    UI.renderFileTabs(state.files, state.currentIndex, switchFile);
    UI.renderConditionPanel(data, state.prefs, {
      colorOf: function (i) { return chartColor(i); },
      onChange: renderAll,
      // 第三十七批方案B：合并/拆分
      merging: state.condMergeMode,
      selected: function (name) { return state.condMergeSelected.indexOf(name) >= 0; },
      onToggleSelect: function (name) {
        var i = state.condMergeSelected.indexOf(name);
        if (i >= 0) state.condMergeSelected.splice(i, 1);
        else state.condMergeSelected.push(name);
        refreshMergeBtn();
        renderAll(); // 重渲染更新选中高亮
      },
      onSplit: splitCondition
    });

    // 视图分段按钮 active 态
    ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
      var b = $('btn-view-' + k);
      if (b) b.classList.toggle('active', state.view === k);
    });

    $('empty-state').hidden = true;
    renderSummaryAndCharts();
    renderDetailTables(); // 含 JV 曲线与原始数据折叠（第五批，S4 已并入）
    $('sec-summary').hidden = false;
    $('sec-detail').hidden = false;

    // 页面导航 + 当前区块高亮（第三批）
    renderPageNav();
    setupScrollSpy();
  }

  function switchFile(index) {
    state.currentIndex = index;
    renderAll();
  }

  /* ================================================================
   * 页面导航（第三批）：左侧面板底部区块锚点 + 条件快速跳转
   * ================================================================ */
  function renderPageNav() {
    var data = currentData();
    if (!data) {
      UI.renderPageNav(null, { colorOf: chartColor });
      return;
    }
    var checked = checkedConditions(data);
    var navConds = checked.map(function (c) {
      var pref = getPref(c);
      return { displayName: pref.displayName || c.name };
    });
    UI.renderPageNav(navConds, { colorOf: chartColor });
  }

  /* ================================================================
   * 当前区块高亮（轻量 scroll-spy）：IntersectionObserver 为主 + scroll 兜底；
   * 重渲染时重建 observer/监听，避免泄漏
   * ================================================================ */
  var spyObserver = null;
  var spyScrollHandler = null;
  var spyTicking = false;

  function updateSpy() {
    var sections = ['sec-summary', 'sec-detail']
      .map(function (id) { return document.getElementById(id); })
      .filter(function (el) { return el && !el.hidden; });
    var topId = null, top = Infinity;
    sections.forEach(function (s) {
      var r = s.getBoundingClientRect();
      // 粗略在视口内（顶部进入视口且未完全滚出）
      if (r.top < window.innerHeight * 0.55 && r.bottom > window.innerHeight * 0.15) {
        if (r.top < top) { top = r.top; topId = s.id; }
      }
    });
    var nav = document.getElementById('page-nav');
    if (!nav) return;
    var links = nav.querySelectorAll('.nav-section');
    for (var i = 0; i < links.length; i++) {
      var on = links[i].dataset.section === topId;
      if (on) links[i].classList.add('active');
      else links[i].classList.remove('active');
    }
  }

  function setupScrollSpy() {
    if (spyObserver) { spyObserver.disconnect(); spyObserver = null; }
    if (spyScrollHandler) { window.removeEventListener('scroll', spyScrollHandler); spyScrollHandler = null; }
    if (!('IntersectionObserver' in window)) return;
    var sections = ['sec-summary', 'sec-detail']
      .map(function (id) { return document.getElementById(id); })
      .filter(function (el) { return el && !el.hidden; });
    if (!sections.length) return;
    spyObserver = new IntersectionObserver(updateSpy);
    sections.forEach(function (s) { spyObserver.observe(s); });
    // scroll 兜底（headless/低配环境下 IO 触发不可靠时保持高亮同步）
    spyScrollHandler = function () {
      if (spyTicking) return;
      spyTicking = true;
      requestAnimationFrame(function () { spyTicking = false; updateSpy(); });
    };
    window.addEventListener('scroll', spyScrollHandler, { passive: true });
  }

  /* ---------- S2：汇总表 + 箱线图 ---------- */
  function renderSummaryAndCharts() {
    var data = currentData();
    var wrap = $('summary-table-wrap');
    var checked = checkedConditions(data);
    wrap.innerHTML = '';
    if (checked.length === 0) {
      wrap.appendChild(emptyCard((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Check at least one condition' : '请至少勾选一个条件'));
      return;
    }
    // 汇总表：所有勾选条件共用一张表
    var table = T.buildTable(['Condition', 'Type', 'Voc (V)', 'Jsc (mA/cm^2)', 'Fill Factor (%)', 'Efficiency (%)', 'HI (%)']); // 第七批：HI 百分比
    table.classList.add('dense-table'); // 紧凑可读样式（改动 3）
    // 第十二批 + 第十八批：找 Base 条件（pref.first）；无显式 Base 时隐式取排序后第一个勾选条件
    // （isImplicitBase：参与对比但 ⚑Base 标记不画、pref.first 不写回——排序变化后默认基准跟着变）
    var allAvg = {};
    checked.forEach(function (c, i) { allAvg[i] = T.condAverages(c); });
    var baseIdx = -1;
    checked.forEach(function (c, i) { if (getPref(c).first) baseIdx = i; });
    checked.forEach(function (cond, i) {
      var info = null;
      if (baseIdx >= 0) {
        if (i === baseIdx) {
          info = { base: true }; // Base 行 ⚑ 标记
        } else {
          var b = checked[baseIdx];
          var bMax = b.maxDeviceIndex >= 0 ? T.effOf(b.devices[b.maxDeviceIndex]) : null;
          info = { avg: allAvg[baseIdx], maxPce: bMax, allAvg: allAvg, index: i, baseIdx: baseIdx, baseName: getPref(b).displayName || b.name };
        }
      }
      T.appendSummaryRows(table, cond, softColor(i), info);
    });
    var tblWrap = document.createElement('div');
    tblWrap.className = 'table-scroll';
    tblWrap.appendChild(table);
    var card = document.createElement('div');
    card.className = 'card';
    var head = document.createElement('div');
    head.className = 'card-head-row';
    var title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = (typeof I18N !== 'undefined') ? I18N.t('summary.tableTitle') : '各条件最高值与平均值汇总'; // i18n：动态标题
    head.appendChild(title);
    var btnCopy = makeCopyButton(function () { T.copyTableAsTSV(table); });
    head.appendChild(btnCopy);
    card.appendChild(head);
    card.appendChild(tblWrap);
    wrap.appendChild(card);

    // 箱线图（M3 实现）
    renderBoxplotCards(checked);
  }

  function emptyCard(text) {
    var card = document.createElement('div');
    card.className = 'card';
    card.style.color = 'var(--text-2)';
    card.textContent = text;
    return card;
  }

  function makeCopyButton(action) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? '⧉ Copy Table' : '⧉ 复制表格'; // i18n：动态按钮
    btn.addEventListener('click', action);
    return btn;
  }

  /* ---------- S3：详情表（含最高器件 JV 曲线与原始数据折叠，第五批） ---------- */
  function renderDetailTables() {
    var data = currentData();
    var wrap = $('detail-cards');
    wrap.innerHTML = '';
    var checked = checkedConditions(data);
    if (checked.length === 0) {
      wrap.appendChild(emptyCard((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Check at least one condition' : '请至少勾选一个条件'));
      return;
    }
    checked.forEach(function (cond, i) {
      var pref = getPref(cond);
      var jvFocus = true; // 第十六批：固定聚焦第四象限
      var condNm = pref.displayName || cond.name;
      var card = document.createElement('div');
      card.className = 'detail-card';
      card.id = 'detail-card-' + i; // 导航锚点（显示顺序索引）
      // P5：详情 JV 图当前选中器件（默认最高器件；行点击切换，状态随导出保存）
      var selIdx = state.detailSel && state.detailSel[condNm] != null ? state.detailSel[condNm] : cond.maxDeviceIndex;

      // 详情表
      var table = T.renderDetailTable(cond, softColor(i), function (devIdx, val) {
        onEditEff(cond, devIdx, val);
      }, function (devIdx) {
        onToggleExclude(cond, devIdx);
      }, { onSelectDev: function (devIdx) { onSelectDetailDev(cond, i, condNm, devIdx); } });

      // 横幅：条件名 + JV 按钮 + 复制表格
      var head = document.createElement('div');
      head.className = 'detail-card-head';
      head.style.background = T.shade(softColor(i), 0.82); // 第八批：极浅 tint 替代粉彩实底
      head.style.borderLeft = '4px solid ' + softColor(i); // 左侧粗色条保留条件辨识
      var title = document.createElement('span');
      title.className = 'detail-card-title';
      title.textContent = pref.displayName || cond.name;
      head.appendChild(title);
      var actions = document.createElement('div');
      actions.className = 'chart-card-actions';
      var jvBtns = makeChartBtns();
      actions.appendChild(jvBtns[0]); // ⚙ 调整格式
      actions.appendChild(jvBtns[1]); // 复制图片
      actions.appendChild(jvBtns[2]); // 下载矢量图
      actions.appendChild(makeCopyButton(function () { T.copyTableAsTSV(table); }));
      head.appendChild(actions);
      card.appendChild(head);

      // body：左详情表 + 右 JV 曲线
      var body = document.createElement('div');
      body.className = 'detail-card-body';
      var leftCol = document.createElement('div');
      leftCol.className = 'detail-table-col';
      leftCol.appendChild(table);
      body.appendChild(leftCol);
      var rightCol = document.createElement('div');
      rightCol.className = 'detail-jv-col';
      // P5：选中器件（默认最高）；selIdx 可能因排除变化越界，防御回退
      var curIdx = selIdx;
      if (curIdx < 0 || !cond.devices[curIdx] || cond.devices[curIdx].excluded) {
        curIdx = cond.maxDeviceIndex;
        if (state.detailSel) state.detailSel[condNm] = curIdx;
      }
      if (cond.maxDeviceIndex < 0) {
        // 全部排除降级（改动 1）
        var emptyNote = document.createElement('div');
        emptyNote.className = 'jv-empty-note';
        emptyNote.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'All devices of this condition are excluded; no best device' : '该条件的器件已全部排除，无最高器件';
        rightCol.appendChild(emptyNote);
      } else {
        var jvBox = document.createElement('div');
        jvBox.className = 'chart-box jv';
        rightCol.appendChild(jvBox);
        var areaNote = document.createElement('div');
        areaNote.className = 'jv-area-note';
        var curDev = cond.devices[curIdx];
        var enArea = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
        areaNote.textContent = (enArea ? 'Fwd Area (cm^2): ' : '正扫 Area (cm^2): ') +
          (curDev && curDev.fwd && P.isNum(curDev.fwd.area) ? curDev.fwd.area : '—') +
          (enArea ? ' ｜ Rev Area (cm^2): ' : ' ｜ 反扫 Area (cm^2): ') +
          (curDev && curDev.rev && P.isNum(curDev.rev.area) ? curDev.rev.area : '—');
        rightCol.appendChild(areaNote);
      }
      body.appendChild(rightCol);
      card.appendChild(body);

      // 原始数据折叠（details 懒渲染，第五批；P5-6：展开后按序号选择器件，默认当前 JV 器件）
      var details = document.createElement('details');
      details.className = 'raw-details';
      var summary = document.createElement('summary');
      summary.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('Device #' + (curIdx + 1) + ' raw data (click to expand; switch by index)') : ('器件 #' + (curIdx + 1) + ' 原始数据（点击展开，可按序号切换）');
      details.appendChild(summary);
      function renderRawFor(idx) {
        // 清掉旧内容（选择器保留）
        var olds = details.querySelectorAll('.raw-content');
        Array.prototype.forEach.call(olds, function (el) { el.parentNode.removeChild(el); });
        // 序号选择器（首次构建）
        var selWrap = details.querySelector('.raw-selector');
        if (!selWrap) {
          selWrap = document.createElement('div');
          selWrap.className = 'raw-selector';
          var selLabel = document.createElement('span');
          selLabel.className = 'raw-selector-label';
          selLabel.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Device' : '器件';
          selWrap.appendChild(selLabel);
          cond.devices.forEach(function (dd, di) {
            if (dd.excluded) return;
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'raw-sel-btn' + (di === idx ? ' active' : '');
            b.textContent = String(di + 1);
            b.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('View raw data of device #' + (di + 1)) : ('查看器件 #' + (di + 1) + ' 的原始数据');
            b.addEventListener('click', function () {
              renderRawFor(di);
            });
            selWrap.appendChild(b);
          });
          details.insertBefore(selWrap, summary.nextSibling);
        } else {
          var btns = selWrap.querySelectorAll('.raw-sel-btn');
          Array.prototype.forEach.call(btns, function (b) { b.classList.toggle('active', parseInt(b.textContent, 10) === idx + 1); });
        }
        // 该器件原始数据
        var raw = T.renderRawDataTable(cond, C.condEff(cond, 'fwd'), C.condEff(cond, 'rev'), { devIndex: idx });
        var btnCopyRaw = makeBtn((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? '⧉ Copy Table (raw)' : '⧉ 复制表格（原始数据）');
        btnCopyRaw.className += ' raw-content';
        btnCopyRaw.addEventListener('click', function () { T.copyTableAsTSV(raw.fwdTable); T.copyTableAsTSV(raw.revTable); });
        details.insertBefore(btnCopyRaw, summary.nextSibling);
        raw.wrap.className += ' raw-content';
        details.appendChild(raw.wrap);
      }
      details.addEventListener('toggle', function () {
        if (!details.open) return;
        // 折叠默认跟随 JV 图当前器件（state.detailSel）；无则最高
        var dIdx = state.detailSel && state.detailSel[condNm] != null ? state.detailSel[condNm] : cond.maxDeviceIndex;
        renderRawFor(dIdx);
      });
      card.appendChild(details);

      wrap.appendChild(card);

      // JV 图初始化（P5：devIndex 指定选中器件；lightbox kind='jv'）
      if (cond.maxDeviceIndex >= 0) {
        initDetailJV(card, jvBox, cond, i, condNm, curIdx, areaNote, summary, details, function () { return rawRendered; }, function (v) { rawRendered = v; });
        // 初始行高亮（当前选中器件）
        markActiveRow(table, condNm, curIdx, softColor(i));
      }
    });
  }

  /** P5：详情 JV 图初始化（选中器件 devIndex 渲染；行切换时重建） */
  function initDetailJV(card, jvBox, cond, ci, condNm, devIdx, areaNote, summary, details, getRaw, setRaw) {
    var base = fileNameBase() + '_' + condNm + '_JV';
    var jvOpts = { chartColor: chartColor, condIndex: ci, axisTitlePos: state.axisTitlePos, jvFocus: true, devIndex: devIdx };
    initChartIn(card, jvBox, function (dom, ex) { return C.renderJVChart(dom, cond, Object.assign({}, jvOpts, ex || {})); }, base, {
      exportSize: exportSizeOf('jv', 800),
      lightbox: {
        title: (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? (condNm + ' · Device #' + (devIdx + 1) + ' · JV curve') : (condNm + ' · 器件 #' + (devIdx + 1) + ' · JV 曲线'),
        kind: 'jv',
        render: function (dom, ex) { return C.renderJVChart(dom, cond, Object.assign({}, jvOpts, ex || {})); }
      }
    });
  }

  /** P5：详情表行点击 → 切换该条件 JV 图 + 行高亮 + Area/折叠同步 */
  function onSelectDetailDev(cond, ci, condNm, devIdx) {
    var d = cond.devices[devIdx];
    if (!d || d.excluded) return;
    if (!state.detailSel) state.detailSel = {};
    state.detailSel[condNm] = devIdx;
    // 该条件的卡：更新 JV 图（重建）、Area 注记、折叠标题、行高亮
    var card = $('detail-card-' + ci);
    if (!card) return;
    var jvBox = card.querySelector('.chart-box.jv');
    var areaNote = card.querySelector('.jv-area-note');
    var summary = card.querySelector('.raw-details summary');
    var details = card.querySelector('.raw-details');
    var table = card.querySelector('.dense-table');
    if (jvBox) {
      // 释放旧实例 → 清空 → 重建（initChartIn 内部 requestAnimationFrame）
      disposeChartIn(jvBox);
      jvBox.innerHTML = '';
      initDetailJV(card, jvBox, cond, ci, condNm, devIdx, areaNote, summary, details, null, null);
    }
    if (areaNote) {
      var enArea2 = (typeof I18N !== 'undefined' && I18N.getLang() === 'en');
      areaNote.textContent = (enArea2 ? 'Fwd Area (cm^2): ' : '正扫 Area (cm^2): ') +
        (d.fwd && P.isNum(d.fwd.area) ? d.fwd.area : '—') +
        (enArea2 ? ' ｜ Rev Area (cm^2): ' : ' ｜ 反扫 Area (cm^2): ') +
        (d.rev && P.isNum(d.rev.area) ? d.rev.area : '—');
    }
    if (summary) summary.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('Device #' + (devIdx + 1) + ' raw data (click to expand; switch by index)') : ('器件 #' + (devIdx + 1) + ' 原始数据（点击展开，可按序号切换）');
    if (details) details.open = false; // 折叠收起，下次展开跟随新选中器件（懒渲染）
    if (table) markActiveRow(table, condNm, devIdx, softColor(ci));
  }

  /** P5：表格行高亮（当前 JV 显示中的器件）+ 清掉其他行 */
  function markActiveRow(table, condNm, devIdx, themeColor) {
    if (!table) return;
    var rows = table.querySelectorAll('tr[data-dev-idx]');
    Array.prototype.forEach.call(rows, function (tr) {
      if (tr.getAttribute('data-dev-idx') === String(devIdx)) {
        tr.className = 'row-active';
        tr.style.background = T.shade(themeColor, -0.06);
      } else if (tr.className === 'row-active') {
        tr.className = ''; // 恢复（row-max 等由 tables 处理，这里只清 row-active）
        tr.style.background = '';
      }
    });
  }

  /** P5：释放指定容器内的 ECharts 实例（state.chartInstances 中匹配 dom） */
  function disposeChartIn(box) {
    var list = state.chartInstances || [];
    for (var i = list.length - 1; i >= 0; i--) {
      try {
        if (list[i].getDom && list[i].getDom() === box) { list[i].dispose(); list.splice(i, 1); }
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 带 data-chart-action 标记的复制/下载按钮（initChartIn 按属性查找，兼容任意按钮顺序） */
  function makeChartBtns() {
    var isEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：图表卡按钮
    var styleBtn = makeBtn(isEn ? '🎨 Style' : '⚙ 调整格式'); // 第二十四批：排最前
    styleBtn.dataset.chartAction = 'style';
    var copyBtn = makeBtn(isEn ? '⧉ Copy Image' : '⧉ 复制图片');
    copyBtn.dataset.chartAction = 'copy';
    var svgBtn = makeBtn(isEn ? '⤓ Download SVG' : '⤓ 下载矢量图'); // t4-8：文案统一「下载矢量图」
    svgBtn.dataset.chartAction = 'svg';
    return [styleBtn, copyBtn, svgBtn];
  }

  /* ================================================================
   * 5.8 联动编辑：详情表 Efficiency 修改 → 参与最高判定 → 全部刷新
   * ================================================================ */
  function onEditEff(cond, devIdx, value) {
    var dev = cond.devices[devIdx];
    if (!dev) return;
    // value 为 null 表示恢复原始值（双击）
    dev.userEff = value === null ? null : value;
    recomputeMax(cond);
    renderAll();
  }

  /** 重算最高器件：未舍入原值比较；用户手改的显示值优先参与（5.8）；跳过已排除器件（改动 1） */
  function recomputeMax(cond) {
    var maxIdx = -1, maxEff = -Infinity;
    cond.devices.forEach(function (d, i) {
      if (d.excluded) return; // 排除器件不参与
      var eff = T.effOf(d);
      if (P.isNum(eff) && eff > maxEff) { maxEff = eff; maxIdx = i; }
    });
    cond.maxDeviceIndex = maxIdx;
    cond.maxEff = maxEff;
  }

  /* ================================================================
   * 改动 1：排除/恢复器件（非破坏性标记，灰显 + 不参与统计绘图）
   * ================================================================ */
  function onToggleExclude(cond, devIdx) {
    var dev = cond.devices[devIdx];
    if (!dev) return;
    dev.excluded = !dev.excluded;
    recomputeMax(cond);
    renderAll();
  }

  /* ---------- S4 已移除（第五批：JV 图与原始数据并入 S3 详情卡） ---------- */

  /* ---------- 箱线图（8.3 单图 / 8.4 合并图） ---------- */
  var PARAM_TITLES = {
    pce: { zh: 'PCE 箱线图', en: 'PCE boxplot' },
    voc: { zh: 'Voc 箱线图', en: 'Voc boxplot' },
    jsc: { zh: 'Jsc 箱线图', en: 'Jsc boxplot' },
    ff: { zh: 'FF 箱线图', en: 'FF boxplot' }
  };
  /** i18n：单图卡标题按当前语言取（zh 态中文 / EN 态英文） */
  function paramTitle(key) {
    var et = PARAM_TITLES[key];
    if (!et) return key;
    return (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? (et.en || et.zh) : (et.zh || et.en);
  }
  var Y_TITLE_SHORT = { pce: 'PCE (%)', voc: 'Voc (V)', jsc: 'Jsc (mA/cm²)', ff: 'FF (%)' };

  function renderBoxplotCards(checked) {
    var wrap = $('boxplot-cards');
    wrap.innerHTML = '';
    if (!checked.length) return;

    if (state.view === 'jv') { renderJVOverlayCard(wrap, checked); return; } // P5：JV 叠加视图

    var useCombined = state.view === 'combined';
    var chartOpts = {
      whisker: 'iqr', // 须线固定 1.5×IQR（同 Origin）
      meanMark: state.options.meanMark,
      rawPoints: state.options.rawPoints,
      axisTitlePos: state.axisTitlePos,
      chartColor: chartColor
    };

    if (useCombined) {
      var combExport = exportSizeOf('combined', 1400); // 第十七批：与 DESIGN 同比例 + scale
      var combTitle = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Combined boxplots (PCE · Voc · Jsc · FF · 2×2)' : '合并箱线图（PCE · Voc · Jsc · FF · 2×2）'; // i18n：卡片标题
      var card = buildChartCard(combTitle, 'combined', function (dom, ex) {
        return C.renderCombinedBoxplot(dom, checked, Object.assign({}, chartOpts, ex || {}));
      }, {
        exportSize: combExport,
        lightbox: {
          title: combTitle,
          kind: 'combined',
          render: function (dom, ex) { return C.renderCombinedBoxplot(dom, checked, Object.assign({}, chartOpts, ex || {})); }
        }
      });
      card.classList.add('combined-card'); // 第八批：独占整行
      card.querySelector('.chart-box').classList.add('combined');
      wrap.appendChild(card);
    } else {
      ['pce', 'voc', 'jsc', 'ff'].forEach(function (key) {
        wrap.appendChild(buildChartCard(paramTitle(key), key, (function (k) {
          return function (dom, ex) { return C.renderBoxplot(dom, k, checked, Object.assign({}, chartOpts, ex || {})); };
        })(key), {
          exportSize: exportSizeOf('single', 1080), // 第十七批：与 DESIGN 同比例 + scale
          lightbox: {
            title: paramTitle(key),
            kind: 'single',
            render: function (dom, ex) { return C.renderBoxplot(dom, key, checked, Object.assign({}, chartOpts, ex || {})); }
          }
        }));
      });
    }
  }

  /** P5：多条件 JV 叠加卡（三态方向 + 条件二次筛选；复用 buildChartCard 的复制/下载/灯箱/格式能力） */
  var OVERLAY_DIR = { rev: '反扫', fwd: '正扫', both: '双方向' };
  function renderJVOverlayCard(wrap, checked) {
    var sel = state.jvOverlay.selNames;
    var filtered = sel && sel.length
      ? checked.filter(function (c) { return sel.indexOf(c.displayName || c.name) >= 0; })
      : checked.slice();
    if (!filtered.length) filtered = checked.slice(); // 至少保留全部
    var dir = state.jvOverlay.direction || 'rev';
    var ovEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：JV 叠加卡标题
    var dirLabel = ovEn ? (({ rev: 'Reverse', fwd: 'Forward', both: 'Both' })[dir] || 'Reverse') : (OVERLAY_DIR[dir] || '反扫');
    var overlayOpts = { direction: dir, chartColor: chartColor, axisTitlePos: state.axisTitlePos };
    var card = buildChartCard((ovEn ? 'Multi-condition JV overlay · ' : '多条件 JV 叠加 · ') + dirLabel, 'jv-overlay', function (dom, ex) {
      return C.renderJVOverlay(dom, filtered, Object.assign({}, overlayOpts, ex || {}));
    }, {
      exportSize: { width: 1400, height: 700, scale: 2 }, // P5-5：与合并箱线同等级；scale=2 与灯箱/预览一致（字号 22px）
      lightbox: {
        title: (ovEn ? ('Multi-condition JV overlay (' + dirLabel + ')') : ('多条件 JV 叠加（' + dirLabel + '）')),
        kind: 'jvOverlay', // P5-4：独立格式命名空间
        render: function (dom, ex) { return C.renderJVOverlay(dom, filtered, Object.assign({}, overlayOpts, ex || {})); }
      }
    });
    card.classList.add('jv-overlay-card'); // P5-5：独占整行 + 大图
    var box = card.querySelector('.chart-box');
    if (box) box.classList.add('jv-overlay');
    // 控制条：方向三键 + 条件二次筛选胶囊
    var bar = document.createElement('div');
    bar.className = 'jv-overlay-bar';
    var dirGroup = document.createElement('div');
    dirGroup.className = 'jv-overlay-dirs';
    ['rev', 'fwd', 'both'].forEach(function (k) {
      var b = makeBtn(k === 'rev' ? 'Reverse' : (k === 'fwd' ? 'Forward' : 'Both')); // i-1：方向三键统一英文（zh 态亦英文，与图例 Forward/Reverse 术语一致，适用 AGENTS.md 方向词规则；OVERLAY_DIR 保留供 L1198 标题 zh 分支）
      b.className = 'btn btn-sm' + (k === dir ? ' active' : '');
      b.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? (k === 'rev' ? 'Reverse scan (efficiency basis, default)' : (k === 'fwd' ? 'Forward scan' : 'Forward + reverse overlaid (same hue, forward dashed)'))
        : (k === 'rev' ? '反扫（效率口径，默认）' : (k === 'fwd' ? '正扫' : '正扫+反扫同图（同色深浅，正扫虚线）'));
      b.addEventListener('click', function () {
        state.jvOverlay.direction = k;
        renderSummaryAndCharts(); // 仅重渲染图表区
      });
      dirGroup.appendChild(b);
    });
    bar.appendChild(dirGroup);
    var condGroup = document.createElement('div');
    condGroup.className = 'jv-overlay-conds';
    checked.forEach(function (c) {
      var nm = c.displayName || c.name;
      var on = sel ? sel.indexOf(nm) >= 0 : true;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'jv-overlay-chip' + (on ? ' on' : '');
      chip.textContent = nm;
      chip.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Show / hide this condition in the overlay' : '叠加图中显示/隐藏该条件';
      chip.addEventListener('click', function () {
        var s = state.jvOverlay.selNames ? state.jvOverlay.selNames.slice() : checked.map(function (x) { return x.displayName || x.name; });
        var k = s.indexOf(nm);
        if (k >= 0) s.splice(k, 1); else s.push(nm);
        if (!s.length) s = checked.map(function (x) { return x.displayName || x.name; }); // 至少一个
        state.jvOverlay.selNames = s;
        renderSummaryAndCharts();
      });
      condGroup.appendChild(chip);
    });
    bar.appendChild(condGroup);
    var box = card.querySelector('.chart-box');
    card.insertBefore(bar, box);
    wrap.appendChild(card);
  }

  /** 构建图表卡片：标题 + 「点击放大」提示 + 复制/下载按钮 + 图表容器（改动 4） */
  function buildChartCard(title, id, renderFn, extra) {
    extra = extra || {};
    var card = document.createElement('div');
    card.className = 'chart-card';
    var head = document.createElement('div');
    head.className = 'chart-card-head';
    var t = document.createElement('span');
    t.className = 'chart-card-title';
    t.textContent = title;
    head.appendChild(t);
    var hint = document.createElement('span');
    hint.className = 'chart-zoom-hint';
    hint.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Click to zoom' : '点击放大'; // i18n：动态提示
    head.appendChild(hint);
    var actions = document.createElement('div');
    actions.className = 'chart-card-actions';
    var cbtns = makeChartBtns();
    actions.appendChild(cbtns[0]); // ⚙ 调整格式
    actions.appendChild(cbtns[1]);
    actions.appendChild(cbtns[2]);
    head.appendChild(actions);
    card.appendChild(head);
    var box = document.createElement('div');
    box.className = 'chart-box';
    card.appendChild(box);
    initChartIn(card, box, renderFn, fileNameBase() + '_' + title, extra);
    return card;
  }

  function makeBtn(text) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = text;
    return btn;
  }



  /** 离屏渲染并取回 SVG 字符串（exportMode：内容盒 + 关动画 + 网页观感缩放；第十四批真根修：
   *  opacity:0 可见区透明容器——getClientRects 始终非空，SVG 渲染器同步取数据完整） */
  function renderOffscreenSVG(renderFn, size) {
    return new Promise(function (resolve) {
      var div = document.createElement('div');
      div.style.cssText = 'position:fixed;right:0;bottom:0;width:' + size.width + 'px;height:' + size.height + 'px;' +
        'opacity:0;pointer-events:none;z-index:-1;';
      document.body.appendChild(div);
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        var svg = '';
        try { svg = C.sanitizeSVG(chart.renderToSVGString()); } catch (e) {}
        try { chart.dispose(); } catch (e) {}
        if (div.parentNode) div.parentNode.removeChild(div);
        resolve(svg || null);
      };
      // exportMode 已关动画；finished 事件确保渲染完成后再取 SVG（防动画首帧=无数据），setTimeout 兜底
      var chart = null;
 // 问题4：PDF 窄渲染（360/310px 宽）下长条件名 X 标签粘连——导出场景强制 45° 旋转增大标签间隔
      var ex = { exportMode: true, scale: size.scale || 1, exportW: size.width, exportH: size.height };
      if (size.pdfLabelRotate) ex.pdfLabelRotate = size.pdfLabelRotate;
      if (size.pdfLabelTruncate) ex.pdfLabelTruncate = size.pdfLabelTruncate; // 问题4：PDF 截断覆盖
      try { chart = renderFn(div, ex); } catch (e) { done = true; if (div.parentNode) div.parentNode.removeChild(div); resolve(null); return; }
      if (chart.on && typeof chart.on === 'function') chart.on('finished', finish);
      setTimeout(finish, 60);
    });
  }

  /** SVG → PNG dataURL（复制图片等位图场景） */
  function chartToDataURL(renderFn, size) {
    return renderOffscreenSVG(renderFn, size).then(function (svg) {
      if (!svg) return null;
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = size.width; canvas.height = size.height;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size.width, size.height);
          ctx.drawImage(img, 0, 0, size.width, size.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = function () { resolve(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    });
  }

  /** SVG 矢量 data URL（第二十批：PDF/打印用——打印到 A4 时位图会放大变糊，矢量无限清晰） */
  function chartToSVGURL(renderFn, size) {
    return renderOffscreenSVG(renderFn, size).then(function (svg) {
      return svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : null;
    });
  }

  /** 第十四批：构建打印区域（标题 + 备注 + 汇总表 + 合并图容器 + 各条件详情表[跳过已排除行] + JV 图占位）。
   *  version: 'archive'（留档黑白）| 'report'（汇报彩色）；返回 { cBox, jvRenders } */
  function buildPrintArea(title, note, checked, includeEquiv) {
    var pa = $('print-area');
    pa.className = 'print-area pdf-report'; // 卡片杂志风
    pa.innerHTML = '';
    var now = new Date();
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    var dateStr = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var fileName = fileNameBase();
    var totalDev = 0;
    checked.forEach(function (c) { totalDev += c.devices.filter(function (d) { return !d.excluded; }).length; });
    // 最佳 PCE = 各条件最高器件效率的最大值
    var bestPce = null;
    checked.forEach(function (c) {
      if (c.maxDeviceIndex >= 0) {
        var e = T.effOf(c.devices[c.maxDeviceIndex]);
        if (e !== null && e !== undefined && (bestPce === null || e > bestPce)) bestPce = e;
      }
    });

    // 页眉（第二十一批：普通流，每个 section 顶部；fixed 会遮挡拆页内容）
    function makeHeader() {
      var header = document.createElement('div');
      header.className = 'pdf-header';
      var hL = document.createElement('span'); hL.className = 'pdf-header-l'; hL.textContent = title;
      // 第二十七批：页眉右侧不再显示导入文件名（fileName 变量保留，别处仍用）
      header.appendChild(hL);
      return header;
    }

    // ===== 第 1 页：封面（第二十七批：标题→蓝线→备注→meta→合并箱线图 2×2→标签云，无统计卡）=====
    var cover = document.createElement('section');
    cover.className = 'pdf-page cover';
    var cTitle = document.createElement('h1');
    cTitle.className = 'cover-title';
    cTitle.textContent = title || ((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'JV Data Analysis Report' : 'JV 数据分析报告');
    cover.appendChild(cTitle);
    var cRule = document.createElement('div');
    cRule.className = 'cover-rule';
    cover.appendChild(cRule);
    // 第二十七批：备注紧跟标题下方（原在标签云后）
    if (note && note.trim()) {
      var cNote = document.createElement('p');
      cNote.className = 'cover-note';
      cNote.textContent = note;
      cover.appendChild(cNote);
    }
    // 第二十六批：meta 行（条件数 · 器件数 · 最佳 PCE），替代原文件名/日期 sub
    var cMeta = document.createElement('p');
    cMeta.className = 'cover-meta';
    var metaEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：PDF 封面 meta
    cMeta.textContent = metaEn
      ? ('Conditions ×' + checked.length + ' · Devices ×' + totalDev + ' · Best PCE ' + (bestPce !== null ? P.roundSigText(bestPce) + '%' : '—'))
      : ('条件数 ×' + checked.length + ' · 器件数 ×' + totalDev + ' · 最佳 PCE ' + (bestPce !== null ? P.roundSigText(bestPce) + '%' : '—'));
    cover.appendChild(cMeta);
    // 第二十六批：封面中部合并箱线图 2×2（主视觉，与汇总页同构）
    var coverBoxGrid = document.createElement('div');
    coverBoxGrid.className = 'cover-boxgrid';
    var coverBoxCells = [], coverBoxRenders = [];
    ['pce', 'voc', 'jsc', 'ff'].forEach(function (k) {
      var cell = document.createElement('div');
      cell.className = 'cover-boxcell';
      coverBoxGrid.appendChild(cell);
      coverBoxCells.push(cell);
      coverBoxRenders.push((function (key) {
        return function (dom, ex) {
          return C.renderBoxplot(dom, key, checked, Object.assign({
            chartColor: chartColor, meanMark: state.options.meanMark, rawPoints: state.options.rawPoints, axisTitlePos: state.axisTitlePos
          }, ex || {}));
        };
      })(k));
    });
    cover.appendChild(coverBoxGrid);
    // 条件标签云（条件色 12% 透明底 + 实色字）
    var tags = document.createElement('div');
    tags.className = 'cover-tags';
    checked.forEach(function (c, i) {
      var t = document.createElement('span');
      t.className = 'cover-tag';
      t.textContent = c.displayName || c.name;
      t.style.color = chartColor(i);
      t.style.backgroundColor = hexToRgba(chartColor(i), 0.12);
      tags.appendChild(t);
    });
    cover.appendChild(tags);
    // 第二十七批：统计卡整段删除（meta 行已含条件数/器件数/最佳 PCE）
    pa.appendChild(cover);

    // ===== 第 2 页：汇总跨页（上表下图——A4 版心放不下「左表右 2×2 可读图」，2×2 每格需 ≥290px 字号才可读） =====
    var sumPage = document.createElement('section');
    sumPage.className = 'pdf-page summary-page';
    sumPage.appendChild(makeHeader());
    var sHead = document.createElement('h2');
    sHead.className = 'pdf-h2';
    sHead.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Summary Overview' : '汇总 Overview';
    sumPage.appendChild(sHead);
    var sumTable = document.querySelector('#summary-table-wrap .data-table');
    if (sumTable) {
      var sumClone = sumTable.cloneNode(true);
      sumClone.classList.add('summary-table');
      sumClone.querySelectorAll('tr.row-excluded').forEach(function (tr) { if (tr.parentNode) tr.parentNode.removeChild(tr); });
      sumPage.appendChild(sumClone);
    }
    var boxGrid = document.createElement('div');
    boxGrid.className = 'boxgrid';
    var boxRenders = [];
    var boxCells = [];
    ['pce', 'voc', 'jsc', 'ff'].forEach(function (k) {
      var cell = document.createElement('div');
      cell.className = 'boxgrid-cell';
      boxGrid.appendChild(cell);
      boxCells.push(cell);
      boxRenders.push((function (key) {
        return function (dom, ex) {
          return C.renderBoxplot(dom, key, checked, Object.assign({
            chartColor: chartColor, meanMark: state.options.meanMark, rawPoints: state.options.rawPoints, axisTitlePos: state.axisTitlePos
          }, ex || {}));
        };
      })(k));
    });
    sumPage.appendChild(boxGrid);
    pa.appendChild(sumPage);

    // ===== P5-8：多条件 JV 叠加页（箱线图之后；方向按用户当前页面选择 state.jvOverlay.direction） =====
    var overlayRender = null;
    var overlayDir = (state.jvOverlay && state.jvOverlay.direction) || 'rev';
    if (checked.length > 1) {
      var jvPage = document.createElement('section');
      jvPage.className = 'pdf-page jv-page';
      jvPage.appendChild(makeHeader());
      var jvH2 = document.createElement('h2');
      jvH2.className = 'pdf-h2';
      var dirNm = ({ rev: '反扫', fwd: '正扫', both: '双方向' })[overlayDir];
      if (typeof I18N !== 'undefined' && I18N.getLang() === 'en') dirNm = ({ rev: 'Reverse', fwd: 'Forward', both: 'Both' })[overlayDir];
      jvH2.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? ('JV overlay (' + dirNm + ')')
        : ('多条件 JV 叠加（' + dirNm + '）');
      jvPage.appendChild(jvH2);
      var jvOvBox = document.createElement('div');
      jvOvBox.className = 'pdf-jv-overlay';
      jvPage.appendChild(jvOvBox);
      pa.appendChild(jvPage);
      overlayRender = function (dom, ex) {
        return C.renderJVOverlay(dom, checked, Object.assign({ direction: overlayDir, chartColor: chartColor, axisTitlePos: state.axisTitlePos }, ex || {}));
      };
      jvOvBox.__overlayDir = overlayDir;
    }

    // ===== （六项修复 4）等效电路分析页：汇总之后、详情页之前（勾选「包含等效电路分析数据」时） =====
    var equivCells = [], equivRenders = [];
    if (includeEquiv && global.JVEquiv && global.JVEquiv.pdfRenderers) {
      var eqPage = document.createElement('section');
      eqPage.className = 'pdf-page eq-page';
      eqPage.appendChild(makeHeader());
      var eqH2 = document.createElement('h2');
      eqH2.className = 'pdf-h2';
      eqH2.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Apparent parameter diagnostics' : '表观参数与迟滞诊断';
      eqPage.appendChild(eqH2);
      // t4-6：删除「（参考性解读；对勾选条件）」副标题（排版清爽）
      var eqTitles = {
        rs: { zh: 'Rs 分布', en: 'Rs distribution' },
        rsh: { zh: 'Rsh 分布（log）', en: 'Rsh distribution (log)' },
        n: { zh: '理想因子 n 分布', en: 'Ideality factor n distribution' },
        j0: { zh: 'log₁₀(J₀) 分布', en: 'log₁₀(J₀) distribution' }
      };
      var eqGrid = document.createElement('div');
      eqGrid.className = 'eq-pdf-grid';
      global.JVEquiv.pdfRenderers(checked).forEach(function (er) {
        var cell = document.createElement('div');
        cell.className = 'eq-pdf-cell';
        var cap = document.createElement('div');
        cap.className = 'eq-pdf-cap';
        var eqFallback = eqTitles[er.kind];
        cap.textContent = er.title || ((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? (eqFallback && eqFallback.en) : (eqFallback && eqFallback.zh)) || er.kind;
        cell.appendChild(cap);
        var box = document.createElement('div');
        box.className = 'eq-pdf-chart';
        cell.appendChild(box);
        eqGrid.appendChild(cell);
        equivCells.push(box);
        equivRenders.push(er.render);
      });
      eqPage.appendChild(eqGrid);
      var sumWrap = document.createElement('div');
      sumWrap.className = 'eq-pdf-summary';
      var tbl = global.JVEquiv.buildSummaryTable(checked);
      if (tbl) sumWrap.appendChild(tbl);
      eqPage.appendChild(sumWrap);
      pa.appendChild(eqPage);
    }

    // ===== 第 3 页起：每条件一页（第二十一批重构：条件名 → 表格 → JV → base 对比箱线图一行） =====
    var jvRenders = [];
    var cmpCells = [], cmpRenders = []; // base 对比箱线图（4 参数 × 每条件）
    // base = 首个条件（pref.first）；无显式时隐式取排序后第一个勾选条件（与页面一致，第十八批）
    var baseCond = checked[0];
    checked.forEach(function (c) { if (getPref(c).first) baseCond = c; });
    var baseName = baseCond.displayName || baseCond.name;
    var baseColor = chartColor(checked.indexOf(baseCond), baseName); // 第二十五批：条件色覆盖
    checked.forEach(function (cond, idx) {
      var page = document.createElement('section');
      page.className = 'pdf-page cond-page';
      page.appendChild(makeHeader());
      // banner：条件色实色 + 白字（第二十五批：条件色覆盖）
      var banner = document.createElement('div');
      banner.className = 'cond-banner';
      banner.style.backgroundColor = chartColor(idx, cond.displayName || cond.name);
      banner.textContent = cond.displayName || cond.name;
      page.appendChild(banner);
      // 表格（全宽，不再与 JV 并排 → 列头不被截断）
      var pt = T.renderDetailTable(cond, chartColor(idx, cond.displayName || cond.name), null, null, { reindex: true });
      page.appendChild(pt);
      // 统计条（第二十二批：紧跟表格，用户要求不放页面最底）
      var footbar = document.createElement('div');
      footbar.className = 'cond-footbar';
      var avg = T.condAverages(cond);
      var maxE = cond.maxDeviceIndex >= 0 ? T.effOf(cond.devices[cond.maxDeviceIndex]) : null;
      var parts = [];
      if (maxE !== null) parts.push('Max PCE ' + P.roundSigText(maxE) + '%');
      if (avg && avg.pce !== null && avg.pce !== undefined) parts.push('Avg PCE ' + P.roundSigText(avg.pce) + '%');
      if (avg && avg.hi !== null && avg.hi !== undefined) parts.push('HI ' + (avg.hi * 100).toFixed(1) + '%');
      footbar.textContent = parts.join(' · ');
      page.appendChild(footbar);
      // 第二十七批：base 对比箱线图放 JV 之前（任务数组顺序不变，仅 DOM 顺序）
      var cmpBlock = null;
      if (baseCond && baseCond !== cond) {
        cmpBlock = document.createElement('div');
        cmpBlock.className = 'cond-cmp-block'; // 与统计条一起换页（avoid 拆开）
        var cmpHead = document.createElement('div');
        cmpHead.className = 'cond-cmp-head';
        cmpHead.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? ('vs ' + baseName) : ('与 ' + baseName + ' 对比');
        cmpBlock.appendChild(cmpHead);
        var cmpGrid = document.createElement('div');
        cmpGrid.className = 'cond-cmp-grid';
        ['pce', 'voc', 'jsc', 'ff'].forEach(function (key) {
          var cell = document.createElement('div');
          cell.className = 'cond-cmp-cell';
          // 第二十三批：不再画格子上方 PCE/Voc/Jsc/FF 标题——每格 y 轴已有标题（PCE (%) 等），去掉省纵向空间
          var chartBox = document.createElement('div');
          chartBox.className = 'cond-cmp-chart';
          cell.appendChild(chartBox);
          // 第二十二批：不画 HTML 图例——图内 X 轴已有两个条件名（base 在前），避免重复
          cmpGrid.appendChild(cell);
          cmpCells.push(chartBox);
          cmpRenders.push((function (k, baseC, curC, ci) {
            return function (dom, ex) {
              return C.renderBoxplot(dom, k, [baseC, curC], Object.assign({
                chartColor: function (i) { return i === 0 ? baseColor : chartColor(ci); },
                meanMark: state.options.meanMark, rawPoints: state.options.rawPoints
              }, ex || {}));
            };
          })(key, baseCond, cond, idx));
        });
        cmpBlock.appendChild(cmpGrid);
        page.appendChild(cmpBlock);
      }
      // JV 图（第二十七批：放 base 对比之后；全宽矮胖 720×260）
      var jvBox = document.createElement('div');
      jvBox.className = 'cond-jv';
      page.appendChild(jvBox);
      pa.appendChild(page);
      // JV 渲染任务（720×400 矮胖，第二十一批）
      if (cond.maxDeviceIndex >= 0) {
        jvRenders.push({
          box: jvBox,
          render: (function (c, i) {
            return function (dom, ex) {
              return C.renderJVChart(dom, c, Object.assign({ chartColor: chartColor, condIndex: i, axisTitlePos: state.axisTitlePos }, ex || {}));
            };
          })(cond, idx)
        });
      } else {
        jvRenders.push({ box: jvBox, render: null });
      }
    });
    // 第三十五批：页码页脚（Page 当前页，居中）——pa 内每个 .pdf-page 底部注入
    var pdfPages = pa.querySelectorAll('.pdf-page');
    pdfPages.forEach(function (p, pi) {
      var pf = document.createElement('div');
      pf.className = 'pdf-footer';
      pf.textContent = 'Page ' + (pi + 1); // P-2：不再显示总页数——.pdf-page 为逻辑分区，浏览器按内容高度物理分页（120 器件详情页溢出：13 逻辑页 ≠ 17 物理页），承诺总数必然失准；分区序号仍可作报告引用锚点
      p.appendChild(pf);
    });
    return { boxCells: boxCells, boxRenders: boxRenders, jvRenders: jvRenders, cmpCells: cmpCells, cmpRenders: cmpRenders, coverBoxCells: coverBoxCells, coverBoxRenders: coverBoxRenders, equivCells: equivCells, equivRenders: equivRenders, overlayRender: overlayRender };
  }

  /** 条件色 → rgba（封面标签云 12% 透明底） */
  function hexToRgba(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(127,127,127,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 第十四批：导出 PDF（window.print 方案）。标题+备注+汇总表+合并图+详情表+JV 图全部转 PNG 后打印；
   *  临时改 document.title 让打印对话框默认文件名带标题；@page margin:0 去页眉页脚（打印 CSS） */
  function exportPdf(title, note) {
    try {
    var checked = checkedConditions(currentData());
    // 六项修复 4：是否把等效电路分析数据并入导出（汇总之后、详情之前）
    var includeEquiv = $('pdf-equiv') ? $('pdf-equiv').checked : false;
    var built;
    try {
      built = buildPrintArea(title, note, checked, includeEquiv);
    } catch (e2) {
      throw e2;
    }
    var pa = $('print-area');
    // 汇总页 4 单图（每格 310×198px，scale=310/467≈0.66 → 坐标轴字 ≈8.6px 打印可读；A4 版心放不下「左表右 2×2 大图」）
    // 第二十批：改用 SVG 矢量（PDF 打印不放大变糊；位图 310px 打到 A4 会被放大 3 倍以上）
    var tasks = built.boxRenders.map(function (r) {
      return chartToSVGURL(r, { width: 310, height: 198, scale: 310 / DESIGN.single.w, pdfLabelRotate: 45, pdfLabelTruncate: 13 }); // 问题4：PDF 窄渲染 X 标签 45°+截断 防粘连；t13：阈值 10→13（样例 Condition 1~5 最长 11 字符，10 阈值把 'Condition …' 截得互不可辨识，13 留余量且与 45° 防粘连兼容）
    });
    built.jvRenders.forEach(function (jr) {
      // 第二十八批：JV 渲染高度回 340（可读不压扁：plot 区 = 340-2×110 ≈ 120px）；img 限宽 56% 保证不跨页
      tasks.push(jr.render ? chartToSVGURL(jr.render, { width: 720, height: 340, scale: 720 / DESIGN.jv.w }) : Promise.resolve(null));
    });
    // base 对比箱线图（4 参数 × 每条件，2×2；第二十二批：带 Y 刻度，格子 ~83mm≈314px 渲染，刻度可读）
    built.cmpRenders.forEach(function (r) {
      tasks.push(chartToSVGURL(r, { width: 310, height: 160, scale: 310 / DESIGN.single.w, pdfLabelRotate: 45, pdfLabelTruncate: 13 })); // 问题4：PDF 窄渲染 X 标签 45°+截断 防粘连；t13：阈值 10→13 同封面（Condition 1~5 完整显示）
    });
    // 第二十六批：封面合并图（与汇总页同比例，稍大更清晰）
    built.coverBoxRenders.forEach(function (r) {
      tasks.push(chartToSVGURL(r, { width: 360, height: 231, scale: 360 / DESIGN.single.w, pdfLabelRotate: 45, pdfLabelTruncate: 13 })); // 问题4：封面 X 标签 45°+截断 防粘连；t13：阈值 10→13（样例 Condition 1~5 最长 11 字符，10 阈值截成 'Condition …' 互不可辨识）
    });
    // （六项修复 4）等效电路分析 4 图（2×2，与模态同一 equivStyle）
    built.equivRenders.forEach(function (r) {
      tasks.push(chartToSVGURL(r, { width: 310, height: 190, scale: 1 }));
    });
    // P5-8：多条件 JV 叠加（PDF 全宽，方向随页面选择）
    if (built.overlayRender) {
      tasks.push(chartToSVGURL(built.overlayRender, { width: 1240, height: 620, scale: 1240 / DESIGN.jvOverlay.w }));
    }
    Promise.all(tasks).then(function (results) {
      var pending = []; // 待加载的 img（第二十一批：打印前必须全部解码完成，否则部分图空白）
      built.boxCells.forEach(function (cell, i) {
        var data = results[i];
        if (data) {
          var img = document.createElement('img');
          img.className = 'print-box-img';
          img.src = data;
          cell.appendChild(img);
          pending.push(img);
        }
      });
      built.jvRenders.forEach(function (jr, i) {
        var data = results[built.boxCells.length + i];
        if (data) {
          var img = document.createElement('img');
          img.className = 'print-jv-img';
          img.src = data;
          jr.box.appendChild(img);
          pending.push(img);
        }
      });
      // 第二十一批：对比迷你图
      built.cmpCells.forEach(function (cell, i) {
        var data = results[built.boxCells.length + built.jvRenders.length + i];
        if (data) {
          var img = document.createElement('img');
          img.className = 'print-cmp-img';
          img.src = data;
          cell.appendChild(img);
          pending.push(img);
        }
      });
      // 第二十六批：封面合并图（results 顺序：boxRenders + jvRenders + cmpRenders + coverBoxRenders）
      built.coverBoxCells.forEach(function (cell, i) {
        var data = results[built.boxCells.length + built.jvRenders.length + built.cmpCells.length + i];
        if (data) {
          var img = document.createElement('img');
          img.className = 'print-box-img';
          img.src = data;
          cell.appendChild(img);
          pending.push(img);
        }
      });
      // （六项修复 4）等效电路分析 4 图（results 末尾：box+jv+cmp+cover+equiv+overlay）
      var eqBase = built.boxCells.length + built.jvRenders.length + built.cmpCells.length + built.coverBoxCells.length;
      built.equivCells.forEach(function (cell, i) {
        var data = results[eqBase + i];
        if (data) {
          var img = document.createElement('img');
          img.className = 'print-box-img';
          img.src = data;
          cell.appendChild(img);
          pending.push(img);
        }
      });
      // P5-8：多条件 JV 叠加（results 最后一个）
      if (built.overlayRender) {
        var ovData = results[eqBase + built.equivCells.length];
        if (ovData) {
          var ovImg = document.createElement('img');
          ovImg.className = 'print-jv-img';
          ovImg.src = ovData;
          var ovBox = document.querySelector('.pdf-page.jv-page .pdf-jv-overlay');
          if (ovBox) { ovBox.appendChild(ovImg); pending.push(ovImg); }
        }
      }
      var oldTitle = document.title;
      document.title = title; // 打印对话框默认文件名带标题
      var cleanup = function () {
        document.title = oldTitle;
        window.removeEventListener('afterprint', cleanup);
        if (pa) pa.innerHTML = '';
      };
      window.addEventListener('afterprint', cleanup);
      // 等全部 img 解码完成再打印（img.decode 优先，onload 兜底）
      Promise.all(pending.map(function (im) {
        return new Promise(function (res) {
          if (im.complete && im.naturalWidth) { res(); return; }
          im.onload = res;
          im.onerror = res;
          if (typeof im.decode === 'function') { im.decode().then(res, res); }
        });
      })).then(function () {
        setTimeout(function () { window.print(); }, 60); // 再等一帧布局
      });
    });
    } catch (e) { console.error('PDF_ERR:', e && e.stack ? e.stack : e); }
  }

  /** 第二十八批：导出 HTML（自包含单文件，双击即看）
   *  收集当前数据+格式+状态，注入当前文档下载；下次打开检测到 window.__SAVED__ 直接渲染。
   *  dev 多文件版点导出无效（file:// 同目录 fetch 被 CORS 拦，outerHTML 含 src 引用无法自包含）→ 提示用打包版。 */
  function exportHtml() {
    try {
      // 0. dev 版检测：存在 <script src> 或 <link href> 说明未打包，导出产物打不开
      if (document.querySelector('script[src]') || document.querySelector('link[href]')) {
        T.showToast('当前为开发版页面，导出的 HTML 可能无法离线打开——请使用发布版单文件后再导出');
        return;
      }
      // 1. 收集状态
      var saved = {
        version: 1,
        files: state.files,          // 已解析数据（conditions/devices 纯数据，可 JSON 序列化）
        prefs: state.prefs,          // 勾选/改名/Base/__order
        chartStyle: C.chartStyle,    // 图像格式调整器结果
        options: state.options,      // 均值标记/原始点
        axisTitlePos: state.axisTitlePos,
        view: state.view,
        jvOverlay: state.jvOverlay,  // P5：JV 叠加方向 + 二次筛选
        detailSel: state.detailSel,  // P5：详情 JV 选中器件
        lang: (typeof I18N !== 'undefined') ? I18N.getLang() : 'zh' // i-5：携带导出时语言（旧产物无此字段 → 回读 undefined 跳过，向后兼容）
      };
      var payload = JSON.stringify(saved);
      // 2. 读当前文档（打包版已内联 CSS/JS）→ 自包含 HTML
      var html = document.documentElement.outerHTML;
      // 3. 注入 __SAVED__ 到 <head>（在第一个 <script> 之前，确保 init 前已就绪）
      var tag = '<script>window.__SAVED__=' + payload + ';<\/script>';
      if (html.indexOf('<head>') >= 0) {
        html = html.replace('<head>', '<head>' + tag);
      } else {
        html = tag + html;
      }
      // 4. 下载
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (fileNameBase() || 'JV分析') + '_已保存.html';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      console.error('EXPORT_HTML_ERR:', e && e.stack ? e.stack : e);
      T.showToast('导出 HTML 失败：' + e.message);
    }
  }

  /** 图表初始化（等容器有尺寸）+ 复制/下载按钮绑定 + resize 监听 + 点击放大（改动 4） */
  function initChartIn(card, box, renderFn, base, extra) {
    extra = extra || {};
    requestAnimationFrame(function () {
      var chart;
      try {
        chart = renderFn(box);
      } catch (e) {
        T.showToast('图表渲染失败：' + e.message);
        return;
      }
      state.chartInstances.push(chart);
      var styleBtn = card.querySelector('[data-chart-action="style"]'); // 第二十四批
      var copyBtn = card.querySelector('[data-chart-action="copy"]');
      var svgBtn = card.querySelector('[data-chart-action="svg"]');
      // 第二十四批：⚙ 调整格式 → 打开样式编辑器（renderFn 由 makePreviewRender 自建）
      if (styleBtn) styleBtn.addEventListener('click', function () {
        var kind = extra.lightbox ? extra.lightbox.kind : 'single';
        openStyleEditor(kind);
      });
      // 第十五批：统一走离屏导出（exportChartOffscreen：opacity:0 容器 + 导出尺寸 + exportMode，与 PDF 同路径）
      if (copyBtn) copyBtn.addEventListener('click', function () { C.exportChartOffscreen(renderFn, extra.exportSize, base); });
      if (svgBtn) svgBtn.addEventListener('click', function () { C.exportChartOffscreen(renderFn, extra.exportSize, base, true); });
      if (window.ResizeObserver) {
        new ResizeObserver(function () { chart.resize(); }).observe(box);
      }
      // 点击图表 → 放大浮层（不影响卡片上的导出按钮）
      if (extra.lightbox) {
        box.addEventListener('click', function () {
          openLightbox(extra.lightbox.title, extra.lightbox.kind, extra.lightbox.render);
        });
      }
    });
  }

  function fileNameBase() {
    var f = state.files[state.currentIndex];
    var name = f ? f.name.replace(/\.[^.]+$/, '') : 'chart';
    return name;
  }

  /** 释放全部图表实例（renderAll 重渲染前调用） */
  function disposeCharts() {
    state.chartInstances.forEach(function (c) {
      try { c.dispose(); } catch (e) {}
    });
    state.chartInstances = [];
  }

  /* ================================================================
   * 图表点击放大（Lightbox，改动 4/5）：新建临时实例渲染 + 滚轮缩放 + 拖拽平移
   * ================================================================ */
  var lightboxChart = null;   // 放大态临时实例
  var lightboxRender = null;  // 放大态渲染闭包（导出离屏用）
  var lightboxBase = '';
  var lightboxKind = 'single';
  var lightboxZoom = 1, lightboxTx = 0, lightboxTy = 0, lightboxOx = 50, lightboxOy = 50;

  /** Lightbox 尺寸：先按宽（min(94vw,1400px)）算，超高则限高 78vh 回推宽（第八批，两份逻辑合一份） */
  function lightboxSize(kind) {
    var ratio = kind === 'combined' ? 32 / 45 : (kind === 'jv' ? 2 / 3 : (kind === 'jvOverlay' ? 1 / 2 : 3 / 4)); // P5-收尾：叠加图 2:1
    var w = Math.min(window.innerWidth * 0.94, 1400);
    var h = Math.round(w * ratio);
    if (h > window.innerHeight * 0.78) {
      h = Math.round(window.innerHeight * 0.78);
      w = Math.round(h / ratio);
    }
    return { width: w, height: h };
  }

  function applyLightboxZoom() {
    var zl = $('lightbox-zoom');
    if (!zl) return;
    zl.style.transformOrigin = lightboxOx + '% ' + lightboxOy + '%';
    zl.style.transform = 'translate(' + lightboxTx + 'px,' + lightboxTy + 'px) scale(' + lightboxZoom + ')';
  }

  function setLightboxZoom(z, ox, oy) {
    lightboxZoom = Math.max(0.5, Math.min(4, z)); // 缩放范围 0.5x ~ 4x
    if (lightboxZoom === 1) { lightboxTx = 0; lightboxTy = 0; lightboxOx = 50; lightboxOy = 50; }
    else { lightboxOx = ox !== undefined ? ox : 50; lightboxOy = oy !== undefined ? oy : 50; }
    applyLightboxZoom();
  }

  /** 设计基准尺寸（第十七批）：页面上网页观感最好时各图的实际像素尺寸（1366 窗口实测）。
   *  所有导出/灯箱/PDF 的 scale = 目标宽 ÷ 对应 DESIGN 宽；改动布局后需重测。 */
  var DESIGN = {
    single:   { w: 467, h: 300 },
    combined: { w: 960, h: 683 },
    jv:       { w: 368, h: 300 },
    jvOverlay: { w: 700, h: 350 } // P5-5：叠加图 2:1；w 用于字号比例（导出 1400 时 scale=2，字放大清晰）
  };

  /** 导出尺寸（与 DESIGN 同宽高比）+ scale：scale = targetW ÷ DESIGN 宽（网页观感金标准） */
  function exportSizeOf(kind, targetW) {
    var d = DESIGN[kind];
    return {
      width: targetW,
      height: Math.round(targetW * d.h / d.w),
      scale: targetW / d.w
    };
  }

  /** 导出尺寸映射（lightbox 复制/下载；第十七批：与 DESIGN 同比例 + scale） */
  function exportSizeFor(kind) {
    if (kind === 'combined') return { width: 1400, height: 980, scale: 1400 / DESIGN.combined.w }; // 合并图容器固定 1400×980（像素 grid 按此调校，同 DESIGN 比例会致中缝爆炸）
    if (kind === 'jvOverlay') return { width: 1400, height: 700, scale: 1400 / DESIGN.jvOverlay.w }; // P5-5：叠加图同合并等级
    if (kind === 'jv') return exportSizeOf('jv', 800);
    return exportSizeOf('single', 1080);
  }

  function openLightbox(title, kind, renderFn) {
    lightboxRender = renderFn; // 供 lightbox 导出走离屏（exportMode）
    var mask = $('chart-lightbox');
    var chartBox = $('lightbox-chart');
    if (!mask || !chartBox) return;
    $('lightbox-title').textContent = title;
    chartBox.innerHTML = '';
    // 缩放层（视口内）：ECharts 实例初始化在缩放层上，transform 缩放/平移
    var zoomLayer = document.createElement('div');
    zoomLayer.className = 'lightbox-zoom';
    zoomLayer.id = 'lightbox-zoom';
    chartBox.appendChild(zoomLayer);
    // 尺寸：lightboxSize(kind) 统一计算（宽 min(94vw,1400px)，超高限 78vh）
    lightboxKind = kind;
    lightboxZoom = 1; lightboxTx = 0; lightboxTy = 0; lightboxOx = 50; lightboxOy = 50; // 每次打开重置
    var size = lightboxSize(kind);
    chartBox.style.width = size.width + 'px';
    chartBox.style.height = size.height + 'px';
    zoomLayer.style.width = size.width + 'px';
    zoomLayer.style.height = size.height + 'px';
    try {
      // 第十七批：灯箱按容器宽缩放（网页观感金标准）；合并图上限 1.6（避免过大）
      // 第十九批：灯箱统一 exportMode + 内容盒模型（与导出/PDF 同布局体系，观感一致）
      // V3 修正：灯箱 grid 按容器实际宽（填满），scale = 灯箱宽/导出标准宽（字号观感与导出一致）
      var lbScale = size.width / exportSizeFor(lightboxKind).width;
      if (lightboxKind === 'combined') lbScale = Math.min(lbScale, 1.6);
      lightboxChart = renderFn(zoomLayer, { scale: lbScale, exportMode: true, exportW: size.width, exportH: size.height });
      lightboxChart.resize();
    } catch (e) {
      T.showToast('放大渲染失败：' + e.message);
      lightboxChart = null;
    }
    lightboxBase = fileNameBase() + '_' + title;
    mask.hidden = false;
  }

  function closeLightbox() {
    var mask = $('chart-lightbox');
    if (!mask) return;
    mask.hidden = true;
    lightboxRender = null;
    if (lightboxChart) {
      try { lightboxChart.dispose(); } catch (e) {}
      lightboxChart = null;
    }
    var chartBox = $('lightbox-chart');
    if (chartBox) chartBox.innerHTML = '';
  }

  // 浮层打开期间窗口 resize 重排（同一份尺寸逻辑，第五批调大）
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', function () {
      var mask = $('chart-lightbox');
      if (mask && !mask.hidden && lightboxChart) {
        var chartBox = $('lightbox-chart');
        var size = lightboxSize(lightboxKind);
        chartBox.style.width = size.width + 'px';
        chartBox.style.height = size.height + 'px';
        var zl = $('lightbox-zoom');
        if (zl) { zl.style.width = size.width + 'px'; zl.style.height = size.height + 'px'; }
        lightboxChart.resize();
      }
    });
  }

  /* Lightbox 交互（缩放/平移）——init 里绑定一次；缩放状态重置在 openLightbox */
  function initLightboxInteractions() {
    var chartBox = $('lightbox-chart');
    if (!chartBox) return;
    // 滚轮缩放：以光标位置为中心（0.5x ~ 4x，每格 ×1.2 / ÷1.2）
    chartBox.addEventListener('wheel', function (e) {
      if (!lightboxChart) return;
      e.preventDefault();
      var rect = chartBox.getBoundingClientRect();
      var px = (e.clientX - rect.left) / rect.width * 100;
      var py = (e.clientY - rect.top) / rect.height * 100;
      var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setLightboxZoom(lightboxZoom * factor, px, py);
    }, { passive: false });
    // 拖拽平移（zoom > 1 时）
    var dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
    chartBox.addEventListener('mousedown', function (e) {
      if (!lightboxChart || lightboxZoom <= 1) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startTx = lightboxTx; startTy = lightboxTy;
      var zl = $('lightbox-zoom');
      if (zl) zl.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      lightboxTx = startTx + (e.clientX - startX);
      lightboxTy = startTy + (e.clientY - startY);
      applyLightboxZoom();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      var zl = $('lightbox-zoom');
      if (zl) zl.classList.remove('dragging');
    });
    // ➕ / ➖ / 重置
    var zIn = $('lightbox-zoom-in');
    var zOut = $('lightbox-zoom-out');
    var zReset = $('lightbox-zoom-reset');
    if (zIn) zIn.addEventListener('click', function () { if (lightboxChart) setLightboxZoom(lightboxZoom * 1.2, 50, 50); });
    if (zOut) zOut.addEventListener('click', function () { if (lightboxChart) setLightboxZoom(lightboxZoom / 1.2, 50, 50); });
    if (zReset) zReset.addEventListener('click', function () { if (lightboxChart) setLightboxZoom(1); });
  }

  /* ================================================================
   * 第二十四批：图像格式调整器（⚙ 调整格式）
   * 可视化控制台编辑 chartStyle → 实时预览 → 页面/灯箱/复制/PDF 全同步 + localStorage 持久化
   * ================================================================ */
  var styleEditorChart = null, styleEditorKind = 'single';
  var stylePreviewBox = null; // V2 收尾：预览盒复用（防闪烁）
  /** V3：重置样式预览（实例 dispose + 旧盒移除——切换图型时避免多盒累积空白遮挡） */
  function resetStylePreview() {
    if (styleEditorChart) { try { styleEditorChart.dispose(); } catch (e) {} styleEditorChart = null; }
    if (stylePreviewBox && stylePreviewBox.parentNode) { try { stylePreviewBox.parentNode.removeChild(stylePreviewBox); } catch (e) {} }
    stylePreviewBox = null;
  }

  /** 当前勾选+排序后的条件（编辑器预览数据源） */
  function orderedCheckedConditions() {
    var data = currentData();
    if (!data) return [];
    return checkedConditions(data);
  }

  /** 按图型自建预览 renderFn（不再依赖卡片传入的 renderFn） */
  function makePreviewRender(kind) {
    var conds = orderedCheckedConditions();
    if (!conds || !conds.length) return null;
    var opts = { chartColor: chartColor, meanMark: true, rawPoints: true, axisTitlePos: state.axisTitlePos };
    if (kind === 'combined') {
      return function (dom, ex) { return C.renderCombinedBoxplot(dom, conds, Object.assign({}, opts, ex || {})); };
    }
    if (kind === 'jv') {
      return function (dom, ex) { return C.renderJVChart(dom, conds[0], Object.assign({}, opts, { condIndex: 0, jvFocus: true }, ex || {})); };
    }
    if (kind === 'jvOverlay') { // P5-4：叠加图预览（反扫口径）
      return function (dom, ex) { return C.renderJVOverlay(dom, conds, Object.assign({}, opts, { direction: 'rev' }, ex || {})); };
    }
    return function (dom, ex) { return C.renderBoxplot(dom, 'pce', conds, Object.assign({}, opts, ex || {})); };
  }

  function openStyleEditor(kind) {
    styleEditorKind = kind || 'single';
    resetStylePreview(); // V3：重置实例并移除旧盒（防多盒累积空白遮挡）
    ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
      var btn = $('style-kind-' + k);
      if (btn) btn.classList.toggle('active', k === styleEditorKind);
    });
    document.body.style.overflow = 'hidden'; // 第二十五批：锁背景滚动，编辑器内滚动不穿透
    // V3 修复：先显示 mask 再 build/render——隐藏态（display:none）下 offsetWidth=0，
    // fitPreviewBox 会算出 k=1（不缩放）→ 首帧预览以原始大尺寸溢出预览区（改数值/切换后才正常）
    $('style-editor').hidden = false;
    buildStyleConsole();
    renderStylePreview();
  }

  function switchStyleKind(kind) {
    styleEditorKind = kind;
    resetStylePreview(); // V3：重置实例并移除旧盒
    ['single', 'combined', 'jv', 'jvOverlay'].forEach(function (k) {
      var btn = $('style-kind-' + k);
      if (btn) btn.classList.toggle('active', k === styleEditorKind);
    });
    buildStyleConsole();
    renderStylePreview();
  }

  function renderStylePreview() {
    var preview = $('style-preview');
    if (!preview) return;
    // V2 收尾：预览闪烁修复——box 与 chart 实例复用（仅 setOption 更新 + 尺寸同步），不再每次重建/dispose
    if (!stylePreviewBox) {
      stylePreviewBox = document.createElement('div');
      stylePreviewBox.className = 'style-preview-box';
      preview.appendChild(stylePreviewBox);
    }
    var box = stylePreviewBox;
    var D = DESIGN[styleEditorKind];
    var isOv = styleEditorKind === 'jvOverlay';
    var w = styleEditorKind === 'combined' ? 700 : (isOv ? 1400 : (styleEditorKind === 'jv' ? 520 : 460));
    var h = Math.round(w * D.h / D.w);
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    if (isOv) {
      box.style.transform = 'scale(0.5)';
      box.style.transformOrigin = '0 0';
      box.style.marginBottom = '-' + Math.round(h * 0.5) + 'px';
      box.style.marginRight = '-' + Math.round(w * 0.5) + 'px';
    } else {
      box.style.transform = '';
      box.style.marginRight = '';
      box.style.marginBottom = '';
    }
    var renderFn = makePreviewRender(styleEditorKind);
    if (!renderFn) return;
    try {
      var prevScale = isOv ? 2 : w / D.w;
      var ex = { exportMode: true, __pageMode: true, scale: prevScale, exportW: w, exportH: h };
      if (!styleEditorChart) {
        // 首次：init 实例
        styleEditorChart = renderFn(box, ex);
        // 渲染后 fit（超宽整形缩放显示；以后每次更新再来一次）
        fitPreviewBox(box);
      } else {
        // 复用实例：重算 option → 尺寸同步 → setOption（notMerge 完整替换，避免旧系列残留）
        var newOpt = buildPreviewOption(styleEditorKind, prevScale, w, h);
        if (newOpt) {
          var sz = previewNeedSize(newOpt);
          if (sz) {
            if (sz.w) box.style.width = Math.ceil(sz.w) + 'px';
            if (sz.h) box.style.height = Math.ceil(sz.h) + 'px';
          }
          styleEditorChart.setOption(newOpt, true);
        }
        fitPreviewBox(box);
      }
    } catch (e) {}
  }

  /** V2 收尾：读取选项中的容器目标尺寸（combined/overlay 有 __needW/H；single/jv 有 __needH） */
  function previewNeedSize(opt) {
    var rw = null, rh = null;
    if (opt.__needW != null) rw = opt.__needW;
    if (opt.__needH != null) rh = opt.__needH;
    if (opt.grid) {
      var g = Array.isArray(opt.grid) ? opt.grid[0] : opt.grid;
      if (g) {
        if (g.__needW != null) rw = g.__needW;
        if (g.__needH != null) rh = g.__needH;
      }
    }
    return (rw != null || rh != null) ? { w: rw, h: rh } : null;
  }

  /** V3 收尾：预览盒 fit（宽高双向按预览区可用空间缩放显示，防显示不全/滚动裁切） */
  function fitPreviewBox(box) {
    if (!box) return;
    var pv = $('style-preview');
    var maxW = pv ? Math.max(200, pv.clientWidth - 48) : 700;
    var maxH = pv ? Math.max(200, pv.clientHeight - 48) : 500;
    var bw = box.offsetWidth || 0;
    var bh = box.offsetHeight || 0;
    var k = Math.min(1, maxW / bw, maxH / bh);
    if (k < 1) {
      box.style.transformOrigin = '0 0';
      box.style.transform = 'scale(' + k + ')';
      box.style.marginRight = '-' + Math.floor(bw * (1 - k)) + 'px';
      box.style.marginBottom = '-' + Math.floor(bh * (1 - k)) + 'px';
    } else {
      box.style.transform = '';
      box.style.marginRight = '';
      box.style.marginBottom = '';
    }
  }

  /** V2 收尾：纯 option 构建（复用实例时 setOption 用；与 makePreviewRender 同参）
   *  返回 __needW/__needH 供容器尺寸同步可由渲染器内部保持——这里同步 box 尺寸 */
  function buildPreviewOption(kind, prevScale, w, h) {
    var conds = orderedCheckedConditions();
    if (!conds || !conds.length) return null;
    var base = { chartColor: chartColor, meanMark: true, rawPoints: true, axisTitlePos: state.axisTitlePos };
    if (kind === 'combined') return C.buildCombinedOption(conds, Object.assign({}, base, { exportMode: true, __pageMode: true, scale: prevScale, exportW: w, exportH: h }));
    if (kind === 'jv') return C.buildJVOption(conds[0], Object.assign({}, base, { condIndex: 0, jvFocus: true, exportMode: true, __pageMode: true, scale: prevScale, exportW: w, exportH: h }));
    if (kind === 'jvOverlay') return C.buildJVOverlayOption(conds, Object.assign({}, base, { direction: 'rev', exportMode: true, __pageMode: true, scale: prevScale, exportW: w, exportH: h }));
    return C.buildBoxplotOption('pce', conds, Object.assign({}, base, { exportMode: true, __pageMode: true, scale: prevScale, exportW: w, exportH: h }));
  }

  function closeStyleEditor() {
    var el = $('style-editor');
    if (!el) return;
    el.hidden = true;
    document.body.style.overflow = ''; // 第二十五批：恢复背景滚动
    if (styleEditorChart) { try { styleEditorChart.dispose(); } catch (e) {} styleEditorChart = null; }
    C.saveChartStyle();
    renderAll(); // 同步页面
  }

  var _previewRaf = null;
  function schedulePreview() {
    if (_previewRaf) return;
    _previewRaf = requestAnimationFrame(function () { _previewRaf = null; renderStylePreview(); });
  }

  /* ---------- 控件工厂（支持嵌套 key，如 layout.combined.gutterPct） ---------- */
  function getNested(obj, path) {
    return path.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, obj);
  }
  function setNested(obj, path, val) {
    var parts = path.split('.');
    var o = obj;
    for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }

  function sliderItem(label, key, min, max, step) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    lab.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? '0 = auto / default' : '0 = 自动/默认';
    var cur = getNested(C.chartStyle, key);
    if (cur == null) cur = Number(min); // 第三十七批（第三）修复：null 显示 min（避免 range 回退中间值误导），语义按各字段（0=自动）
    var val = document.createElement('span'); val.className = 'sc-value'; val.textContent = cur;
    var inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = cur;
    inp.addEventListener('input', function () {
      setNested(C.chartStyle, key, parseFloat(inp.value));
      val.textContent = inp.value;
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(val);
    return wrap;
  }

  function checkItem(label, key) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    var inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!getNested(C.chartStyle, key);
    inp.addEventListener('change', function () {
      setNested(C.chartStyle, key, inp.checked);
      C.saveChartStyle();
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(inp);
    return wrap;
  }

  function colorItem(label, key) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    var val = document.createElement('span'); val.className = 'sc-value'; val.textContent = getNested(C.chartStyle, key);
    var inp = document.createElement('input'); inp.type = 'color'; inp.value = getNested(C.chartStyle, key);
    inp.addEventListener('input', function () {
      setNested(C.chartStyle, key, inp.value);
      val.textContent = inp.value;
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(val);
    return wrap;
  }

  /** 第三十七批（第三）：数字输入控件（轴范围/增量手动输入；留空=自动，null 语义） */
  function numberItem(label, key) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    lab.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Leave empty = auto' : '留空 = 自动';
    var inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.className = 'sc-num';
    inp.placeholder = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'auto' : '自动';
    inp.value = getNested(C.chartStyle, key) == null ? '' : getNested(C.chartStyle, key);
    inp.addEventListener('input', function () {
      var raw = inp.value.trim();
      var v = raw === '' ? null : parseFloat(raw);
      if (v !== null && !isFinite(v)) v = null;
      setNested(C.chartStyle, key, v);
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(inp);
    return wrap;
  }

  function selectItem(label, key, options) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = label;
    var sel = document.createElement('select');
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o; op.textContent = o;
      sel.appendChild(op);
    });
    sel.value = getNested(C.chartStyle, key);
    sel.addEventListener('change', function () {
      setNested(C.chartStyle, key, sel.value);
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(sel);
    return wrap;
  }

  function addGroup(consoleEl, title, items) {
    var g = document.createElement('div'); g.className = 'sc-group';
    var t = document.createElement('div'); t.className = 'sc-group-title'; t.textContent = title;
    g.appendChild(t);
    items.forEach(function (it) { g.appendChild(it); });
    consoleEl.appendChild(g);
  }

  function addPaletteGroup(consoleEl) {
    var g = document.createElement('div'); g.className = 'sc-group';
    var t = document.createElement('div'); t.className = 'sc-group-title'; t.textContent = (typeof I18N !== 'undefined' ? I18N.t('st.palette') : '调色板');
    g.appendChild(t);
    var grid = document.createElement('div'); grid.className = 'sc-palette-grid';
    Object.keys(C.PALETTES).forEach(function (name) {
      var item = document.createElement('div');
      item.className = 'sc-palette-item' + (C.chartStyle.palette === name ? ' active' : '');
      var sw = document.createElement('div'); sw.className = 'sc-palette-swatches';
      C.PALETTES[name].forEach(function (c) {
        var s = document.createElement('span'); s.style.background = c; sw.appendChild(s);
      });
      var nm = document.createElement('div'); nm.className = 'sc-palette-name'; nm.textContent = name;
      item.appendChild(sw); item.appendChild(nm);
      item.addEventListener('click', function () {
        C.chartStyle.palette = name;
        C.saveChartStyle();
        grid.querySelectorAll('.sc-palette-item').forEach(function (x) { x.classList.remove('active'); });
        item.classList.add('active');
        schedulePreview();
      });
      grid.appendChild(item);
    });
    g.appendChild(grid);
    consoleEl.appendChild(g);
  }

  /** 条件颜色组（第二十五批）：JV tab 显示，每个条件一个取色器，写 chartStyle.condColors[name] */
  function addCondColorGroup(consoleEl) {
    var g = document.createElement('div'); g.className = 'sc-group';
    var t = document.createElement('div'); t.className = 'sc-group-title'; t.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Condition colors (per-condition for JV/boxplots)' : '条件颜色（JV/箱线图按条件分别指定）';
    g.appendChild(t);
    // 「按调色板重置」按钮：清空 condColors，恢复按序号取色
    var reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn btn-sm';
    reset.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? '↺ Reset to palette' : '↺ 按调色板重置'; reset.style.margin = '6px 12px';
    reset.addEventListener('click', function () {
      C.chartStyle.condColors = {}; C.saveChartStyle(); schedulePreview(); renderAll();
    });
    g.appendChild(reset);
    var conds = orderedCheckedConditions();
    conds.forEach(function (c, i) {
      var name = c.displayName || c.name;
      var cur = C.chartStyle.condColors[name] || chartColor(i, name);
      var row = document.createElement('div'); row.className = 'sc-item';
      var lab = document.createElement('span'); lab.className = 'sc-label'; lab.textContent = name; lab.title = name;
      var inp = document.createElement('input'); inp.type = 'color'; inp.value = cur;
      inp.addEventListener('input', function () {
        C.chartStyle.condColors[name] = inp.value; C.saveChartStyle(); schedulePreview();
      });
      row.appendChild(lab); row.appendChild(inp); g.appendChild(row);
    });
    consoleEl.appendChild(g);
  }

  /** V2 收尾：箱体宽度联动控件（min/max 同步偏移 13%，防 min>max 反转失效） */
  function boxWidthItem(k) {
    var wrap = document.createElement('div'); wrap.className = 'sc-item';
    var lab = document.createElement('span'); lab.className = 'sc-label';
    lab.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Box width' : '箱体宽度';
    lab.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
      ? 'Box width (%): min/max linked; widening the box keeps both in sync'
      : '箱体宽度（百分比）：min/max 联动，拉大箱体同步变宽';
    var cur = getNested(C.chartStyle, k + '.boxWidthMin');
    var val = document.createElement('span'); val.className = 'sc-value'; val.textContent = cur;
    var inp = document.createElement('input'); inp.type = 'range';
    inp.min = 20; inp.max = 90; inp.step = 1; inp.value = cur;
    inp.addEventListener('input', function () {
      var v = parseFloat(inp.value);
      setNested(C.chartStyle, k + '.boxWidthMin', v);
      setNested(C.chartStyle, k + '.boxWidthMax', Math.min(96, v + 13));
      val.textContent = v;
      schedulePreview();
    });
    wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(val);
    return wrap;
  }

  /** V2 收尾：合并图 Y 轴 per-key 控件（参数下拉 + 起始/结束/增量，写 combined.yRanges[key]） */
  function buildCombinedYRangeItems() {
    var wrap = document.createElement('div');
    wrap.className = 'sc-item sc-item-row';
    var lab = document.createElement('span');
    lab.className = 'sc-label';
    lab.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Parameter' : '参数';
    lab.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
      ? 'Select a parameter to set its own Y range (blank = auto); parameters without a custom range follow the global Y range above'
      : '选择参数单独设置 Y 范围（留空 = 自动）；未单独设置的参数沿用上方全局 Y 范围';
    var sel = document.createElement('select');
    var NAMES = { pce: 'PCE', voc: 'Voc', jsc: 'Jsc', ff: 'FF' };
    ['pce', 'voc', 'jsc', 'ff'].forEach(function (kk) {
      var op = document.createElement('option');
      op.value = kk; op.textContent = NAMES[kk];
      sel.appendChild(op);
    });
    var FIELDS = ['min', 'max', 'interval'];
    var PH = { min: '起始', max: '结束', interval: '增量' };
    var PH_EN = { min: 'Start', max: 'End', interval: 'Step' };
    var phEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：合并图 Y-range 占位
    var inputs = FIELDS.map(function (f) {
      var inp = document.createElement('input');
      inp.type = 'number'; inp.step = 'any'; inp.className = 'sc-num';
      inp.placeholder = phEn ? PH_EN[f] : PH[f]; inp.style.width = '58px';
      inp.title = phEn ? 'Leave empty = auto' : '留空 = 自动';
      inp.addEventListener('input', function () {
        var key = sel.value;
        if (!C.chartStyle.combined.yRanges) C.chartStyle.combined.yRanges = {};
        if (!C.chartStyle.combined.yRanges[key]) C.chartStyle.combined.yRanges[key] = {};
        var raw = inp.value.trim();
        var v = raw === '' ? null : parseFloat(raw);
        if (v !== null && !isFinite(v)) v = null;
        C.chartStyle.combined.yRanges[key][f] = v;
        C.saveChartStyle();
        schedulePreview();
      });
      return inp;
    });
    sel.addEventListener('change', function () {
      var kr = C.chartStyle.combined.yRanges && C.chartStyle.combined.yRanges[sel.value];
      inputs.forEach(function (inp, i) {
        var v = kr ? kr[FIELDS[i]] : null;
        inp.value = v == null ? '' : v;
      });
    });
    wrap.appendChild(lab);
    wrap.appendChild(sel);
    inputs.forEach(function (i2) { wrap.appendChild(i2); });
    return [wrap];
  }

  /** 控制台按图型分区（第二十五批）：styleEditorKind 决定组；所有参数 key = 图型命名空间点路径 */
  function buildStyleConsole() {
    var consoleEl = $('style-console');
    if (!consoleEl) return;
    consoleEl.innerHTML = '';
    var k = styleEditorKind; // 'single' | 'combined' | 'jv' | 'jvOverlay'
    var scEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：格式面板组标题
    var kName = scEn
      ? ({ single: 'Single', combined: 'Combined', jv: 'JV', jvOverlay: 'JV Overlay' })[k]
      : ({ single: '单图', combined: '合并图', jv: 'JV', jvOverlay: 'JV 叠加' })[k];
    var isJvKind = k === 'jv' || k === 'jvOverlay'; // P5-4：两类 JV 共用 JV 控件组（各自命名空间）
    // 通用（当前图型命名空间）
    addGroup(consoleEl, (scEn ? 'General · ' : '通用 · ') + kName, [
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.xTick') : 'X 刻度字号'), k + '.xTickFontSize', 8, 20, 1), // t6：横纵分开（箱线图）
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.yTick') : 'Y 刻度字号'), k + '.yTickFontSize', 8, 20, 1),
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.titleFs') : '标题字号'), k + '.titleFontSize', 10, 24, 1),
      checkItem((typeof I18N !== 'undefined' ? I18N.t('st.titleBold') : '标题加粗'), k + '.titleBold'),
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.axisW') : '边框线宽'), k + '.axisLineWidth', 0.5, 3, 0.5),
      colorItem((typeof I18N !== 'undefined' ? I18N.t('st.axisColor') : '边框颜色'), k + '.axisLineColor'),
      colorItem((typeof I18N !== 'undefined' ? I18N.t('st.tickColor') : '刻度线颜色'), k + '.tickColor'),
      colorItem((typeof I18N !== 'undefined' ? I18N.t('st.labelColor') : '标签颜色'), k + '.labelColor')
    ]);
    // 箱线图（仅单图/合并图 tab）
    if (!isJvKind) {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.groupBox') : '箱线图'), [
        boxWidthItem(k), // V2 收尾：min/max 联动（原 min 单滑块 > max 固定 68 时反转失效）
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.boxFill') : '填充透明度'), k + '.boxFillAlpha', 0, 1, 0.05),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.boxW') : '描边宽度'), k + '.boxBorderWidth', 0.5, 4, 0.5),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.boxDark') : '描边加深'), k + '.boxBorderDarken', 0, 0.6, 0.05),
        checkItem((typeof I18N !== 'undefined' ? I18N.t('st.rawPts') : '原始数据点'), k + '.showRawPoints'),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.rawSize') : '数据点大小'), k + '.rawPointSize', 1, 8, 0.5),
        checkItem((typeof I18N !== 'undefined' ? I18N.t('st.meanMark') : '均值标记'), k + '.showMean'),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.meanSize') : '均值大小'), k + '.meanSize', 4, 16, 1),
        colorItem((typeof I18N !== 'undefined' ? I18N.t('st.meanColor') : '均值颜色'), k + '.meanColor'),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.meanDark') : '均值描边加深'), k + '.meanBorderDarken', 0, 0.6, 0.05)
      ]);
    }
    // JV 专属（仅 jv tab）
    if (isJvKind) {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.jvGroup') : 'JV 曲线'), [
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.jvRevW') : '反扫线宽'), k + '.jvRevLineWidth', 1, 5, 0.5),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.jvFwdW') : '正扫线宽'), k + '.jvFwdLineWidth', 1, 5, 0.5),
        selectItem((typeof I18N !== 'undefined' ? I18N.t('st.jvFwdDash') : '正扫线型'), k + '.jvFwdDash', ['dashed', 'dotted', 'solid']),
        checkItem((typeof I18N !== 'undefined' ? I18N.t('st.jvRefLine') : '参考线'), k + '.jvShowRefLine'),
        checkItem((typeof I18N !== 'undefined' ? I18N.t('st.jvLegend') : '图例'), k + '.jvShowLegend'),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.jvLegendFs') : '图例字号'), k + '.jvLegendFontSize', 8, 18, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.jvLegendX') : '图例水平偏移'), k + '.jvLegendOffsetX', -1000, 1000, 5), // P5-收尾：全图覆盖（right 从最右到最左）
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.jvLegendY') : '图例垂直偏移'), k + '.jvLegendOffsetY', -200, 200, 5)  // P5-收尾：全高覆盖（0%~100%）
      ]);
      // 条件颜色：每个条件一个取色器，写 chartStyle.condColors[name]
      addCondColorGroup(consoleEl);
    }
    // 第三十七批（第三）：坐标轴（所有图型）——V2 收尾：合并图删除全局 Y 范围（改为 per-key 单独设置）
    var axisItems = [
      selectItem((typeof I18N !== 'undefined' ? I18N.t('st.axisYPos') : 'Y 标题位置'), k + '.yTitlePos', ['left', 'right'])
    ];
    if (k !== 'combined') {
      axisItems.unshift(
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Y start' : 'Y 轴起始', k + '.yMin'),
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Y end' : 'Y 轴结束', k + '.yMax'),
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Y step' : 'Y 轴增量', k + '.yInterval')
      );
    }
    if (isJvKind) {
      axisItems.push(
        selectItem((typeof I18N !== 'undefined' ? I18N.t('st.axisXPos') : 'X 标题位置'), k + '.xTitlePos', ['bottom', 'top'])
      );
    } else {
      axisItems.push(
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.xRot') : 'X 标签旋转'), k + '.xLabelRotate', 0, 60, 1) // 0=自动
      );
    }
    axisItems.push(
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.xGap') : 'X 标签间距'), k + '.xLabelGap', 0, 20, 1), // 0=默认，横纵分别控制
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.xOffset') : 'X 标签偏移'), k + '.xLabelOffset', -40, 40, 1), // t6：横向微调（旋转标签与箱体对齐）
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.yGap') : 'Y 标签间距'), k + '.yLabelGap', 0, 20, 1),
      sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.titleGapY') : 'Y 标题间距'), k + '.yTitleGap', 0, 120, 1) // V3：上限扩大   // 0=自动（按刻度标签宽动态算）
    );
    if (isJvKind) {
      axisItems.push(sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.titleGapX') : 'X 标题间距'), k + '.xTitleGap', 0, 60, 1)); // 0=自动
    }
    addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.axisCommon') : '坐标轴') + ' · ' + kName, axisItems);
    // V2 收尾：合并图 Y 轴按参数单独设置（4 参数范围相差大，分开调）
    if (k === 'combined') {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.axisPerKey') : '坐标轴 · 合并图按参数（单独设 Y 范围）'), buildCombinedYRangeItems());
    }
    // JV 额外横轴范围
    if (k === 'jv') {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.axisJvX') : '坐标轴 · JV 横轴'), [
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'X start' : 'X 轴起始', k + '.xMin'),
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'X end' : 'X 轴结束', k + '.xMax'),
        numberItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'X step' : 'X 轴增量', k + '.xInterval')
      ]);
    }
    // 布局（当前图型命名空间）
    if (k === 'single') {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.layoutSingle') : '布局 · 单图'), [
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padTop2') : '上留白'), k + '.layout.padTop', 4, 30, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padRight') : '右留白'), k + '.layout.padRight', 4, 30, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padBottom2') : '下留白基数'), k + '.layout.padBottom', 4, 90, 1) // V2 收尾：范围扩大（须 > X 标签空间才可见效）
      ]);
    } else if (k === 'combined') {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.layoutComb') : '布局 · 合并图'), [
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.gutter') : '中缝(百分比)'), k + '.layout.gutterPct', 6, 20, 1), // V3：删除像素中缝（语义重复）
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.vgap') : '行距'), k + '.layout.vgap', 8, 50, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padTop') : '上留白'), k + '.layout.padTop', 4, 30, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padBottom2') : '下留白基数'), k + '.layout.padBottom', 4, 90, 1) // V2 收尾：范围扩大（须 > X 标签空间才可见效）
      ]);
    } else {
      addGroup(consoleEl, (typeof I18N !== 'undefined' ? I18N.t('st.layoutJv') : '布局 · JV'), [
        sliderItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Left padding' : '左留白', k + '.layout.padLeft', 30, 80, 1),
        sliderItem((typeof I18N !== 'undefined' ? I18N.t('st.padRight') : '右留白'), k + '.layout.padRight', 8, 40, 1),
        sliderItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Top padding' : '上留白', k + '.layout.padTop', 30, 70, 1),
        sliderItem((typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Bottom padding' : '下留白', k + '.layout.padBottom', 30, 70, 1)
      ]);
    }
    // 调色板（全局，所有 tab 都显示）
    addPaletteGroup(consoleEl);
  }

  global.JVMain = {
    init: init,
    state: state,
    THEME: THEME,
    softColor: softColor,
    chartColor: chartColor,
    getPref: getPref,
    orderedConditions: orderedConditions,
    checkedConditions: checkedConditions,
    currentData: currentData,
    renderAll: renderAll,
    recomputeMax: recomputeMax,
    updateSpy: updateSpy,
    handleFiles: handleFiles,
    addFile: addFile,
    mergeData: mergeData,
    mergeWithCurrent: mergeWithCurrent,
    exportPdf: exportPdf
  };

  // 页面加载完成后启动
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
