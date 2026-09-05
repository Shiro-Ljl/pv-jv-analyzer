# 名称解释器（Name Interpreter）原理

> v1.1 新增模块。本文件说明名称分解、模板推断、优先级链与用户规则/预览面板的用法。
> 面向开发者与高级用户；普通用户只需要知道「命名越规范，自动归并越准确」（见 README）。

## 一、三维分解模型

仪器导出的每条参数记录名（如 `R1-1.CH_Ref(1)`）按三个维度分解：

| 维度 | 角色 | 实现 |
|---|---|---|
| 条件（主键块） | 实验主键，条件名=主键原样 | 模板正则捕获组 1 |
| 通道 | 同条件下的器件/重复档 | `CH_Ref(n)` 数字（分解显示；归并进条件的 devices） |
| 方向 | 正扫/反扫 | 既有 `getScanDirection` + 系统名兜底判向（不重造） |

**原则**：条件名/器件名是用户数据——工具只按模板分解与归并，**不翻译、不规整、不改大小写**。

## 二、模板签名与置信度

内置模板库 `NAME_TEMPLATES`（parser.js，签名 ↔ 格式实例）：

| id | 签名 | 格式实例 | 正则（组 1 = 主键） |
|---|---|---|---|
| `ivs.chref` | `<key>.CH_Ref(<n>)` | `R1-1.CH_Ref(1)` | `^(.+?)\.CH_Ref\((\d+)\)$` |
| `ivs.chref.reverse` | `<key>.CH_Ref.(Reverse\|Forward)(<n>)` | `1.CH_Ref.Reverse(1)` | `^(.+?)\.CH_Ref\.(Reverse\|Forward)\((\d+)\)$` |
| `ivs.chref.bracketed` | `<key> (<mid>.CH_Ref(<n>))` | `Sample-A 1 (X.CH_Ref(1))` | `^(.+?) \(.*?\.CH_Ref\(\d+\)\)$` |
| `proc.device` | `<key> Device <n>` | `PVK-1 Device 3` | `^(.+?)\s*Device\s+(\d+)$` |

**置信度（`inferNameTemplate`）**：名称集合**全部**命中同一模板 → 单模板高置信（`confidence:'high'`，自动归并）；否则 `null`（不介入）。

**多模板检测（`detectNameTemplateMix`）**：逐名命中模板库 → `single`（全同模板）/ `mix`（≥2 种）/ `none`（存在不命中）——预览面板的触发依据。

## 三、优先级链

```
解析预览「应用并记住」的映射（jv_name_rule_manual，manual 模式）
  > 用户规则（jv_name_rules，条件提取正则，混合式）
  > 自动推断（模板库全匹配，且 records > 40）
  > 旧行为（每条记录=独立条件名归组）
```

- **manual 模式**（预览「应用/应用并记住」）：原名 → 条件名直取映射（全记录命中才激活）。
- **用户规则**（设置面板「条件提取正则」）：正则命中记录按捕获组 1 归并，未命中记录保持原样（**混合式安全**，不设全命中门槛）；存 `localStorage jv_name_rules`。
- **自动推断**：内置模板库 + `records > 40` 双门槛（单模板高置信才介入，避免小文件/非模板文件被误干）。

## 四、解析预览面板（交互兜底）

- **触发**：导入后 `detectNameTemplateMix` 为 `mix`/`none`（多模板/低置信）→ 自动弹出；`single` 不打扰；预览「应用并记住」的记忆已覆盖 → 不弹。
- **表格**：模板芯片（签名+记录数）+ 行级映射（原名 | 条件（可改）| 通道 | 方向 | 模板）。
- **交互**：逐行修正条件名；「全部保持原样」退回旧行为（零动作）；「应用」写模块级映射；「应用并记住」+localStorage。

## 五、用户规则示例

