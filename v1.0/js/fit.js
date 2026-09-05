/* V2 · 等效电路参数提取（P1）——双方向拟合版（t7）
 * 参数提取策略（稳定、可解释、双方向）：
 *   1) Rs / Rsh —— 直接用仪器 given 值（device.rs/.rsh）。
 *   2) n / J0 —— 亮态对数线性法，对【反扫】【正扫】分别拟合：
 *      在 J<0 上拐区，X = (Jsc−J) ≈ J0·exp(V/(n·kT/q))，ln(X) ~ V 线性回归 → n、J0。
 *      · both 器件（正反扫兼有）：主值 = 正反扫平均（n 算术平均、J0 几何平均[对数尺度]），
 *        并给出迟滞差 dN=|n_rev−n_fwd|、dLogJ0=|log10J0_rev−log10J0_fwd|（受扫描速度影响，仅供同批相对参考）。
 *      · 单扫器件：用可用方向，dir 标记（'rev'|'fwd'），不参与迟滞差。
 *   3) 定位：表观参数，宜同批相对比较；四假设在钙钛矿中不严格成立（详见帮助文档局限说明）。
 * 纯函数、无 DOM。挂 globalThis.JVFit。
 */
(function (global) {
  'use strict';

  var KTQ = 0.02585; // 300K 热电压（n·kT/q）
  function ktqAt(K) { return KTQ * (K / 300); } // t9：测试温度可配置（P2-3）

  function linfit(xs, ys) {
    var n = xs.length, mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var xd = xs[j] - mx, yd = ys[j] - my;
      num += xd * yd; dx += xd * xd; dy += yd * yd;
    }
    var b = dx > 0 ? num / dx : 0;
    var a = my - b * mx;
    var ssRes = 0, ssTot = 0;
    for (var k = 0; k < n; k++) {
      ssRes += (ys[k] - (a + b * xs[k])) * (ys[k] - (a + b * xs[k]));
      ssTot += (ys[k] - my) * (ys[k] - my);
    }
    // t9（P1-4）：斜率标准误 SE = sqrt(SSE/(n−2)) / sqrt(Sxx)；截距标准误 SE(a)（t10 二次审阅 P1-1）
    var se = null, seA = null;
    if (n > 2 && dx > 0) {
      var sse = Math.max(ssRes, 1e-12);
      var mse = sse / (n - 2);
      se = Math.sqrt(mse) / Math.sqrt(dx);
      seA = Math.sqrt(mse * (1 / n + mx * mx / dx));
    }
    return { a: a, b: b, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, n: n, se: se, seA: seA };
  }

  /** 单条曲线（点数组）的对数线性区：V>=0.05、J<0 且 |J| 处于 Jsc 的 fracMin~fracMax（默认 0.1~0.9）。
   *  RsEff>0 时做 Rs 修正：V_int = V − J·Rs（J<0 → V_int>V；J 换算 A/cm²；Rs 为面积归一化 Ω·cm²）。
   *  返回 {vs, xs, lsc} 或 null。 */
  function logRegion(points, RsEff, fracMin, fracMax) {
    if (!points || !points.length) return null;
    var lo = (fracMin == null) ? 0.1 : fracMin;
    var hi = (fracMax == null) ? 0.9 : fracMax;
    var seg = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (isFinite(p[0]) && isFinite(p[2]) && p[0] >= 0.05) seg.push([p[0], p[2]]);
    }
    if (seg.length < 6) return null;
    var lsc = seg[0][1];
    for (var j = 1; j < seg.length; j++) if (seg[j][1] < lsc) lsc = seg[j][1];
    var vs = [], xs = [];
    for (var k = 0; k < seg.length; k++) {
      var Jv = seg[k][1];
      if (Jv >= 0 || lsc >= 0) continue;
      var frac = Jv / lsc; // 1→平底(Jsc)，→0 接近 Voc
      if (frac > hi || frac < lo) continue;
      var X = -lsc + Jv; // = |Jsc| − |Jv|（暗电流代理，正）
      if (!(X > 0) || !isFinite(Math.log(X))) continue;
      var V = seg[k][0];
      if (RsEff > 0) V = V - (Jv / 1000) * RsEff; // 结电压 = V − J·Rs（光伏模式 J<0 → 右移）
      vs.push(V); xs.push(Math.log(X));
    }
    if (vs.length < 4) return null;
    return { vs: vs, xs: xs, lsc: lsc };
  }

  /** 拟合单个方向（points 为该方向的 [V,I,J] 数组）。返回 {n,J0,r2,points,N,dV,se,seLogJ0,Jsc} 或 null。
   *  rsEff>0 时做 Rs 修正：V_int = V − J·Rs（Rs 为面积归一化 Ω·cm² 值，见 fitDevice）。
   *  t9 质量指标（P1-4）：N=线性区有效点数、dV=拟合电压跨度、se=斜率标准误。
   *  t10（二次审阅 P1-1）：seLogJ0=log₁₀J₀ 的标准误（截距 SE / ln10）——J₀ 外推不确定度。
   *  注意（实测结论）：本工具对数线性窗口（frac 0.1–0.9）已避开近 Jsc 的 Rs 重干扰区段，
   *  对 260814 批数据未修正时 r² 中位 0.9996 已最优——Rs 修正不改善线性，开关默认关。 */
  function fitOne(points, rsEff, ktq, fracMin, fracMax) {
    var lr = logRegion(points, rsEff || 0, fracMin, fracMax);
    if (!lr) return null;
    var f = linfit(lr.vs, lr.xs);
    if (!isFinite(f.b) || f.b <= 0) return null;
    var kt = ktq || KTQ;
    var n = (1 / f.b) / kt;
    if (n > 12 || n < 0.3) return null; // 物理保护
    var vmin = lr.vs[0], vmax = lr.vs[0];
    for (var i = 1; i < lr.vs.length; i++) {
      if (lr.vs[i] < vmin) vmin = lr.vs[i];
      if (lr.vs[i] > vmax) vmax = lr.vs[i];
    }
    return {
      n: n, J0: Math.exp(f.a), r2: f.r2, points: f.n, Jsc: lr.lsc,
      N: f.n, dV: vmax - vmin, se: f.se, // t9：质量指标（P1-4）
      seLogJ0: isFinite(f.seA) ? f.seA / Math.LN10 : null, // t10：log₁₀J₀ 标准误（截距 SE / ln10）
      Rs: NaN, // 占位：调用方补充（方向级 Rs 由 fitDevice 填入）
      Rsh: NaN,
      rsCorrect: rsEff > 0
    };
  }

  /** 质量分级（t10 二次审阅 P1-1）：A=可信（可参与条件统计）/ B=参考（显示但可降权）/ C=仅趋势（灰显或 N/A）。
   *  判定基于主方向的 N、ΔV、CI 宽度与窗口稳定性；阈值为例示值，需按仪器标定。 */
  function gradeFor(f) {
    if (!f) return 'C';
    var nRel = isFinite(f.se) && f.se > 0 && isFinite(f.n) ? Math.abs(f.se) * f.n * f.n * 0.02585 / f.n : 0; // SE(n)/n ≈ SE(b)·n·kTq
    var ciNarrow = nRel < 0.15;
    var windowStable = f.windowDeltaN == null || f.windowDeltaN <= 0.20;
    if (f.N >= 6 && f.dV >= 0.08 && f.r2 >= 0.99 && ciNarrow && windowStable) return 'A';
    if (f.N >= 4 && f.dV >= 0.05 && windowStable) return 'B';
    return 'C';
  }

  /** 主入口：双方向拟合。opts={rsCorrect:boolean, temperatureK:number}（默认 300K）。
   * 返回：
   *  { n, J0（汇总值：both=正反扫平均，单扫=可用方向）, n_rev, J0_rev, n_fwd, J0_fwd,
   *    dN, dLogJ0（绝对值，both 有）, dN_s, dLogJ0_s（有符号 δn/δlog₁₀J₀，= fwd−rev）,
   *    dir, r2, points, N, dV, se, Jsc, Rs, Rsh, rsCorrect, temperatureK } 或 null */
  function fitDevice(dev, opts) {
    if (!dev) return null;
    var rsCorrect = !!(opts && opts.rsCorrect);
    var tempK = (opts && isFinite(opts.temperatureK) && opts.temperatureK > 200) ? opts.temperatureK : 300;
    var ktq = ktqAt(tempK);
    var rev = (dev.rev && dev.rev.points && dev.rev.points.length) ? dev.rev.points : null;
    var fwd = (dev.fwd && dev.fwd.points && dev.fwd.points.length) ? dev.fwd.points : null;
    if (!rev && !fwd) return null;
    // t9（P0-1）：Rs 修正用面积归一化值 Rs·A（专家审阅确认仪器 Rs 为绝对 Ω；本批 A=0.0625，Rs·A≈1.94 Ω·cm²）
    var revRsArea = isFinite(dev.rev && dev.rev.rs) && isFinite(dev.area) ? dev.rev.rs * dev.area : NaN;
    var fwdRsArea = isFinite(dev.fwd && dev.fwd.rs) && isFinite(dev.area) ? dev.fwd.rs * dev.area : NaN;
    var revRs = rsCorrect ? (isFinite(revRsArea) ? revRsArea : (isFinite(dev.rsArea) ? dev.rsArea : 0)) : 0;
    var fwdRs = rsCorrect ? (isFinite(fwdRsArea) ? fwdRsArea : (isFinite(dev.rsArea) ? dev.rsArea : 0)) : 0;
    var fr = rev ? fitOne(rev, revRs, ktq) : null;
    var ff = fwd ? fitOne(fwd, fwdRs, ktq) : null;
    if (!fr && !ff) return null;
    var both = !!(fr && ff);
    var main = fr || ff; // 主方向（反扫优先）
    // t10（P2-1）：窗口敏感性——主方向用邻近窗口 frac 0.15–0.85 复算，n 相对变化 >20% → 敏感
    var wDelta = null;
    var mainPts = fr ? rev : fwd;
    var mainRs = fr ? revRs : fwdRs;
    if (mainPts && main.N >= 4) {
      var alt = fitOne(mainPts, mainRs, ktq, 0.15, 0.85);
      if (alt && isFinite(alt.n) && isFinite(main.n) && main.n > 0) {
        wDelta = Math.abs(alt.n - main.n) / main.n;
      }
    }
    var out = {
      n: NaN, J0: NaN, n_rev: fr ? fr.n : NaN, J0_rev: fr ? fr.J0 : NaN,
      n_fwd: ff ? ff.n : NaN, J0_fwd: ff ? ff.J0 : NaN,
      dN: null, dLogJ0: null, dN_s: null, dLogJ0_s: null,
      dir: both ? 'both' : (fr ? 'rev' : 'fwd'),
      r2: main.r2, points: main.points, Jsc: main.Jsc,
      N: main.N, dV: main.dV, se: main.se, seLogJ0: main.seLogJ0, // t9/t10：质量指标
      windowDeltaN: wDelta, windowSensitive: wDelta != null && wDelta > 0.20, // t10：窗口敏感性
      grade: null, // t10：A/B/C 质量分级
      Rs: isFinite(dev.rs) ? dev.rs : NaN,
      Rsh: isFinite(dev.rsh) ? dev.rsh : NaN,
      rsCorrect: rsCorrect,
      temperatureK: tempK
    };
    if (both) {
      // 汇总值 = 正反扫平均：n 算术平均、J0 几何平均（对数尺度）——定位为统计汇总，无单一物理状态（专家 P1-2）
      out.n = (fr.n + ff.n) / 2;
      out.J0 = Math.sqrt(fr.J0 * ff.J0);
      out.dN = Math.abs(fr.n - ff.n);
      out.dLogJ0 = Math.abs(Math.log10(fr.J0) - Math.log10(ff.J0));
      // t9（P1-3）：有符号方向差 δn = n_fwd − n_rev（正=正扫更高；可区分随机迟滞 vs 系统性方向差）
      out.dN_s = ff.n - fr.n;
      out.dLogJ0_s = Math.log10(ff.J0) - Math.log10(fr.J0);
    } else {
      out.n = fr ? fr.n : ff.n;
      out.J0 = fr ? fr.J0 : ff.J0;
    }
    out.grade = gradeFor(out); // t10：A/B/C 分级（基于主方向 N/ΔV/CI/窗口稳定）
    return out;
  }

  global.JVFit = {
    fitDevice: fitDevice,
    linfit: linfit,
    KTQ: KTQ,
    ktqAt: ktqAt
  };
})(typeof window !== 'undefined' ? window : globalThis);
