# 决策：客户端视觉改用宿主 token（2026-10-21）

状态：生效

## 问题

插件界面是自绘的（`client.js` 单文件、零构建、`CSS` 字符串数组），样式值当初按「看着差不多」写：
`1px` 边框、`6/8/10px` 圆角、`11px` 小字、写死的阴影、自造的开关尺寸。
结果是与宿主原生控件并排时能看出不是一套东西，且几处对比度不达标。

## 决策

一律改用宿主已发布的 token 与惯例，不自己造值。具体：

- 边框 `.5px solid var(--dsw-alias-border-l2)`（宿主插件页 10 处 `.5px`、0 处 `1px`）。
- 圆角 `--dsw-radius-xs/sm/md/lg`；`card` 用 `lg`、规则卡片用 `md`、控件用 `sm`。
- 焦点环统一 `outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))`。
  **回退值必须写**：`--dsw-focus-ring-color` 只在 `html[data-input-modality=pointer]` 下被定义，
  键盘模态下为空，没有回退就等于没有焦点提示。
  自带醒目边框的控件（`.mds-trigger`、`.mds-search`）用 `box-shadow` 叠环，不用 `outline`。
- 语义色只给图标与徽标，成句的话用 `label-primary`/`label-secondary`。
  实测亮色下 `success #22c55e` 在白底是 2.28:1、`warn #dd8629` 是 2.79:1 —— 当正文色读不出来。
- toast 用 `--dsw-alias-toast-bg` + `--dsw-alias-toast-label`：宿主 toast 在两套主题下都是深底浅字，
  原先的浅底 toast 与宿主不一致。定位用 `--dsh-frame-overlay-top`，否则 macOS / Windows 标题栏会压住它。
- 下拉弹层用 `--dsw-specific-menu` + `--dsw-menu-backdrop-filter` + `--dsw-elevation-prominent`：
  它悬在面板之上，再叠一层不透明 `layer-3` 会与底下糊成一片。
- 正文最小 12px（`11px` 在老版 Windows 上发虚）；标题层级对齐宿主 `20/14/13`。

## 替代方案（强制）

- 全部换 `1px` + 自定圆角阶梯（8/10/12）：与相邻宿主控件肉眼可辨地不是一套，首轮评审就是这个问题。
- 焦点环保留 `outline:2px solid brand-primary`：亮色下 brand 与背景对比够，但暗色 `brand #f9fafb`
  当环色在浅色弹层上会消失；用宿主变量才有两套主题的正确取值。
- toast 保持浅底并给成功/失败整条染色：两套主题下要各调一次对比度，且与宿主 toast 观感分裂。
- 语义色当正文色（保留原状）：绿/琥珀在 12px 下对比度 2.28:1 / 2.79:1，属于「写了等于没写」。

## 影响

- 收益：与宿主原生控件并排看不出接缝；键盘可达性恢复；暗色不再靠逐个手调。
- 代价：依赖宿主 token 名（`--dsw-radius-*`、`--dsw-specific-menu`、`--dsh-frame-overlay-top`），
  宿主改名会静默失效。缓解：所有用法都带 `var(..., 回退值)`，失效时退回可用的中性值。
- 一处刻意不合 token：头部「模型」按钮保留 `border-radius:6px`。
  同一排的宿主按钮（「智能体团队」）就是 6px，换 `--dsw-radius-sm`（8px）会比邻居更圆。
- 新增 `tools/check-css-usage.mjs` 作为样式自检（死规则 / 未定义类），因为这类改动最容易留下没人引用的规则。