**示例（剥离 Sample-A 后缀 → 条件名干净）**：条件提取正则 `^(Sample-A)(?: \d+)?\.CH_Ref\(\d+\)$`
- `Sample-A 1.CH_Ref(1)` → 主键 `Sample-A`（剥掉空格+编号后缀）✅
- `25.CH_Ref(1)` → 未命中（保持原样）✅

规则生效后重新加载文件（解析在加载时执行；修改后 toast 提示「重新加载文件生效」）。

## 六、A/B 样例模板详解

| 样例 | 名称模式 | 模板 | 自动归并结果 |
|---|---|---|---|
| A：`20260618.csv`（334 记录） | `R1-1.CH_Ref(1..4)` 等 61 个主键 × 4-8 通道 | `ivs.chref` | **228 → 61 条件**（334 器件保持，avg 5.5/条件） |
| B：`batch-B.csv`（157 记录） | `Sample-A`/`Sample-A 1`/`31-3`/`46-6`… × `CH_Ref(1..6)` | `ivs.chref` | **53 → 21 条件**（157 器件保持，avg 7.5/条件） |
| B-mixed：`B-mixed.csv`（混合命名测试） | 3 条 bracketed + 其余 CH_Ref | `ivs.chref.bracketed` + `ivs.chref` | 多模板 → 预览面板触发（不静默） |

## 七、已知边界

- 拼接文件（E36a 型）的级联表头分段已支持；名称模板推断只作用于**段内条件分组**（同名条件跨段自动合并）。
- 用户规则只消费「条件提取正则」（v1.1-I3 精简：通道/方向自动识别已覆盖常见形态，人工通道/方向正则属罕见需求，从 UI 移除；parser 存储层保留字段兼容）。

## 八、v1.1 扩展：块模型 + guided 规则对象 + 多源优先级链

### 8.1 块模型（spec 6.1/6.2）

`splitNameBlocks(name)` 按 空白/点/括号 分词，块类型 `sep`（空白/点）、`num`（纯数字）、`word`（字母数字混，连字符不拆如 `R1-4`）、`paren`（括号块整体；word 无间隔紧接 `(` 粘合为完整块如 `CH_Ref(1)`；**方向词不粘合**——`Reverse(1)` 拆为 word:Reverse + paren:(1)）。每块含 `{text, start, end, kind}`。

`nameBlockRoles(name)` 角色候选（推荐/备选/未决）：
- paren 含 `CH_Ref(n)` → **channel**；`CH_Ref` 词块 → ignored（通道标记，勿误 cond）
- 纯数字（或括号内纯数字）→ seq（未决），紧邻 CH_Ref → channel
- fwd/forward/rev/reverse 独立词或 `fwd-1`/`rev-2` 连字符段 → **direction**
- 其余 → cond（推荐）| ignored

### 8.2 guided 规则对象与持久化

```js
{ mode: 'guided', parts: [ { role:'cond', blockIndex:0, pattern:'Sample-A' }, ... ], compiled:'' }
```
- `guidedKey(name)`：parts 中 role==='cond' 的块文本按块索引拼接为条件键；**块索引越界 → 整名回退**（安全语义，不误归并）
- 持久化键 `jv_name_rule_guided`（与旧 `jv_name_rules` 并存互不覆盖）

### 8.3 多源优先级链（解析时聚类模式选择）

```
nameRules（正则，最高）→ guided（块规则）→ manual（v1.1 行级映射）→ 自动推断模板（>40 记录全匹配）→ 旧行为
```
应用链实测（20260622-1）：无规则 21/tpl → +guided 19 → +user（guided 残留）105/user → 复位 21/tpl。

### 8.4 交互层（I2/I3）

- **块编辑器**（🧩 名字分组）：积木点选角色 + 即时分组预览（预览与应用同语义——模板级候选 parts + 同一键回退规则）
- **名字理解向导**（三步）：样例分块 → 单选（推荐/整段/手动）+ 模式卡 → 合并预览 + 确认/再看看/保持原样；应用写 guided + `jv_guide_skip` 记忆（「重置不再提示」入口在块编辑器底部）
