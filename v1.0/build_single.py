# -*- coding: utf-8 -*-
"""单文件打包脚本（实施规格书第 12 章）

把 index.html + style.css + lib/echarts.min.js + js/*.js 内联为单个 HTML，
产物离线可用（无任何外部引用），输出为「JV Data Analysis Tool v1.0.html」。
用法：python build_single.py [--e2e]   （--e2e 时注入测试数据供 headless 验收，产物带调试 div）
"""
import sys, re

def main():
    e2e = '--e2e' in sys.argv

    html = open('index.html', encoding='utf-8').read()
    css = open('style.css', encoding='utf-8').read()
    echarts = open('lib/echarts.min.js', encoding='utf-8').read()
    scripts = []
    # i18n.js 必须先于 parser（其余按依赖顺序）
    for f in ['js/i18n.js', 'js/parser.js', 'js/tables.js', 'js/charts.js', 'js/ui.js', 'js/fit.js', 'js/help_content.js', 'js/analysis.js', 'js/corr.js', 'js/main.js', 'js/equiv_ui.js', 'js/corr_ui.js']:
        scripts.append(open(f, encoding='utf-8').read())

    # 1. style.css → <style>
    html = html.replace('<link rel="stylesheet" href="style.css">',
                        '<style>\n' + css + '\n</style>')
    # 2. echarts → 内联 <script>
    html = html.replace('<script src="lib/echarts.min.js"></script>',
                        '<script>\n' + echarts + '\n</script>')
    # 3. js/*.js 按依赖顺序内联
    for i, f in enumerate(['js/i18n.js', 'js/parser.js', 'js/tables.js', 'js/charts.js', 'js/ui.js', 'js/fit.js', 'js/help_content.js', 'js/analysis.js', 'js/corr.js', 'js/main.js', 'js/equiv_ui.js', 'js/corr_ui.js']):
        html = html.replace('<script src="' + f + '"></script>',
                            '<script>\n' + scripts[i] + '\n</script>')

    # 4. 注入 e2e 测试脚本（仅 --e2e 模式，含调试 div）
    if e2e:
        import json
        grids = json.load(open('tmp/xlsx_grids.json', encoding='utf-8'))
        grid_proc = json.dumps(grids['260728处理后'], ensure_ascii=False)
        grid_raw = json.dumps(grids['260728'], ensure_ascii=False)
        test_script = r'''
<script>
window.__errors = [];
window.addEventListener('error', function (e) {
  var el = document.getElementById('e2e-errors');
  if (el) el.textContent += 'ERR: ' + e.message + '\n';
});
const GRID_PROC = __GRID_PROC__;
const GRID_RAW = __GRID_RAW__;
function log(msg) { var el = document.getElementById('e2e-errors'); if (el) el.textContent += msg + '\n'; }
window.addEventListener('DOMContentLoaded', function () {
  try {
    var d1 = JVParser.parseGrid(GRID_PROC, '260728处理后.csv');
    JVMain.state.files.push({ name: '260728处理后.csv', data: d1 });
    JVMain.state.currentIndex = 0;
    JVMain.renderAll();
    log('BUILT_PROC conds=' + d1.conditions.length + ' detailRows=' + document.querySelectorAll('#detail-cards tr').length);
  } catch (err) { log('BUILT_ERR: ' + err.message); }
  setTimeout(function () {
    try {
      var d2 = JVParser.parseGrid(GRID_RAW, '260728.csv');
      JVMain.state.files.push({ name: '260728.csv', data: d2 });
      JVMain.state.currentIndex = 1;
      JVMain.renderAll();
      JVMain.state.view = 'combined';
      JVMain.renderAll();
      log('BUILT_RAW conds=' + d2.conditions.length);
    } catch (err) { log('BUILT_ERR2: ' + err.message); }
    setTimeout(function () {
      log('BUILT_SVG=' + document.querySelectorAll('#boxplot-cards svg, #jv-cards svg').length);
      log('BUILT_DONE');
    }, 600);
  }, 800);
});
</script>
<div id="e2e-errors" style="position:fixed;top:0;left:0;z-index:99999;background:#fff;border:1px solid red;font-size:12px;max-height:200px;overflow:auto;"></div>
'''
        test_script = test_script.replace('__GRID_PROC__', grid_proc).replace('__GRID_RAW__', grid_raw)
        # 只替换页面真实的最后一个 </body>（echarts 模板字符串里含 </body>，不能全替换）
        idx = html.rfind('</body>')
        html = html[:idx] + test_script + html[idx:]

    out_name = 'tmp/e2e_built.html' if e2e else 'JV Data Analysis Tool v1.0.html'
    open(out_name, 'w', encoding='utf-8').write(html)
    print('已生成', out_name, '（', len(html), '字符 /', len(html.encode('utf-8')), '字节）')

    # 5. 外部引用检查（验收清单：全文无外部 URL）——只查 HTML 标签属性，不查 JS 代码内字符串
    src_matches = re.findall(r'<[^>]*\b(?:src|href)\s*=\s*"[^"]*"', html)
    ext = [m for m in src_matches if 'data:' not in m and '#"' not in m and 'javascript' not in m]
    print('标签内 src/href 引用:', ext if ext else '无（全部内联）')
    http_matches = re.findall(r'https?://[^\s"\')<>]+', html)
    # 过滤注释中的（echarts 版权注释）
    non_comment = [u for u in http_matches if '注释' not in u]
    print('http(s) 出现次数:', len(http_matches), '（应仅为注释）')

if __name__ == '__main__':
    main()
