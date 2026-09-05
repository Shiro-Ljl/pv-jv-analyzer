/**
 * ui.js —— 界面交互（实施规格书第 6、7 章）
 *
 *   renderFileTabs(files, currentIndex, onClick)   → 顶部文件标签栏（多文件切换，M6 启用）
 *   renderParseSummary(stats)                      → 工具栏右侧解析状态摘要
 *   renderWarnBar(stats)                           → 解析计数与异常警告条（5.9）
 *   renderConditionPanel(data, prefs, callbacks)   → S1 条件面板：勾选/改名/首个条件
 *   updateCondCount()                              → 「已选择 X / Y 个条件」
 */
(function (global) {
  'use strict';

  var P = global.JVParser;

  function $(id) { return document.getElementById(id); }

  /* ---------- 文件标签栏（M6 多文件） ---------- */
  function renderFileTabs(files, currentIndex, onClick) {
    var wrap = $('file-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!files || files.length === 0) return;
    files.forEach(function (f, i) {
      var tab = document.createElement('button');
      tab.className = 'file-tab' + (i === currentIndex ? ' active' : '');
      tab.textContent = f.name;
      tab.type = 'button';
      tab.addEventListener('click', function () { if (onClick) onClick(i); });
      wrap.appendChild(tab);
    });
  }

  /* ---------- 解析状态摘要（工具栏右侧） ---------- */
  function renderParseSummary(stats) {
    var el = $('parse-summary');
    if (!el || !stats) return;
    var en = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：解析摘要
    el.textContent = en
      ? ('Conditions×' + stats.conditionCount + ' · Devices×' + stats.validDeviceCount)
      : ('条件×' + stats.conditionCount + ' · 器件×' + stats.validDeviceCount);
  }

  /* ---------- 警告条（5.9 解析计数 + 异常） ---------- */
  function renderWarnBar(stats, fileName) {
    var bar = $('warn-bar');
    if (!bar) return;
    var en = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：英文态解析摘要
    var parts = en ? [
      'Conditions ' + stats.conditionCount,
      'Valid devices ' + stats.validDeviceCount,
      'Param records ' + stats.paramRecordCount,
      'Raw channels ' + stats.channelCount
    ] : [
      '条件 ' + stats.conditionCount,
      '有效器件 ' + stats.validDeviceCount,
      '参数记录 ' + stats.paramRecordCount,
      '原始通道 ' + stats.channelCount
    ];
    if (stats.unmatched > 0) parts.push(en ? ('Unpaired ' + stats.unmatched) : ('未配对 ' + stats.unmatched));
    if (stats.anomaly > 0) parts.push(en ? ('Anomalies ' + stats.anomaly) : ('异常 ' + stats.anomaly));
    if (stats.areaFallback > 0) parts.push(en ? ('Area fallback ' + stats.areaFallback) : ('Area 回退 ' + stats.areaFallback));
    if (stats.noRawData > 0) parts.push(en ? ('No raw data ' + stats.noRawData) : ('无原始数据通道 ' + stats.noRawData));
    if (stats.singleDir > 0) parts.push(en ? ('Single-direction devices x' + stats.singleDir) : ('单方向器件 ×' + stats.singleDir));
    var prefix = fileName ? (en ? '[' + fileName + '] ' : '「' + fileName + '」') : '';
    $('warn-text').textContent = prefix + (en ? 'Parsed: ' : '解析完成：') + parts.join(' · ');
    bar.hidden = false;
  }

  function hideWarnBar() {
    var bar = $('warn-bar');
    if (bar) bar.hidden = true;
  }

  /* ---------- S1 条件面板 ---------- */
  function renderConditionPanel(data, prefs, callbacks) {
    var list = $('cond-list');
    if (!list) return;
    list.innerHTML = '';
    var ordered = orderConditions(data, prefs);
    ordered.forEach(function (cond, orderIdx) {
      // 确保偏好对象真实存在于 prefs（不能只用临时对象，否则勾选状态丢失）
      var key = cond.name.toLowerCase();
      if (!prefs[key]) prefs[key] = { checked: true, displayName: cond.name, first: false };
      var pref = prefs[key];

      var row = document.createElement('div');
      row.className = 'cond-item';
      row.style.borderLeft = '3px solid ' + (callbacks.colorOf ? callbacks.colorOf(orderIdx) : 'transparent');
      row.setAttribute('data-cond-key', cond.name.toLowerCase()); // V2 收尾：drop 以 DOM 序为基准

      // 勾选框
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!pref.checked;
      cb.addEventListener('change', function () {
        pref.checked = cb.checked;
        if (callbacks.onChange) callbacks.onChange();
      });
      row.appendChild(cb);

      // 序号 + 拖拽把手（第十八批：仅把手 draggable，input/checkbox/row 不 draggable 保证文本可框选）
      var idx = document.createElement('span');
      idx.className = 'cond-idx';
      idx.textContent = (orderIdx + 1) + '.';
      row.appendChild(idx);
      var handle = document.createElement('span');
      handle.className = 'cond-drag-handle';
      handle.textContent = '⠿';
      handle.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Drag to reorder conditions; arrow keys ↑/↓ when focused' : '拖动排序条件；聚焦后按 ↑/↓ 移动';
      handle.draggable = true;
      handle.tabIndex = 0;
      row.appendChild(handle);

      // 拖拽排序（仅把手触发；onChange 全量重渲染）
      handle.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', cond.name.toLowerCase());
        e.dataTransfer.effectAllowed = 'move';
        // 第十九批：透明 1px 拖拽图像——去掉默认 ghost（避免看起来像拖动文件/文本块）
        var ghost = document.createElement('canvas');
        ghost.width = 1; ghost.height = 1;
        e.dataTransfer.setDragImage(ghost, 0, 0);
        row.classList.add('dragging');
        list._dragFrom = orderIdx; // 记录被拖行的当前索引
      });
      handle.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        list._dragFrom = null;
        clearDropMarks(list);
      });
      handle.addEventListener('keydown', function (e) {
        // 键盘备选：↑/↓ 移动该条件一位（无障碍 + 拖拽失效兜底）
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        var order = (prefs.__order || data.conditions.map(function (c) { return c.name.toLowerCase(); }));
        var idx2 = order.indexOf(cond.name.toLowerCase());
        if (idx2 < 0) return;
        var target = e.key === 'ArrowUp' ? idx2 - 1 : idx2 + 1;
        if (target < 0 || target >= order.length) return;
        order.splice(idx2, 1);
        order.splice(target, 0, cond.name.toLowerCase());
        prefs.__order = order;
        if (callbacks.onChange) callbacks.onChange();
      });
      // 拖拽目标行高亮与投放（第二十三批：改由 list 统一监听，见函数末尾 list 级 dragover/drop）

      // 显示名输入框（改名只影响显示，不改内部键）
      var input = document.createElement('input');
      input.className = 'cond-name-input';
      input.value = pref.displayName || cond.name;
      input.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
        ? ('Raw name: ' + cond.name + ' (editable display name)')
        : ('原始名：' + cond.name + '（可直接修改显示名）');
      input.addEventListener('change', function () {
        pref.displayName = input.value.trim() || cond.name;
        cond.displayName = pref.displayName; // 第十五批：写回 cond，保证箱线图 X 轴/汇总表/详情表/JV 标题/导航全部同步
        if (callbacks.onChange) callbacks.onChange();
      });
      row.appendChild(input);

      // 首个条件单选
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cond-first' + (pref.first ? ' on' : '');
      // i18n：动态文案经 I18N.tr（未匹配原样；zh 态原样）
      btn.textContent = pref.first ? '★ Base' : (typeof I18N !== 'undefined' ? I18N.tr('设为Base') : '设为Base');
      btn.title = (typeof I18N !== 'undefined' ? I18N.tr('设为基准条件（Base）：排到最前，并作为汇总表平均值对比的基准；单选') : '设为基准条件（Base）：排到最前，并作为汇总表平均值对比的基准；单选');
      if (pref.first) row.classList.add('first-row');
      btn.addEventListener('click', function () {
        var was = pref.first;
        // 单选：清空其他条件的 first
        data.conditions.forEach(function (c) {
          var p = prefs[c.name.toLowerCase()];
          if (p) p.first = false;
        });
        pref.first = !was;
        if (callbacks.onChange) callbacks.onChange();
      });
      row.appendChild(btn);

      // 第三十七批方案B：合并过的条件行内显示拆分按钮（把 merged 条件还原为原始成员）
      if (cond.merged && callbacks.onSplit) {
        var splitBtn = document.createElement('button');
        splitBtn.type = 'button';
        splitBtn.className = 'cond-split-btn';
        splitBtn.textContent = '⤢';
        splitBtn.title = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
          ? ('Split: restore "' + cond.name + '" into ' + ((cond.mergedFrom || []).join(', ') || 'its members'))
          : ('拆分：把「' + cond.name + '」还原为 ' + ((cond.mergedFrom || []).join('、') || '成员条件'));
        splitBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (callbacks.onSplit) callbacks.onSplit(cond.name);
        });
        row.appendChild(splitBtn);
      }

      // 整理模式：整行点击切换合并选中（不干扰 input/checkbox/button 原生交互）
      if (callbacks.merging) {
        row.classList.add('cond-merging-row');
        if (callbacks.selected && callbacks.selected(cond.name)) row.classList.add('cond-selected');
        row.addEventListener('click', function (e) {
          if (e.target.closest('input, button, .cond-drag-handle')) return;
          if (callbacks.onToggleSelect) callbacks.onToggleSelect(cond.name);
        });
      }

      list.appendChild(row);
    });

    /* ---------- 第二十三批：list 级拖拽目标（长距离拖动的精确落位 + 边缘自动滚动） ----------
     * V2 收尾修复：drop 的 order 以「当前 DOM 渲染序」为唯一基准（原用 __order/原始序，与
     * orderConditions 的 Base 置顶渲染序不一致 → 索引错位拖不动/乱位）。 */
    function clearDropMarks(l) {
      l.querySelectorAll('.drop-above, .drop-below').forEach(function (r) {
        r.classList.remove('drop-above', 'drop-below');
      });
    }
    function insertionIndex(l, clientY) {
      var rows = l.querySelectorAll('.cond-item');
      var idx = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i].getBoundingClientRect();
        if (clientY > r.top + r.height / 2) idx = i + 1;
        else break;
      }
      return idx;
    }
    function showDropMark(l, idx) {
      clearDropMarks(l);
      var rows = l.querySelectorAll('.cond-item');
      if (idx >= rows.length) {
        var last = rows[rows.length - 1];
        if (last) last.classList.add('drop-below');
      } else {
        rows[idx].classList.add('drop-above');
      }
    }
    list.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var idx = insertionIndex(list, e.clientY);
      showDropMark(list, idx);
      // 边缘自动滚动：接近列表上/下边界时滚动，长列表才能拖到远端
      var rect = list.getBoundingClientRect();
      var edge = 36;
      if (e.clientY < rect.top + edge) list.scrollTop -= 8;
      else if (e.clientY > rect.bottom - edge) list.scrollTop += 8;
    });
    list.addEventListener('dragleave', function () { clearDropMarks(list); });
    list.addEventListener('drop', function (e) {
      e.preventDefault();
      var draggedName = e.dataTransfer.getData('text/plain');
      clearDropMarks(list);
      if (!draggedName) return;
      // V2 收尾：以 DOM 渲染序为唯一基准（orderConditions 的 Base 置顶已反映在 DOM 中）
      var order = Array.prototype.map.call(list.querySelectorAll('.cond-item'), function (r) {
        return r.getAttribute('data-cond-key') || '';
      }).filter(function (x) { return x; });
      if (!order.length) return;
      var from = order.indexOf(draggedName);
      if (from < 0) return;
      var insertAt = insertionIndex(list, e.clientY); // 相对当前 DOM 行序的插入位
      order.splice(from, 1);
      if (from < insertAt) insertAt -= 1; // 删除前项后索引前移
      if (insertAt < 0) insertAt = 0;
      if (insertAt > order.length) insertAt = order.length;
      if (insertAt === from) return; // 位置未变
      order.splice(insertAt, 0, draggedName);
      prefs.__order = order;
      if (callbacks.onChange) callbacks.onChange();
    });

    updateCondCount(data, prefs);
  }

  /** 首个条件排最前，其余按原始顺序 */
  function orderConditions(data, prefs) {
    // 第十八批：prefs.__order 保存拖拽顺序（不在 saved 中的按原始顺序追加尾部，稳定排序）
    var saved = prefs.__order || [];
    var all = data.conditions.slice();
    all.sort(function (a, b) {
      var ia = saved.indexOf(a.name.toLowerCase());
      var ib = saved.indexOf(b.name.toLowerCase());
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });
    // Base 置顶规则保留（显式 Base 永远第一，拖拽排其余条件）
    var first = [], rest = [];
    all.forEach(function (c) {
      var p = prefs[c.name.toLowerCase()];
      if (p && p.first) first.push(c);
      else rest.push(c);
    });
    return first.concat(rest);
  }

  function updateCondCount(data, prefs) {
    var el = $('cond-count');
    if (!el) return;
    var checked = 0;
    var firstName = null;
    data.conditions.forEach(function (c) {
      var p = prefs[c.name.toLowerCase()];
      if (p && p.checked) checked++;
      if (p && p.first) firstName = p.displayName || c.name;
    });
    // i18n：动态文案英文态整句翻译
    el.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en')
      ? 'Selected ' + checked + ' / ' + data.conditions.length + ' conditions'
      : '已选择 ' + checked + ' / ' + data.conditions.length + ' 个条件';
    var hint = $('cond-first-hint');
    if (hint) hint.textContent = firstName
      ? (typeof I18N !== 'undefined' && I18N.getLang() === 'en' ? 'Current Base: ' + firstName : '当前Base：' + firstName)
      : (typeof I18N !== 'undefined' && I18N.getLang() === 'en' ? 'No base condition' : '未设Base条件'); // 第十九批：取消后无对比
  }

  /* ================================================================
   * 页面导航区块（第三批）：区块锚点 + 已勾选条件快速跳转
   *   conditions 为 null = 未加载文件（显示占位）；空数组 = 有文件但无勾选
   * ================================================================ */
  function renderPageNav(conditions, opts) {
    opts = opts || {};
    var nav = $('page-nav');
    if (!nav) return;
    nav.innerHTML = '';
    if (conditions === null || conditions === undefined) {
      var empty = document.createElement('div');
      empty.className = 'nav-empty';
      empty.textContent = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'Load a file for quick navigation' : '加载文件后可快速跳转';
      nav.appendChild(empty);
      return;
    }
    // 区块锚点（第五批：S4 已并入详情卡，移除 JV 曲线锚点）
    var navEn = (typeof I18N !== 'undefined' && I18N.getLang() === 'en'); // i18n：页面导航锚点
    var secDefs = [
      { id: '', label: navEn ? '⇧ Top' : '⇧ 顶部', top: true },
      { id: 'sec-summary', label: navEn ? 'Summary & Charts' : '汇总与图表' },
      { id: 'sec-detail', label: navEn ? 'Per-condition details' : '各条件详情表' }
    ];
    secDefs.forEach(function (d) {
      var a = document.createElement('div');
      a.className = 'nav-section';
      a.textContent = d.label;
      a.dataset.section = d.id;
      a.addEventListener('click', function () {
        var el = d.id ? document.getElementById(d.id) : document.body;
        if (el) navScrollTo(el);
      });
      nav.appendChild(a);
    });
    // 条件快速跳转（按显示顺序、已勾选）
    if (conditions.length) {
      var title = document.createElement('div');
      title.className = 'nav-title';
      title.textContent = navEn ? 'Jump to condition' : '跳转条件';
      nav.appendChild(title);
      var condWrap = document.createElement('div');
      condWrap.className = 'nav-conditions';
      conditions.forEach(function (cond, i) {
        var row = document.createElement('div');
        row.className = 'nav-cond';
        row.title = navEn ? ('Jump to "' + cond.displayName + '" details') : ('跳转到「' + cond.displayName + '」详情表');
        var dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = opts.colorOf ? opts.colorOf(i) : '#cccccc';
        row.appendChild(dot);
        var name = document.createElement('span');
        name.textContent = cond.displayName;
        row.appendChild(name);
        row.addEventListener('click', function () {
          var el = document.getElementById('detail-card-' + i);
          if (el) navScrollTo(el);
        });
        condWrap.appendChild(row);
      });
      nav.appendChild(condWrap);
    }
  }

  /** 平滑滚动到目标并闪烁落点（第三批） */
  function navScrollTo(el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1150);
  }

  global.JVUI = {
    renderFileTabs: renderFileTabs,
    renderParseSummary: renderParseSummary,
    renderWarnBar: renderWarnBar,
    hideWarnBar: hideWarnBar,
    renderConditionPanel: renderConditionPanel,
    orderConditions: orderConditions,
    updateCondCount: updateCondCount,
    renderPageNav: renderPageNav,
    navScrollTo: navScrollTo
  };
})(typeof window !== 'undefined' ? window : globalThis);
