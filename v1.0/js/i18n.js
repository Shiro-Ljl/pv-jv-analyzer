/* pv-jv-analyzer · 国际化（i18n）模块
 * 架构：集中式词典（zh/en 两套）+ data-i18n 属性替换（静态 DOM）+ I18N.t() 动态文案（JS 字符串）
 * 切换：工具栏按键（中/EN）；localStorage 'pv_jv_lang' 持久化；默认 zh。
 * 静态节点：<span data-i18n="key">中</span> / <span data-i18n-attr="title" data-i18n="key">…
 * 动态整句：I18N.tr(msg)（showToast 等运行时文案，匹配已知中文句 → 英文）
 */
(function (global) {
  'use strict';

  /* ---------------- 词典（zh/en） ---------------- */
  var DICT = {
    /* ===== 工具栏 ===== */
    'toolbar.title': { zh: 'JV 数据分析工具', en: 'JV Data Analyzer' },
    'doc.title': { zh: '钙钛矿太阳能电池 JV 数据分析工具 v1.1', en: 'Perovskite Solar Cell JV Data Analyzer v1.1' }, // t109：标签页标题（zh 侧与 index.html <title> 原文逐字一致）
    'toolbar.addFiles': { zh: '＋ 添加文件', en: '+ Add Files' },
    'toolbar.addFilesTitle': { zh: '选择 CSV/TXT 文件（可多选）', en: 'Select CSV/TXT files (multiple allowed)' },
    'toolbar.dropHint': { zh: '拖入 CSV / TXT', en: 'Drop CSV / TXT' }, // t109：精简（title 提示详细说明）
    'toolbar.equiv': { zh: '⚡ 表观诊断', en: '⚡ Diagnostics' }, // t109：紧凑图标按钮（title 保留说明）
    'toolbar.equivTitle': { zh: '表观参数与迟滞诊断：4 张参数分布图（Rs/Rsh/n/J₀）+ 逐条件参考性诊断（表观参数，工程筛选用）', en: 'Apparent parameter & hysteresis diagnostics: 4 distribution charts (Rs/Rsh/n/J₀) + per-condition screening notes' },
    'toolbar.corr': { zh: '🔗 相关性', en: '🔗 Corr.' }, // t109：紧凑
    'toolbar.corrTitle': { zh: '参数相关性分析：8×8 相关性矩阵热图 + 点击格联动散点（含拟合线）', en: 'Parameter correlation: 8×8 matrix heatmap + click-through scatter (with fit line)' },
    'toolbar.exportPdf': { zh: '⤓ PDF', en: '⤓ PDF' }, // t109：紧凑
    'toolbar.nameGroups': { zh: '🧩 分组', en: '🧩 Groups' }, // t109：紧凑
    'toolbar.nameGroupsTitle': { zh: '条件分组：按名字归组（自动分组/手动画板框选），同条件多次测量合并统计', en: 'Condition grouping: group by name (auto or manual board), repeated runs of one condition are merged' },
    'nameBlocks.summary': { zh: '个名字归为', en: 'names grouped into' },
    'nameBlocks.cond': { zh: '条件', en: 'Condition' },
    'nameBlocks.channel': { zh: '通道·次数', en: 'Channel' },
    'nameBlocks.seq': { zh: '序号', en: 'Sequence' },
    'nameBlocks.direction': { zh: '方向', en: 'Direction' },
    'nameBlocks.ignored': { zh: '忽略', en: 'Ignore' },
    'nameBlocks.auto': { zh: '还原自动', en: 'Auto' },
    'nameBlocks.thisCond': { zh: '这是条件', en: 'This is the condition' },
    'nameBlocks.thisChannel': { zh: '这是通道·次数', en: 'This is the channel / count' },
    'nameBlocks.thisDir': { zh: '这是方向', en: 'This is the direction' },
    'nameBlocks.ignore': { zh: '忽略此块', en: 'Ignore this block' },
    'nameBlocks.autoBack': { zh: '还原自动', en: 'Back to auto' },
    'nameBlocks.condName': { zh: '条件名', en: 'Condition' },
    'nameBlocks.count': { zh: '测量数', en: 'Measurements' },
    'nameBlocks.example': { zh: '示例', en: 'Example' },
    'bg.title': { zh: '分组候选', en: 'Group candidates' },
    'bg.merge': { zh: '归并', en: 'Merge' },
    'bg.exclude': { zh: '排除', en: 'Exclude' },
    'bg.detail': { zh: '详情', en: 'Details' },
    'bg.applyTemplate': { zh: '套用当前模板', en: 'Apply current template' },
    'bg.oneByOne': { zh: '逐条', en: 'One by one' },
    'bg.mergeAsCond': { zh: '合并为条件', en: 'Merge into one condition' },
    'bg.keepSplit': { zh: '保持分开', en: 'Keep separate' },
    'bg.rename': { zh: '重命名组', en: 'Rename group' },
    'bg.applyAll': { zh: '应用规则到全部', en: 'Apply to all' },
    'bg.restoreGroup': { zh: '还原此组', en: 'Restore this group' }, // t95：单组复原（取消该组操作）
    'bg.applied': { zh: '已应用', en: 'Applied' },
    'bg.emptySystem': { zh: '检测到 N 条未命名记录（仪器默认序号名）——建议在仪器软件中设置条件名后重新导出；也可以框选右侧卡片手动分组。', en: 'N unnamed records detected (instrument default sequence names) — set condition names in the instrument software and re-export; or box-select cards to group manually.' },
    'bg.members': { zh: '成员', en: 'Members' },
    'bg.mergeNote': { zh: '合并为条件', en: 'Merge into a condition' },
    'bg.newName': { zh: '新组名', en: 'New group name' },
    'bg.confirm': { zh: '确定', en: 'OK' },
    'nameBoard.viewAuto': { zh: '自动分组', en: 'Auto groups' },
    'nameBoard.viewManual': { zh: '手动分组画板', en: 'Manual board' },
    'nameBoard.search': { zh: '搜索名字…', en: 'Search names…' },
    'nameBoard.onlyUn': { zh: '仅显示未分组', en: 'Ungrouped only' },
    'nameBoard.selAll': { zh: '全选', en: 'Select all' },
    'nameBoard.clear': { zh: '清除', en: 'Clear' },
    'nameBoard.undo': { zh: '撤销', en: 'Undo' },
    'nameBoard.group': { zh: '归为一组', en: 'Group into one' },
    'nameBoard.groupName': { zh: '组名（默认=第一张选中卡）', en: 'Group name (default = first selected card)' },
    'nameBoard.persist': { zh: '保存规则（下次导入自动应用）', en: 'Save rule (auto-apply on next import)' },
    'nameBoard.removeMember': { zh: '移出', en: 'Remove' }, // t113：成员清单面板「移出」按钮（单项还原为独立卡）
    'nameBoard.meas': { zh: '测量', en: 'meas' },
    'nameGuide.title': { zh: '名字理解向导', en: 'Name Reading Guide' },
    'nameGuide.step1': { zh: '我读到的东西', en: 'What I read' },
    'nameGuide.step1Desc': { zh: '我把名字切成小块，标注常见含义（条件/通道/序号/方向）——名字本身不会改变。', en: 'I split the names into blocks and label common meanings (condition / channel / sequence / direction) — names are never changed.' },
    'nameGuide.step2': { zh: '确认分组', en: 'Confirm grouping' },
    'nameGuide.step2Desc': { zh: '这些名字里，哪一部分表示不同的「条件」？（条件：你想放在一起比较的样品/工艺）', en: 'Which part of these names means a different "condition"? (A condition is the sample / recipe you want to compare together.)' },
    'nameGuide.optRecommended': { zh: '工具推荐的（条件名是这部分名字）', en: 'Recommended by the tool (this part is the condition)' },
    'nameGuide.optWhole': { zh: '整段名字就是条件（每条测量独立）', en: 'The whole name is the condition (each measurement separate)' },
    'nameGuide.optNone': { zh: '都不是，我来手动指定', en: 'None of these — I will assign manually' },
    'nameGuide.modeCard1': { zh: '每条件一个名字', en: 'One name per condition' },
    'nameGuide.modeCard2': { zh: '一条件多次测量', en: 'One condition, many measurements' },
    'nameGuide.modeCard3': { zh: '批次两段式', en: 'Batch two-part names' },
    'nameGuide.modeCard1Desc': { zh: '每个名字都是单独条件（不合并）', en: 'Each name is its own condition (no merging)' },
    'nameGuide.modeCard2Desc': { zh: '名字前缀相同即同一条件（推荐）', en: 'Names sharing a prefix form one condition (recommended)' },
    'nameGuide.modeCard3Desc': { zh: '批次号 + 编号两部分', en: 'Batch code + number, two parts' },
    'nameGuide.step3': { zh: '合并预览', en: 'Merge preview' },
    'nameGuide.confirm': { zh: '放心，就这样', en: 'Looks good, apply' },
    'nameGuide.review': { zh: '我再看看', en: 'Let me review' },
    'nameGuide.keep': { zh: '保持原样', en: 'Keep as-is' },
    'nameGuide.back': { zh: '上一步', en: 'Back' },
    'nameGuide.next': { zh: '下一步', en: 'Next' },
    'nameGuide.cancel': { zh: '取消', en: 'Cancel' },
    'nameGuide.skip': { zh: '不再提示', en: 'Don’t ask again' },
    'nameGuide.skipReset': { zh: '重置「不再提示」', en: 'Reset "don\'t ask again"' },
    'namePreview.title': { zh: '条件分组', en: 'Condition Grouping' },
    'nameGroups.help': { zh: 'ℹ 说明', en: 'ℹ Help' },
    'nameGroups.helpTitle': { zh: '查看使用说明：怎么分组、三个概念、常见问题', en: 'Usage guide: how grouping works, key concepts, FAQ' },
    'namePreview.desc': { zh: '按名字条件分组：自动分组或手动画板框选归组；同条件多次测量合并统计。', en: 'Multi-template or low-confidence naming detected: confirm template-based merging (condition = key block, channels merged into devices), or keep as-is.' },
    'namePreview.keep': { zh: '全部保持原样', en: 'Keep all as-is' },
    'namePreview.apply': { zh: '应用', en: 'Apply' },
    'namePreview.clear': { zh: '恢复原始分组', en: 'Restore original' }, // t75：清除规则改为恢复原始分组（清规则+还原数据，应用可逆）
    'namePreview.colName': { zh: '名称', en: 'Name' },
    'namePreview.colCond': { zh: '条件', en: 'Condition' },
    'namePreview.colCh': { zh: '通道', en: 'Channel' },
    'namePreview.colDir': { zh: '方向', en: 'Direction' },
    'namePreview.colTpl': { zh: '模板', en: 'Template' },
    'toolbar.exportPdfTitle': { zh: '导出 PDF：标题 + 汇总表 + 合并图 + 各条件详情表（window.print 另存为 PDF）', en: 'Export PDF: title + summary + charts + per-condition details (via print dialog)' },
    'toolbar.exportHtml': { zh: '⤓ HTML', en: '⤓ HTML' }, // t109：紧凑
    'toolbar.exportHtmlTitle': { zh: '导出当前数据+格式+状态为单文件 HTML，双击即看（请使用发布版单文件）', en: 'Export current data/format/state as a single-file HTML archive' },

    /* ===== 条件面板 ===== */
    'cond.label': { zh: '条件', en: 'Condition' },
    'cond.merge': { zh: '☰ 整理', en: '☰ Group' },
    'cond.mergeSelected': { zh: '合并所选（0）', en: 'Merge selected (0)' },
    'cond.mergeExit': { zh: '退出', en: 'Exit' },
    'cond.baseMark': { zh: '未设首个条件', en: 'No base condition set' },

    /* ===== 视图标签 ===== */
    'view.single': { zh: '单张箱线', en: 'Single Boxplots' },
    'view.singleTitle': { zh: '四张单图（PCE/Voc/Jsc/FF）', en: 'Separate boxplots (PCE/Voc/Jsc/FF)' },
    'view.combined': { zh: '合并箱线', en: 'Combined 2×2' },
    'view.combinedTitle': { zh: '2×2 合并箱线图', en: '2×2 combined boxplots' },
    'view.jv': { zh: 'JV 叠加', en: 'JV Overlay' },
    'view.jvTitle': { zh: '多条件最高器件 JV 曲线叠加（可切方向/筛条件）', en: 'Overlaid best-device JV curves (direction/condition filterable)' },

    /* ===== 汇总 / 详情区 ===== */
    'summary.title': { zh: '汇总与图表', en: 'Summary & Charts' },
    'summary.tableTitle': { zh: '各条件最高值与平均值汇总', en: 'Per-condition max & average summary' },
    'summary.charts': { zh: '图表', en: 'Charts' },
    'detail.title': { zh: '各条件详情表（反扫参数 + HI）', en: 'Per-condition details (reverse-scan params + HI)' },

    /* ===== 空状态 ===== */
    'empty.dropCsv': { zh: '把 CSV / TXT 拖到这里，或点击「添加文件」', en: 'Drag CSV / TXT here, or click "Add Files"' },
    'empty.steps': { zh: '① 拖入仪器导出的数据文件 → ② 勾选要对比的条件 → ③ 复制图表进 PPT', en: '① Drop exported data files → ② Select conditions to compare → ③ Copy charts into your report' },
    'empty.dropMask': { zh: '松开以载入文件', en: 'Release to load' },

    /* ===== 弹窗通用 ===== */
    'common.cancel': { zh: '取消', en: 'Cancel' },
    'modal.importTitle': { zh: '导入文件', en: 'Import File' },
    'modal.split': { zh: '分开两页', en: 'Open Separately' },
    'modal.combine': { zh: '合并绘制', en: 'Merge & Plot' },
    'modal.groupTitle': { zh: '条件合并建议', en: 'Condition Merge Suggestion' },
    'modal.groupMsg': { zh: '检测到以下条件名可能是同一条件的系列命名（如 PVK-1、PVK-2 同属 PVK）。请决定合并为一个条件统计，还是保持分开：', en: 'These condition names may be series of the same material (e.g. PVK-1, PVK-2 both PVK). Merge them into one condition or keep them separate:' },
    'modal.keepAll': { zh: '全部保持', en: 'Keep All' },
    'modal.mergeAll': { zh: '全部合并', en: 'Merge All' },
    'modal.apply': { zh: '应用', en: 'Apply' },
    'modal.mergeTitle': { zh: '合并条件', en: 'Merge Conditions' },
    'modal.mergeName': { zh: '合并后的条件名', en: 'Merged condition name' },
    'modal.merge': { zh: '合并', en: 'Merge' },

    /* ===== PDF / 导出弹窗 ===== */
    'export.pdfTitle': { zh: '导出 PDF', en: 'Export PDF' },
    'export.exportBtn': { zh: '导出', en: 'Export' },
    'pdf.titleLabel': { zh: '标题（必填，同时用于文件名）', en: 'Title (required; also used as filename)' },
    'pdf.noteLabel': { zh: '备注（可空，可多行）', en: 'Notes (optional, multi-line)' },
    'pdf.contentLabel': { zh: '内容选项', en: 'Content options' },
    'pdf.equivLabel': { zh: '包含表观参数诊断数据（汇总后、详情前插入诊断页）', en: 'Include apparent-parameter diagnostics page (after summary, before details)' },

    /* ===== 表观参数弹窗 ===== */
    'equiv.title': { zh: '⚡ 表观参数与迟滞诊断（工程筛选）', en: '⚡ Apparent Parameters & Hysteresis (screening)' },
    'equiv.help': { zh: '⚠ 说明（必读）', en: '⚠ Help (read first)' },
    'equiv.fmtHint': { zh: '本页 4 图的字号/线宽/透明度可单独调整（点「🎨 格式」）；「诊断阈值」（迟滞差 Δn/Δlog₁₀J₀）、Rs 修正开关与测试温度也在其中，改动后诊断卡与图即时更新。Rs/Rsh 为仪器给定值（面积归一化口径见说明）；主题色随主图「⚙ 调整格式」。', en: 'Font size / line width / alpha of the 4 charts here are adjustable individually ("🎨 Style"); the "diagnostic thresholds" (hysteresis Δn / Δlog₁₀J₀), Rs-correction switch and test temperature are there too — diagnostic cards and charts update immediately. Rs/Rsh are instrument-given values (area-normalized basis, see help). Theme color follows the main chart "⚙ Adjust style".' },
    'equiv.cardsTitle': { zh: '逐条件诊断卡', en: 'Per-condition diagnostic cards' },
    'equiv.baseLabel': { zh: 'Base 条件', en: 'Base condition' },
    'equiv.baseHint': { zh: '诊断与建议均相对该 Base 生成（切换后诊断卡随之更新）', en: 'Diagnostics are relative to this Base (cards update on change)' },
    'equiv.figRs': { zh: 'Rs 分布', en: 'Rs distribution' },
    'equiv.figRsh': { zh: 'Rsh 分布（log 坐标）', en: 'Rsh distribution (log scale)' },
    'equiv.figN': { zh: '理想因子 n 分布', en: 'Ideality factor n distribution' },
    'equiv.figJ0': { zh: 'log₁₀(J₀) 分布', en: 'log₁₀(J₀) distribution' },
    'style.equivFormat': { zh: '🎨 格式', en: '🎨 Style' },

    /* ===== 语言切换与通用 ===== */
    'lang.switch': { zh: '切换语言', en: 'Switch language' },
    'lang.zh': { zh: '中文', en: 'Chinese' },
    'lang.en': { zh: '英文', en: 'English' },
    'cond.parseSummary': { zh: '解析状态摘要', en: 'Parsed data summary' },
    'common.collapse': { zh: '收起/展开', en: 'Collapse / expand' },
    'common.closeEsc': { zh: '关闭（Esc）', en: 'Close (Esc)' },
    'common.close': { zh: '关闭', en: 'Close' },
    'style.equivFormatTitle': { zh: '单独调整本页 4 张图的字号/线宽/透明度（与主图格式并存）', en: 'Adjust font size / line width / opacity of the 4 charts on this page (stored alongside the main chart style)' },
    'equiv.helpTitle': { zh: '查看分析说明：方法局限、迟滞与扫描速度影响——读数前请先读', en: 'Read the analysis notes: method limits, hysteresis & scan-rate effects — read before interpreting' },
    'lightbox.resetTitle': { zh: '恢复到 1x 居中', en: 'Reset to 1x & center' },
    'corr.modeTitle': { zh: 'n/J₀ 取数口径：汇总=正反扫拟合平均（默认）；反扫/正扫=仅用该方向。PCE/Voc/Jsc/FF 始终反扫优先。单扫器件在非对应口径下不参与 n/J₀ 相关。', en: 'n/J₀ basis: Summary = average of fwd+rev fits (default); Reverse/Forward = that direction only. PCE/Voc/Jsc/FF always prefer reverse. Single-scan devices are excluded from n/J₀ when the required direction is missing.' },

    /* ===== 灯箱 ===== */
    'lightbox.close': { zh: '关闭（Esc）', en: 'Close (Esc)' },
    'lightbox.zoomIn': { zh: '放大', en: 'Zoom in' },
    'lightbox.zoomOut': { zh: '缩小', en: 'Zoom out' },
    'lightbox.reset': { zh: '重置', en: 'Reset' },
    'lightbox.copy': { zh: '⧉ 复制图片', en: '⧉ Copy Image' },
    'lightbox.downloadSvg': { zh: '⤓ 下载矢量图', en: '⤓ Download SVG' },

    /* ===== 样式编辑器 ===== */
    'style.title': { zh: '调整图像格式', en: 'Adjust Chart Style' },
    'style.single': { zh: '单图', en: 'Single' },
    'style.combined': { zh: '合并图', en: 'Combined' },
    'style.jv': { zh: 'JV', en: 'JV' },
    'style.jvOverlay': { zh: 'JV 叠加', en: 'JV Overlay' },
    'style.copy': { zh: '⧉ 复制图片', en: '⧉ Copy Image' },
    'style.downloadSvg': { zh: '⤓ 下载矢量图', en: '⤓ Download SVG' },
    'style.reset': { zh: '↺ 恢复默认', en: '↺ Reset Defaults' },

    /* ===== 相关性弹窗 ===== */
    'corr.title': { zh: '🔗 参数相关性分析', en: '🔗 Parameter Correlation Analysis' },
    'corr.sub': { zh: 'Pearson 相关 r（* p<0.05，** p<0.01，*** p<0.001；n = 成对有效器件数）。点击矩阵格查看对应散点；下方勾选条件可只看部分条件。', en: 'Pearson correlation r (* p<0.05, ** p<0.01, *** p<0.001; n = paired devices). Click a matrix cell for its scatter; filter by condition below.' },
    'corr.selectAll': { zh: '全选', en: 'Select All' },
    'corr.clear': { zh: '清空', en: 'Clear' },
    'corr.modeLabel': { zh: 'n/J₀ 口径', en: 'n/J₀ basis' },
    'corr.modeAvg': { zh: '平均（汇总）', en: 'Average (summary)' },
    'corr.modeRev': { zh: '反扫', en: 'Reverse scan' },
    'corr.modeFwd': { zh: '正扫', en: 'Forward scan' },
    'corr.matrixTitle': { zh: '相关性矩阵', en: 'Correlation matrix' },
    'corr.summaryTitle': { zh: '参考性结论', en: 'Reference conclusions' },

    /* ===== 帮助弹窗 ===== */
    'help.title': { zh: '分析说明', en: 'Help' },

    /* ===== 样式编辑器（buildStyleConsole 词条） ===== */
    'st.xTick': { zh: 'X 刻度字号', en: 'X tick size' },
    'st.yTick': { zh: 'Y 刻度字号', en: 'Y tick size' },
    'st.titleFs': { zh: '标题字号', en: 'Title size' },
    'st.titleBold': { zh: '标题加粗', en: 'Bold title' },
    'st.axisW': { zh: '边框线宽', en: 'Axis width' },
    'st.axisColor': { zh: '边框颜色', en: 'Axis color' },
    'st.tickColor': { zh: '刻度线颜色', en: 'Tick color' },
    'st.labelColor': { zh: '标签颜色', en: 'Label color' },
    'st.groupBox': { zh: '箱线图', en: 'Boxplot' },
    'st.boxFill': { zh: '填充透明度', en: 'Box alpha' },
    'st.boxW': { zh: '描边宽度', en: 'Border width' },
    'st.boxDark': { zh: '描边加深', en: 'Border darken' },
    'st.rawPts': { zh: '原始数据点', en: 'Raw points' },
    'st.rawSize': { zh: '数据点大小', en: 'Point size' },
    'st.meanMark': { zh: '均值标记', en: 'Mean marker' },
    'st.meanSize': { zh: '均值大小', en: 'Mean size' },
    'st.meanColor': { zh: '均值颜色', en: 'Mean color' },
    'st.meanDark': { zh: '均值描边加深', en: 'Mean border darken' },
    'st.xGap': { zh: 'X 标签间距', en: 'X label gap' },
    'st.yGap': { zh: 'Y 标签间距', en: 'Y label gap' },
    'st.xRot': { zh: 'X 标签旋转', en: 'X label rotate' },
    'st.xOffset': { zh: 'X 标签偏移', en: 'X label offset' },
    'st.groupAxis': { zh: '坐标轴', en: 'Axes' },
    'st.groupLayout': { zh: '布局', en: 'Layout' },
    'st.gutter': { zh: '中缝(百分比)', en: 'Gutter (%)' },
    'st.vgap': { zh: '行距', en: 'Row gap' },
    'st.padTop': { zh: '上留白', en: 'Top padding' },
    'st.padBottom': { zh: '下留白基数', en: 'Bottom padding base' },
    'st.palette': { zh: '调色板', en: 'Palette' },
    /* 坐标轴/布局/JV 词条 */
    'st.axisYPos': { zh: 'Y 标题位置', en: 'Y title position' },
    'st.axisXPos': { zh: 'X 标题位置', en: 'X title position' },
    'st.axisPerKey': { zh: '坐标轴 · 合并图按参数（单独设 Y 范围）', en: 'Axes · combined per-parameter (Y range)' },
    'st.axisJvX': { zh: '坐标轴 · JV 横轴', en: 'Axes · JV x-axis' },
    'st.layoutSingle': { zh: '布局 · 单图', en: 'Layout · single' },
    'st.padTop2': { zh: '上留白', en: 'Top padding' },
    'st.padRight': { zh: '右留白', en: 'Right padding' },
    'st.padBottom2': { zh: '下留白基数', en: 'Bottom padding base' },
    'st.layoutJv': { zh: '布局 · JV', en: 'Layout · JV' },
    'st.jvPlotW': { zh: 'JV 绘图区宽', en: 'JV plot width' },
    'st.layoutComb': { zh: '布局 · 合并图', en: 'Layout · combined' },
    'st.vgap2': { zh: '行距', en: 'Row gap' },
    'st.jvGroup': { zh: 'JV 曲线', en: 'JV curves' },
    'st.jvRevW': { zh: '反扫线宽', en: 'Reverse width' },
    'st.jvFwdW': { zh: '正扫线宽', en: 'Forward width' },
    'st.jvFwdDash': { zh: '正扫线型', en: 'Forward dash' },
    'st.jvRefLine': { zh: '参考线', en: 'Ref line' },
    'st.jvLegend': { zh: '图例', en: 'Legend' },
    'st.jvLegendFs': { zh: '图例字号', en: 'Legend size' },
    'st.jvLegendX': { zh: '图例水平偏移', en: 'Legend offset X' },
    'st.jvLegendY': { zh: '图例垂直偏移', en: 'Legend offset Y' },
    'st.axisCommon': { zh: '坐标轴', en: 'Axes' },
    'st.titleGapY': { zh: 'Y 标题间距', en: 'Y title gap' },
    'st.titleGapX': { zh: 'X 标题间距', en: 'X title gap' },
    /* 条件面板/杂项 */
    'cond.mergeSelected2': { zh: '合并所选', en: 'Merge selected' },
    'cond.exit': { zh: '退出', en: 'Exit' },
    'cond.mergeModeTitle': { zh: '勾选多个条件合并为一个统计；已合并条件可拆分', en: 'Select conditions to merge into one statistic; merged conditions can be split' }
  };

  /* ---------------- 运行时整句翻译表（showToast 等动态文案） ---------------- */
  var SENT = [
    ['请先加载数据并勾选条件', 'Please load data and select conditions first'],
    ['请填写标题', 'Please enter a title'],
    ['表格已复制，可直接粘贴到 Excel', 'Table copied — paste into Excel directly'],
    ['请输入合并后的条件名', 'Please enter a merged condition name'],
    ['已合并为「', 'Merged as "'],
    ['已拆分「', 'Split "'],
    ['当前为开发版页面，导出的 HTML 可能无法离线打开——请使用发布版单文件后再导出', 'Development build: exported HTML may not open offline — use the packaged single-file build'],
    ['导出 HTML 失败：', 'Export HTML failed: '],
    ['图表渲染失败：', 'Chart render failed: '],
    ['读取文件失败：', 'File read failed: '],
    ['无法解析「', 'Cannot parse "'],
    ['已存在同名文件「', 'Duplicate file "'],
    ['，已跳过', ' — skipped'],
    ['」：不是支持的仪器原始格式或处理后格式', '": not a recognized instrument-raw or processed format'],
    ['设为Base', 'Set as Base'],
    ['★ Base', '★ Base'],
    ['设为基准条件（Base）：排到最前，并作为汇总表平均值对比的基准；单选', 'Set as base condition: ranks first and serves as the comparison baseline in the summary table (single-select)'],
    // 排序注意：长条目在前（「请先加载数据（含 Rs/Rsh 列）」「请先加载数据并勾选条件」须先于「请先加载数据」匹配）
    ['请先加载数据（含 Rs/Rsh 列）', 'Please load data first (with Rs/Rsh columns)'],
    ['请先加载数据', 'Please load data first'],
    ['请先勾选至少一个条件', 'Please check at least one condition'],
    ['至少保留一个条件', 'Keep at least one condition'],
    ['Rs 修正后本批数据无有效拟合（修正量过大）——建议关闭 Rs 修正', 'After Rs correction this batch has no valid fits (correction too large) — please turn Rs correction off'],
    ['放大渲染失败：', 'Zoom render failed: '],
    ['图片已复制，可直接 Ctrl+V 粘贴进 PPT', 'Image copied — paste into PPT with Ctrl+V'],
    ['图表导出失败：SVG 转图片出错', 'Chart export failed: SVG rasterization error'],
    ['剪贴板不可用，已改为下载 PNG 图片', 'Clipboard unavailable — downloaded PNG instead'],
    ['图片导出失败', 'Image export failed'],
    // 兜底：'」' 闭合引号（须排在所有含 '」' 前缀的长条目之后；「」→ "" 配对）
    ['」', '"']
  ];

  /* ---------------- 语言状态 ---------------- */
  var LANG_KEY = 'pv_jv_lang';
  var current = 'zh';
  try { var saved = localStorage.getItem(LANG_KEY); if (saved === 'en' || saved === 'zh') current = saved; } catch (e) {}
  // i-5：本机无语言记录时回读取档语言。优先级设计：本机 localStorage 偏好 > 存档 lang（英文态留档在中文同事
  // 电脑上打开仍随本机偏好；清缓存/新电脑则还原导出时语言）。__SAVED__ 注入于 <head> 首个 script 之前
  // （main.js exportHtml L1805），i18n.js 为打包首脚本，执行时必已就绪，可同步读取。旧产物无 lang 字段 → 跳过。
  if (saved !== 'en' && saved !== 'zh') {
    try { var savedLang = global.__SAVED__ && global.__SAVED__.lang; if (savedLang === 'en' || savedLang === 'zh') current = savedLang; } catch (e) {}
  }
  // i-4：初始即同步 <html lang>（此前仅 setLang 设置，刷新后语言恢复 en 而 docLang 滞留 zh-CN，影响无障碍/拼写检查）
  try { document.documentElement.setAttribute('lang', current === 'zh' ? 'zh-CN' : 'en'); } catch (e) {}

  /* ---------------- API ---------------- */
  function t(key, lang) {
    var entry = DICT[key];
    if (!entry) return key;
    var want = lang || current;
    if (entry[want] != null) return entry[want];
    if (entry[want === 'en' ? 'zh' : 'en'] != null) return entry[want === 'en' ? 'zh' : 'en'];
    return key;
  }

  /** 运行时整句翻译（动态文案）：英文态匹配已知中文句 → 英文；未匹配原样返回 */
  function tr(msg) {
    if (current === 'zh' || !msg) return msg;
    // 连续替换全部已知段：多段拼接消息（如「已存在同名文件…，已跳过」）整句翻译，不留中文尾巴
    for (var i = 0; i < SENT.length; i++) {
      if (msg.indexOf(SENT[i][0]) >= 0) {
        msg = msg.replace(SENT[i][0], SENT[i][1]);
      }
    }
    return msg;
  }

  /** 处理 DOM 内所有 [data-i18n]（文本）与 [data-i18n-title]/[data-i18n-attr]（属性） */
  function applyTo(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n], [data-i18n-title]') : [];
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      // 独立 title key（data-i18n-title）：文本与 title 不同词时用；仅 title 元素（如语言切换/解析摘要）不动文本
      var titleKey = el.getAttribute('data-i18n-title');
      if (titleKey && DICT[titleKey]) { el.setAttribute('title', t(titleKey)); } // N5：词典缺键保留原 title，防键名外显
      if (!key) return;
      if (!DICT[key]) return; // N5：缺键保留 HTML 原文（t() 缺键返回键名，直接赋值会覆盖中文默认文案）
      var val = t(key);
      var attr = el.getAttribute('data-i18n-attr');
      if (attr) { el.setAttribute(attr, val); return; } // 兼容旧式 data-i18n-attr（同词双态）
      el.textContent = val;
    });
  }

  /** 切换语言并广播（静态 DOM 立即重绘；动态区域由监听方重渲染） */
  function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    current = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.title = t('doc.title'); // i-3：标签页标题跟随语言
    // 分段语言切换器激活态（btn-lang-zh / btn-lang-en）
    var bz = document.getElementById('btn-lang-zh'), be = document.getElementById('btn-lang-en');
    if (bz) bz.classList.toggle('active', lang === 'zh');
    if (be) be.classList.toggle('active', lang === 'en');
    applyTo(document);
    try { global.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: lang } })); } catch (e) {}
  }

  function getLang() { return current; }

  global.I18N = { t: t, tr: tr, applyTo: applyTo, setLang: setLang, getLang: getLang, DICT: DICT, SENT: SENT };

  // 初始应用词条：data-i18n 空元素（如 drop zone 引导文案）须首次加载即填充；
  // 此前 applyTo 仅在 setLang（点击切换）时执行，导致首屏空白、切一次语言才出现。
  function initApply() { applyTo(document); document.title = t('doc.title'); } // i-3：初始加载同步（此前仅静态 <title>，英文用户刷新后标签页仍中文）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApply);
  } else {
    initApply();
  }
})(typeof window !== 'undefined' ? window : globalThis);
