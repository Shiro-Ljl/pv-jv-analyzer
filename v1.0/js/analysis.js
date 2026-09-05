/* V2 · 等效电路分析模板（P1 之"给参考解读"）
 * 根据条件的等效电路参数统计（Rs / Rsh / n / J0，优先中位数），对照 Base 与绝对阈值，
 * 生成「参考性」诊断解读——用于辅助判断，不是最终结论（真实结论需结合实验与原始记录）。
 * 纯函数、无 DOM，可 node 测试。挂 globalThis.JVAnalysis。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    RS_HIGH: 50,      // Rs(仪器单位 ohm) 高于此视为高（面积绑定：A=0.0625 → 3.125 Ω·cm²）
    RSH_LOW: 5000,    // Rsh 低于此视为低（面积绑定：→ 312.5 Ω·cm²）
    RS_HIGH_AREA: 3.125,   // t10（P1-5）：面积归一化阈值 Ω·cm²（=50×0.0625，随掩模面积换算）
    RSH_LOW_AREA: 312.5,   // t10（P1-5）：=5000×0.0625
    N_HIGH: 2.0,      // 表观理想因子高于此视为明显非理想
    J0_HIGH: 1e-5,    // 表观 J0(mA/cm²) 高于此视为偏高（经验阈值/未标定，t10 P1-4）
    RATIO_RS: 1.5,    // 相对 Base 的 Rs 倍数
    RATIO_RSH: 0.6,   // 相对 Base 的 Rsh 倍数（更低）
    N_DELTA: 0.5,     // t7：迟滞差阈值——正/反扫 n 差中位超此值 → 迟滞主警报（t10 P1-3 拆分为 Δn 主警报）
    J0LOG_DELTA: 1.0, // t10（P1-3）：Δlog₁₀J₀ 阈值（默认 1.0 = J₀ 差 10 倍）——仅作支持证据/辅助提示，不单独触发主警报
    WINDOW_SENS: 0.20 // t10（P2-1）：窗口敏感性阈值（n 相对变化 >20% → 窗口敏感）
  };

  function median(arr) {
    if (!arr || !arr.length) return NaN;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** 从解析数据（条件对象）聚合等效电路参数统计（每条件运行一次）。opts={rsCorrect} 透传拟合。 */
  function conditionStats(cond, opts) {
    var rs = [], rsh = [], n = [], j0 = [], pce = [], active = 0, nDiff = [], j0Diff = [], nRev = [], nFwd = [], j0Rev = [], j0Fwd = [], revRs = [], fwdRs = [], nDS = [], j0DS = [], rsArea = [], rshArea = [], nN = [], nDV = [], nSE = [], r2s = [], grades = [], wSens = 0, j0Conf = 0, stepVs = [], delayMs = [], tempCs = [], lightS = [];
    (cond.devices || []).forEach(function (d) {
      if (d.excluded) return; // V2 修正：被排除的器件不计入分析统计（与主功能"排除=不参与统计"一致）
      active++;
      // 仪器 Rs/Rsh（device 级，反扫优先）
      // t10（P2-2）：协议元数据聚合（Step/Delay/Temperature/Light——条件级一致性检查）
      if (isNum(d.stepV)) stepVs.push(d.stepV);
      if (isNum(d.delayMs)) delayMs.push(d.delayMs);
      if (isNum(d.tempDegC)) tempCs.push(d.tempDegC);
      if (isNum(d.lightSun)) lightS.push(d.lightSun);
      if (isNum(d.rsh)) rsh.push(d.rsh);
      if (isNum(d.rs)) rs.push(d.rs);
      // t9（P0-1）：面积归一化 Rs/Rsh（Rs×A，专家审阅确认仪器 Rs 为绝对 Ω 口径）
      if (isNum(d.rsArea)) rsArea.push(d.rsArea);
      if (isNum(d.rshArea)) rshArea.push(d.rshArea);
      // t8-2：方向级 Rs（正扫/反扫各自参数表行值，供诊断卡配对解读）
      if (isNum(d.rev && d.rev.rs)) revRs.push(d.rev.rs);
      if (isNum(d.fwd && d.fwd.rs)) fwdRs.push(d.fwd.rs);
      // 拟合 n/J0（可缺失，不强制）：对每器件跑一次拟合
      if (global.JVFit && d.rev && d.rev.points && d.rev.points.length) {
        var f = global.JVFit.fitDevice(d, opts); // t8：opts 透传 rsCorrect；t9：temperatureK
        if (f && isNum(f.n) && isNum(f.J0)) {
          n.push(f.n); j0.push(f.J0);
          // t10（P1-2）：拟合覆盖率——成功拟合数、质量分级、J₀ 可信（A 级）、窗口敏感
          if (f.grade === 'A') { grades.push('A'); j0Conf++; }
          else if (f.grade === 'B') grades.push('B');
          else grades.push('C');
          if (f.windowSensitive) wSens++;
          if (isNum(f.dN)) nDiff.push(f.dN);      // t7：迟滞差（both 器件）
          if (isNum(f.dLogJ0)) j0Diff.push(f.dLogJ0);
          if (isNum(f.dN_s)) nDS.push(f.dN_s);    // t9（P1-3）：有符号方向差
          if (isNum(f.dLogJ0_s)) j0DS.push(f.dLogJ0_s);
          if (isNum(f.N)) nN.push(f.N);           // t9（P1-4）：质量指标
          if (isNum(f.dV)) nDV.push(f.dV);
          if (isNum(f.se)) nSE.push(f.se);
          if (isNum(f.r2)) r2s.push(f.r2);
          if (isNum(f.n_rev)) nRev.push(f.n_rev); // t7：方向子值（诊断卡展示）
          if (isNum(f.n_fwd)) nFwd.push(f.n_fwd);
          if (isNum(f.J0_rev)) j0Rev.push(f.J0_rev);
          if (isNum(f.J0_fwd)) j0Fwd.push(f.J0_fwd);
        }
      }
      if (global.JVParser && global.JVParser.deviceParam) {
        var pv = global.JVParser.deviceParam(d, 'pce');
        if (isNum(pv)) pce.push(pv);
      }
    });
    return {
      count: active, // 参与统计的器件数（排除后）
      rs: rs, rsh: rsh, n: n, j0: j0, pce: pce,
      rsMed: median(rs), rshMed: median(rsh), nMed: median(n), j0Med: median(j0), pceMed: median(pce),
      // t7：迟滞差聚合（正反扫拟合差异，受扫描速度影响，供同批相对参考）
      nDiff: nDiff, j0Diff: j0Diff, nDMed: median(nDiff), j0DMed: median(j0Diff),
      // t7：方向子值中位数（诊断卡展示 正扫/反扫/平均）
      nRevMed: median(nRev), nFwdMed: median(nFwd), j0RevMed: median(j0Rev), j0FwdMed: median(j0Fwd),
      // t8-2：方向级 Rs 中位（正扫/反扫各自仪器值，诊断卡配对展示）
      revRsMed: median(revRs), fwdRsMed: median(fwdRs),
      // t9（P0-1）：面积归一化中位（Ω·cm² 口径）
      rsAreaMed: median(rsArea), rshAreaMed: median(rshArea),
      // t9（P1-3）：有符号方向差中位 + 系统性方向统计（δn>0 = 正扫更高 的比例）
      dNSMed: median(nDS), dLogJ0SMed: median(j0DS),
      fwdHigherN: nDS.length ? nDS.filter(function (v) { return v > 0; }).length : 0, fwdHigherNTotal: nDS.length,
      // t9（P1-4）：拟合质量指标中位（N=点数、dV=电压跨度、se=斜率标准误、r2=拟合线性）
      nNMed: median(nN), nDVMed: median(nDV), nSEMed: median(nSE), r2MedExtra: median(r2s),
      // t10（P1-2）：拟合覆盖率（防中位质量掩盖尾部）
      fitOk: n.length, fitTotal: active, gradeCounts: { A: grades.filter(function (g) { return g === 'A'; }).length, B: grades.filter(function (g) { return g === 'B'; }).length, C: grades.filter(function (g) { return g === 'C'; }).length },
      j0Confident: j0Conf, windowSensitiveCount: wSens,
      // t10（P2-2）：测量协议元数据中位
      stepVMed: median(stepVs), delayMsMed: median(delayMs), tempDegCMed: median(tempCs), lightSunMed: median(lightS)
    };
  }

  function fmt(v, d) {
    if (!isNum(v)) return '—';
    if (v === 0) return '0';
    if (Math.abs(v) >= 1000 || Math.abs(v) < 0.001) return v.toExponential(1);
    return v.toFixed(d == null ? 1 : d);
  }
  function fmtRsh(v) {
    if (!isNum(v)) return '—';
    return v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0);
  }
  function fmtRs(v) { return isNum(v) ? v.toFixed(1) : '—'; }

  /** 核心：生成参考性诊断。cond/base 为 conditionStats 的返回。opts 可覆盖阈值。 */
  function analyze(cond, base, opts) {
    var T = Object.assign({}, DEFAULTS, opts || {});
    var out = { verdicts: [], advice: [], summary: '', hasIp: false };
    var rsh = cond.rshMed, rs = cond.rsMed, n = cond.nMed, j0 = cond.j0Med;
    // t10（P1-5）：面积归一化阈值优先（Ω·cm² 内部口径，防换掩模忘改阈值）——rsAreaMed/rshAreaMed 有效时用
    var rsEff = isNum(cond.rsAreaMed) ? cond.rsAreaMed : rs;
    var rshEff = isNum(cond.rshAreaMed) ? cond.rshAreaMed : rsh;
    var rsHighT = isNum(cond.rsAreaMed) ? (T.RS_HIGH_AREA != null ? T.RS_HIGH_AREA : 3.125) : T.RS_HIGH;
    var rshLowT = isNum(cond.rshAreaMed) ? (T.RSH_LOW_AREA != null ? T.RSH_LOW_AREA : 312.5) : T.RSH_LOW;

    // 1) 无明显参数：提示用 Base 前先设 Base；若连 rsh/rs 都无 → 返回空
    if (!isNum(rsh) && !isNum(rs)) {
      out.summary = { zh: '该条件缺少 Rs/Rsh 参数（数据未含对应列），暂无法做等效电路诊断。', en: 'This condition lacks Rs/Rsh parameters (columns not present in the data); equivalent-circuit diagnosis unavailable.' };
      return out;
    }

    var hasBase = base && isNum(base.rshMed);

    // Rsh（漏电 / 钝化）——t10：面积归一化口径判定，文案注明 Ω·cm²
    if (isNum(rsh)) {
      var rshLow = rshEff < rshLowT;
      var rshVsBase = hasBase ? (rsh / base.rshMed) : 1;
      var rshUnit = isNum(cond.rshAreaMed) ? ' Ω·cm²' : ' Ω';
      var rshDisp = isNum(cond.rshAreaMed) ? fmtRsh(cond.rshAreaMed) : fmtRsh(rsh);
      if (rshLow && (!hasBase || rshVsBase < T.RATIO_RSH)) {
        out.verdicts.push({ level: 'warn', key: 'rsh',
          text: '并联电阻偏低（' + rshDisp + rshUnit + (hasBase ? '，约为 Base 的 ' + Math.round(rshVsBase * 100) + '%' : '') + '）→ 提示漏电 / 针孔 / 钝化层失效风险，Jsc 与 FF 可能被拉低。建议检查界面钝化层、退火工艺与是否局部短接。',
          textEn: 'Shunt resistance low (' + rshDisp + rshUnit + (hasBase ? ', ≈ ' + Math.round(rshVsBase * 100) + '% of Base' : '') + ') → leakage / pinhole / passivation-failure risk; Jsc and FF may be dragged down. Check interface passivation, annealing and possible local shorts.' });
      } else if (rshVsBase < T.RATIO_RSH && hasBase) {
        out.verdicts.push({ level: 'info', key: 'rsh',
          text: 'Rsh 较 Base 偏低（' + Math.round(rshVsBase * 100) + '%）但未低于绝对阈值（' + fmtRsh(rshLowT) + rshUnit + '）→ 轻微漏电倾向，暂不构成主瓶颈。',
          textEn: 'Rsh slightly below Base (' + Math.round(rshVsBase * 100) + '%) but above the absolute threshold (' + fmtRsh(rshLowT) + rshUnit + ') → mild leakage tendency; not the main bottleneck yet.' });
      } else {
        out.verdicts.push({ level: 'ok', key: 'rsh', text: '并联电阻正常（' + rshDisp + rshUnit + (hasBase ? '，约 Base 的 ' + Math.round(rshVsBase * 100) + '%' : '') + '）→ 漏电风险低。',
          textEn: 'Shunt resistance normal (' + rshDisp + rshUnit + (hasBase ? ', ≈ ' + Math.round(rshVsBase * 100) + '% of Base' : '') + ') → low leakage risk.' });
      }
    }

    // Rs（串联损耗）——V2 收尾：推测性指导 + 保留物理正确（Voc 不直接归因 Rs）
    if (isNum(rs)) {
      var rsHigh = rsEff > rsHighT;
      var rsVsBase = hasBase ? (rs / base.rsMed) : 1;
      var rsUnit = isNum(cond.rsAreaMed) ? ' Ω·cm²' : ' Ω';
      var rsDisp = isNum(cond.rsAreaMed) ? rsEff.toFixed(2) : fmtRs(rs);
      if (rsHigh && (!hasBase || rsVsBase > T.RATIO_RS)) {
        out.verdicts.push({ level: 'warn', key: 'rs',
          text: '串联电阻偏高（' + rsDisp + rsUnit + (hasBase ? '，约为 Base 的 ' + Math.round(rsVsBase * 100) + '%' : '') + '）→ 可能为接触/电极/传输层损耗，通常表现为 FF 与输出功率下降；建议检查正面电极、传输层接触与体串联阻抗。若同时观察到 Voc 下降，可能涉及界面/接触的共同退化，需进一步排查。',
          textEn: 'Series resistance high (' + rsDisp + rsUnit + (hasBase ? ', ≈ ' + Math.round(rsVsBase * 100) + '% of Base' : '') + ') → possible contact / electrode / transport-layer loss, usually shown as lower FF and output power; check front electrode, transport-layer contact and bulk series impedance. If Voc also drops, a common interface/contact degradation may be involved — investigate further.' });
      } else if (rsVsBase > T.RATIO_RS && hasBase) {
        out.verdicts.push({ level: 'info', key: 'rs',
          text: 'Rs 较 Base 偏高（' + Math.round(rsVsBase * 100) + '%）但未超绝对阈值（' + rsHighT.toFixed(2) + rsUnit + '）→ 轻微串联损耗倾向（主要影响 FF）。',
          textEn: 'Rs slightly above Base (' + Math.round(rsVsBase * 100) + '%) but below the absolute threshold (' + rsHighT.toFixed(2) + rsUnit + ') → mild series-resistance tendency (mainly affects FF).' });
      } else {
        out.verdicts.push({ level: 'ok', key: 'rs', text: '串联电阻正常（' + rsDisp + rsUnit + (hasBase ? '，约 Base 的 ' + Math.round(rsVsBase * 100) + '%' : '') + '）。',
          textEn: 'Series resistance normal (' + rsDisp + rsUnit + (hasBase ? ', ≈ ' + Math.round(rsVsBase * 100) + '% of Base' : '') + ').' });
      }
    }

    // t10（P1-3）：迟滞警示拆双阈值——Δn 触发主警报，Δlog₁₀J₀ 仅作支持证据
    // t10（P0-4）：扫描速率对迟滞非单调，跨协议不可比（措辞修正）
    var nHyst = cond.nDMed != null && cond.nDMed > (T.N_DELTA != null ? T.N_DELTA : 0.5);
    var j0Hyst = cond.j0DMed != null && cond.j0DMed > (T.J0LOG_DELTA != null ? T.J0LOG_DELTA : 1.0);
    if (nHyst || j0Hyst) {
      var dirNote = '';
      if (isNum(cond.dNSMed) && cond.fwdHigherNTotal > 0) {
        dirNote = '；有符号 δn 中位 ' + (cond.dNSMed > 0 ? '+' : '') + cond.dNSMed.toFixed(2) + '（正扫更高 ' + cond.fwdHigherN + '/' + cond.fwdHigherNTotal + ' 台' + (cond.fwdHigherN === cond.fwdHigherNTotal ? '，系统性偏正扫' : '，方向不一致') + '）';
      }
      var j0Note = j0Hyst ? '；Δlog₁₀J₀=' + (cond.j0DMed != null ? cond.j0DMed.toFixed(2) : '—') + '（超过辅助阈值 ' + (T.J0LOG_DELTA != null ? T.J0LOG_DELTA : 1.0) + '，J₀ 为外推值仅作支持证据）' : '';
      // i18n：英文版迟滞 verdict（结构与中文一致，数值已拼好）
      var dirNoteEn = '';
      if (isNum(cond.dNSMed) && cond.fwdHigherNTotal > 0) {
        dirNoteEn = '; signed δn median ' + (cond.dNSMed > 0 ? '+' : '') + cond.dNSMed.toFixed(2) + ' (forward higher in ' + cond.fwdHigherN + '/' + cond.fwdHigherNTotal + ' devices' + (cond.fwdHigherN === cond.fwdHigherNTotal ? ', systematically forward-biased' : ', direction inconsistent') + ')';
      }
      var j0NoteEn = j0Hyst ? '; Δlog₁₀J₀=' + (cond.j0DMed != null ? cond.j0DMed.toFixed(2) : '—') + ' (above the auxiliary threshold ' + (T.J0LOG_DELTA != null ? T.J0LOG_DELTA : 1.0) + '; J₀ is an extrapolated value, supporting evidence only)' : '';
      out.verdicts.push({ level: nHyst ? 'warn' : 'info', key: 'hyst',
        text: (nHyst ? '拟合受迟滞影响显著（正/反扫 n 差中位 ' + (cond.nDMed != null ? cond.nDMed.toFixed(2) : '—') + ' > ' + (T.N_DELTA != null ? T.N_DELTA : 0.5) : '正/反扫 n 差中位 ' + (cond.nDMed != null ? cond.nDMed.toFixed(2) : '—') + '（未超 Δn 阈值，但 log₁₀J₀ 差显著') + dirNote + j0Note + '）→ n/J₀ 为表观值，偏高可能含迟滞/测量假象，建议同批同扫描条件比较、谨慎解读（迟滞显著依赖扫描速率、扫描范围、预偏压/预处理与方向顺序，且随速率可能非单调，跨测试协议不可直接比较）。',
        textEn: (nHyst ? 'Fit significantly hysteresis-affected (median fwd/rev-n difference ' + (cond.nDMed != null ? cond.nDMed.toFixed(2) : '—') + ' > ' + (T.N_DELTA != null ? T.N_DELTA : 0.5) : 'Median fwd/rev-n difference ' + (cond.nDMed != null ? cond.nDMed.toFixed(2) : '—') + ' (below Δn threshold, but log₁₀J₀ difference significant') + dirNoteEn + j0NoteEn + ') → n/J₀ are apparent; high values may contain hysteresis / measurement artifacts. Compare within the same batch & scan protocol and read with caution (hysteresis depends strongly on scan rate, scan range, pre-bias/preconditioning and direction order, and may be non-monotonic with rate — cross-protocol comparison is invalid).' });
    }
    // n（复合机制）——V2 收尾：恢复推测性指导结论（加「可能」），局限说明留在帮助文档
    if (isNum(n)) {
      if (n > T.N_HIGH) {
        out.verdicts.push({ level: 'warn', key: 'n',
          text: '表观理想因子偏高（n=' + n.toFixed(2) + '）→ 可能为缺陷（SRH）复合增强或界面复合主导，Voc 损耗偏大；建议优先排查界面钝化、退火工艺与体缺陷。' + (nHyst ? '（受迟滞影响，表观偏高可能含测量假象）' : ''),
          textEn: 'Apparent ideality factor high (n=' + n.toFixed(2) + ') → possibly enhanced defect (SRH) recombination or interface-recombination dominant; larger Voc loss. Check interface passivation, annealing and bulk defects first.' + (nHyst ? ' (hysteresis-affected; apparent high may include measurement artifacts)' : '') });
      } else if (n > 1.6) {
        out.verdicts.push({ level: 'info', key: 'n', text: '表观理想因子中等（n=' + n.toFixed(2) + '），存在一定非理想成分，复合风险可控。',
          textEn: 'Apparent ideality factor moderate (n=' + n.toFixed(2) + '); some non-ideal component, recombination risk manageable.' });
      } else {
        out.verdicts.push({ level: 'ok', key: 'n', text: '表观理想因子较低（n=' + n.toFixed(2) + '），复合相对理想。',
          textEn: 'Apparent ideality factor low (n=' + n.toFixed(2) + '); recombination relatively ideal.' });
      }
      out.hasIp = true;
    }

    // J0（复合强度 / Voc 亏损）——V2 收尾：推测性 + 二级定位（外推型参数）
    if (isNum(j0)) {
      var j0High = j0 > T.J0_HIGH;
      var j0VsBase = hasBase && isNum(base.j0Med) ? (j0 / base.j0Med) : 1;
      if (j0High) {
        out.verdicts.push({ level: 'warn', key: 'j0',
          text: '表观 J₀（外推）偏高（' + fmt(j0) + ' mA/cm²，经验阈值/未标定）→ 可能复合偏强（Voc 被压），或外推不确定度较大；建议结合暗态 JV 复核。主要用于同批相对比较，绝对阈值谨慎。' + (hasBase ? ' 约为 Base 的 ' + Math.round(j0VsBase * 100) + '%。' : ''),
          textEn: 'Apparent J₀ (extrapolated) high (' + fmt(j0) + ' mA/cm², empirical/uncalibrated threshold) → possibly stronger recombination (pressing Voc), or large extrapolation uncertainty; cross-check with dark JV. For within-batch relative comparison; treat the absolute threshold with care.' + (hasBase ? ' ≈ ' + Math.round(j0VsBase * 100) + '% of Base.' : '') });
      } else if (hasBase && isNum(base.j0Med) && j0VsBase > 3) {
        out.verdicts.push({ level: 'info', key: 'j0', text: '表观 J₀（外推）较 Base 偏高（' + Math.round(j0VsBase * 100) + '%）但未超经验阈值 → 可能有轻微复合增强趋势。',
          textEn: 'Apparent J₀ (extrapolated) above Base (' + Math.round(j0VsBase * 100) + '%) but below the empirical threshold → mild recombination-enhancement tendency.' });
      } else {
        out.verdicts.push({ level: 'ok', key: 'j0', text: '表观 J₀（外推）正常（' + fmt(j0) + ' mA/cm²' + (hasBase && isNum(base.j0Med) ? '，约 Base 的 ' + Math.round(j0VsBase * 100) + '%' : '') + '，经验阈值仅参考）。',
          textEn: 'Apparent J₀ (extrapolated) normal (' + fmt(j0) + ' mA/cm²' + (hasBase && isNum(base.j0Med) ? ', ≈ ' + Math.round(j0VsBase * 100) + '% of Base' : '') + '; empirical threshold only reference).' });
      }
      out.hasIp = true;
    }

    // 组合判据 → 建议
    var warnKeys = out.verdicts.filter(function (v) { return v.level === 'warn'; }).map(function (v) { return v.key; });
    if (warnKeys.indexOf('rs') >= 0 && warnKeys.indexOf('rsh') < 0 && warnKeys.indexOf('n') < 0) {
      out.advice.push({ zh: '主瓶颈指向「串联损耗」（Rs 高）——优先排查电极 / 接触 / 导电层，勿先改吸收层。', en: 'Main bottleneck: series-resistance loss (Rs high) — check electrode / contact / transport layers first; do not modify the absorber yet.' });
    }
    if (warnKeys.indexOf('rsh') >= 0 && warnKeys.indexOf('rs') < 0 && warnKeys.indexOf('n') < 0) {
      out.advice.push({ zh: '主瓶颈指向「漏电 / 钝化」（Rsh 低）——优先检查针孔、界面钝化与退火，勿先改吸收层。', en: 'Main bottleneck: leakage / passivation (Rsh low) — check pinholes, interface passivation and annealing first; do not modify the absorber yet.' });
    }
    if (warnKeys.indexOf('n') >= 0 && warnKeys.indexOf('j0') >= 0) {
      out.advice.push({ zh: '复合型瓶颈（n 高 + J₀ 高，Voc 亏损）——优先钝化界面 / 减少 SRH 缺陷；这类问题改吸收层厚度通常无效。', en: 'Recombination-driven bottleneck (n & J₀ high, Voc loss) — passivate interfaces / reduce SRH defects first; absorber-thickness changes usually do not help here.' });
    }
    if (warnKeys.indexOf('j0') >= 0 && warnKeys.indexOf('n') < 0) {
      out.advice.push({ zh: 'J₀ 偏高提示复合偏强——可复核理想因子与 Voc 损耗，结合暗态 / 光强依赖进一步定位。', en: 'High J₀ suggests stronger recombination — re-check the ideality factor and Voc loss; locate further with dark / light-intensity dependence.' });
    }
    if (warnKeys.length === 0) {
      out.advice.push({ zh: '四项参数均正常 → 若 PCE 仍偏低，瓶颈大概率在「光吸收 / Jsc」（膜厚、透光、形貌），此时看 Jsc 箱线图并复核膜层。', en: 'All four parameters normal → if PCE is still low, the bottleneck is likely optical / Jsc (thickness, transparency, morphology) — check the Jsc boxplot and re-verify the film stack.' });
    }

    var okCnt = out.verdicts.filter(function (v) { return v.level === 'ok'; }).length;
    var warnCnt = warnKeys.length;
    if (warnCnt === 0) out.summary = { zh: '诊断未见明显异常，器件健康；效率瓶颈可能不在等效电路环节。', en: 'No obvious anomaly; device healthy — the efficiency bottleneck may not lie in the equivalent-circuit stage.' };
    else if (warnCnt === 1) out.summary = { zh: '主要问题：' + out.verdicts.filter(function (v) { return v.level === 'warn'; }).map(function (v) { return v.text.split('→')[0]; }).join('；'), en: 'Main issue: ' + out.verdicts.filter(function (v) { return v.level === 'warn'; }).map(function (v) { return (v.textEn || v.text).split('→')[0]; }).join('; ') };
    else out.summary = { zh: '存在多方面的等效电路异常（' + warnKeys.map(function (k) { return k.toUpperCase(); }).join(' / ') + '），需分层排查。', en: 'Multiple equivalent-circuit anomalies (' + warnKeys.map(function (k) { return k.toUpperCase(); }).join(' / ') + ') — investigate layer by layer.' };
    void okCnt;
    return out;
  }

  var JVAnalysis = {
    DEFAULTS: DEFAULTS,
    median: median,
    conditionStats: conditionStats,
    analyze: analyze,
    fmt: fmt, fmtRsh: fmtRsh, fmtRs: fmtRs
  };
  global.JVAnalysis = JVAnalysis;
})(typeof window !== 'undefined' ? window : globalThis);
