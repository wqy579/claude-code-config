# 记录

6. **销售单弹窗商品格改行内搜索下拉（对齐旧系统新增订单）** — 2026-09-28
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`（+219/−212）
   - 背景：上一笔 `a92f078` 把第三栏做成独立 multi-pick 复选框面板（搜索框 + 全选/已选/添加/清空工具条 + 下方双栏复选框列表），与旧系统新增订单页「每行商品格内搜索 + 下拉勾选」不一致；此笔对齐旧系统。
   - 改法：删独立 multi-pick 面板（`.multi-pick*`/`.pick-*` 样式 + `pickerMulti`/`searchPickerProducts`/`addPickedProducts`/`toggleAllPicker`/`onPickSearch`/`resetPickerMulti` 等），每行商品格换 `.prod-cell`：
     - 搜索输入 `.prod-search`（已选商品 readonly 显示名 + ✕ 重选）+ 下拉建议 `.prod-suggestions`；每条建议带 checkbox，勾选即填「搜索行起的第一个空行」（没有则在搜索行后插新行）、取消即清该行回空行；下拉顶部「全选添加」一键把全部建议商品铺成新行（跳过已在单中的）。
     - 新增 `onProdInput/onProdFocus/onProdBlur/onProdSuggEnter/onProdSuggLeave/refreshOpenSuggestions/toggleProductCheck/selectAllProducts/clearProductFromRow`；删 `onProductChange`（el-select 已移除）。
     - `blankRow` 增 `showSuggestions/checkedProducts/_blurTimer/_suggHover/_prevOptions`；`searchProducts` 用 `_prevOptions` 同步勾选态（翻页/重搜不丢勾、已在单中商品标勾）。
   - 收尾（本会话补的几处）：
     - 模板缩进错位：删 multi-pick 块时把 `<div class="items-table-scroll">` 与注释跌到 1 tab（同级/子节点都在 4 tab），已还原 4 tab、开合对齐；并删商品 `<td>` 内 3 行残留空行。
     - 删死代码 `productLabel`（原只服务已删的 el-option `:label`，全文件再无引用）。
     - `saveDraft` 只剥了旧 3 个瞬态字段（`_loading/_searchKeyword/_options`），新加的 `showSuggestions/checkedProducts/_blurTimer/_suggHover/_prevOptions` 全被序列化进 localStorage——`_prevOptions` 是完整商品对象数组胀配额、`_suggHover=true` 重载后会让首次失焦关不掉下拉；改 `saveDraft` 剥全瞬态字段、`loadDraft` 补齐 `_blurTimer/_suggHover` 重置兜底旧草稿。
   - 验证：`npm run build ✓`（45s）；新产物 `sales-order-dialog-PGs2HuCy.js`（23.07 kB）已落 `public/admin/`；悬空引用审计：已删符号无残留。
   - 提交 `642e30d` 直推 `origin main`；Tests run `36390938388` ✓（3m31s）、Build & Deploy run `36390938358` ✓（3m56s，success），线上已部署上线。
   - 遗留：前端商品/换算逻辑仍无单测（#4 既留），本笔未补。

5. **销售单弹窗三栏高度限定（20 行），收敛对话框高度** — 2026-09-21
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`（+23/−16）
   - 现象：「新增销售订单」框非常高。三栏（主分类/子分类/商品表格）之前 `.cat-picker` 用 `flex:1 1 auto` 按对话框剩余空间撑高，分类列无上限；对话框本身又写死 `height:96vh` 顶满整屏，body 再扣标题栏算高度，三栏被拉到占满整个剩余视口。
   - 改法：三栏限定为「输入框 20 行」高，对话框随之收敛
     - `.cat-picker`: `flex:1 1 auto` → `height:680px`（20 行 × 31px + 表头 34 + 内边距 ≈ 680），三栏同高对齐
     - `.cat-col`: 补 `height:100%` + `min-height:0`，确保撑满父容器（flex 子项要显式 `min-height:0` 才能收缩）
     - `.items-wrap`: 补 `min-height:0`，flex 子项正常收缩
     - `el-dialog`: 去掉写死的 `height:calc(96vh)`，改 `max-height:96vh + overflow:auto` 按内容撑高；body 去掉显式高度，由「表单 + 三栏(定高) + 合计」自然得出
   - 验证：`npm run build ✓`（1m5s）；新产物 `sales-order-dialog-D9Dcmd43.css` 含 `cat-picker{height:680px}`
   - 提交 `0b947cd` 直推 `origin main`
   - 教训：`flex:1` 撑高在「无内容上限的分类列」上必然把对话框顶满；要限高就得从「父容器按内容撑」这条链上同时改，只改 `.cat-picker` 不动 `el-dialog` 的 96vh 会在下方留大片空白。

1. **1+1=2** — 2026-09-14 17:19

2. **销售单弹窗三单位换算修正 + 批量多选** — 2026-09-19 16:01
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`
   - F1：`formatStock`/`onSmall`/`onMedium`/`onLarge` 三单位(`c>0 && mc>0`)分支统一到「1大=c中=c*mc小、1中=mc小」口径，与 `requiredSmall`/`quantity` 一致；旧实现把 `c` 当大→小，致件价与库存校验在件/盒/袋齐备的商品上错算
   - F2：三栏第三列加全选 checkbox +「添加选中(N)」，勾选后一次性铺到表格空行，补回旧系统「全选添加」
   - 提交：laradmin 仓库分支 `fix/sales-order-dialog-unit-conversion`（commit `1f98da1`），已 push origin；PR 入口 https://github.com/wqy579/laradmin/pull/new/fix/sales-order-dialog-unit-conversion
   - 纠正前述误判：laradmin 后端在 `modules/Business/`（模块化架构），非「不在树内」
   - 待核对：① `unit_conversion` 字段语义是否=大→中（去 `modules/Business` 的 product 迁移/模型确认）；② `buildPayload` 不发 `quantity`，确认 `SalesOrder` store 自算小单位总量且与 `checkStock` 同公式

   ⚠️ **后续核实（2026-09-19 晚）：F1 是回归，#4 不可合并**
   - 真实语义（`modules/Stock/Models/Product.php` + `SalesOrderCreateFeatureTest`）：`unit_conversion`(c)=**大→小**（如 480，1件=480个），`unit_conversion_medium`(mc)=**中→小**（如 120，1盒=120个），大→中 = c/mc（=4，派生不存储）。
   - 后端**金额**用物理价：`amount = qty_large*price_large + qty_medium*price_medium + qty_small*price_small`，且 `itemAmount` **信任前端传的 price_large/medium/small**（只不信 amount）；测试显式传 `price_large=480` 才过，故 CI 没覆盖前端自动带出。
   - 后端 `itemQuantity` 三单位 = `ql*c*mc + qm*mc + qs`（=57870，**膨胀 120×**，被测试锁定的遗产口径）；两单位 = `ql*c + qs`（=965，物理）。
   - **F1 错在**：把膨胀口径 `c*mc` 套到了价格自动带出与 formatStock，这俩本该用物理 `c`：
     - `onSmallPriceChange.price_large` `sm*c`(480✓) → `sm*c*mc`(57600✗)
     - `onMediumPriceChange.price_large` `(md/mc)*c`(480✓) → `md*c`(57600✗)
     - `onLargePriceChange.price_small` `lg/c`(1✓) → `lg/(c*mc)`(0.0083✗)
     - `formatStock` 大单位除数 `cn`(480✓) → `cn*mcn`(57600✗)
   - **OLD 唯一真 bug**：`onLargePriceChange.price_medium` = `lg/mc`(4✗) 应为 `(lg/c)*mc`=`lg*mc/c`(120✓)；我的改动也没修对（改成 `lg/c`=1✗）。
   - 后果：前端自动带出件价 57600 而非 480 → 后端按 57600 记金额（本该 750）→ 金额污染。
   - **正确改法**：回滚 F1 的 4 处（恢复物理口径），只修 OLD 的 `onLarge.price_medium`；F2（批量多选）保留。`requiredSmall`(=膨胀 c*mc，与后端 quantity 一致但对比物理库存会 120× 误拦) 是**既有的独立问题**，本次不擅自改，单独立项。
   - token：已写入 `~/.config/gh/hosts.yml`（scope `repo, workflow`，缺 `read:org` 仅影响 `gh auth login` 校验，不影响 API）；PR #4 已存在且 Tests 8 项全绿，但结论是**先修回归再合**。
   - 修正 commit `2e8b5ba`（回滚 F1 4 处 + 修 `onLarge.price_medium`、保留 F2）推送后 PR #4 Tests 重跑全绿；**squash 合并 #4 → main `96ddefe`**（17:58Z），Build & Deploy run `35459699645` 全绿（`Deploy on server: success`），**线上 `bd23fbb`→`96ddefe` 已部署上线**。
   - 遗留：`requiredSmall`/后端 `itemQuantity` 的三单位膨胀口径 `c*mc`（对比物理库存会 mc× 误拦）是独立既有问题，未改，单独立项；前端价格逻辑无单测，建议补。

4. **销售单弹窗三栏商品表格宽度收敛（去掉第三栏横向滚动条）** — 2026-09-21
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`（+5/−3）
   - 上一笔 `c219b7f` 把对话框 `1280px→96%`、`.cat-col` `150→128px`，量纲只算到 1920（items-wrap≈1490）/1440（≈1082）两档，但表格 `min-width:1040px` 是写死的——**1366 常规屏 items-wrap ≈986px < 1040px，必然出横向滚动条**，即「框不够大」的真正漏档。
   - 改法（三处各让一点，1366 屏合计多出 ~160px）：
     - `width="96%"→"98%"`：1366 屏 +27px
     - `.cat-col flex: 0 0 128px→112px`：两栏分类共 +32px 让位
     - `.items-table min-width: 1040px→920px`：10 列各列宽相加 ≈1050px，压到 920 后由 `width:100%` 均分缩排，弹性列自动让位不挤烂
   - 改后 1366 屏 items-wrap ≈1045px > 920px 滚动条消失；1920 屏 ≈1567px 充裕；移动端受 `responsive.css` 的 `--el-dialog-width:95vw !important` 管，不受影响
   - 验证：`npm run build ✓`（1m9s）；新产物 `sales-order-dialog-BeUh0Fx-.js`（含 `width:"98%"`）/ `sales-order-dialog-BrAjUtn3.css`（含 `112px`、`920px`）已落 `public/admin/`
   - 提交 `4198c23` 直推 `origin main`；Build & Deploy run `35611067993`

   ⚠️ **用户反馈「没变化」→ 确诊改动量太小，垂直方向才是真问题**
   - chromium headless 实测（结构样式与 vue 组件一致的最小复现）：`98%/112px/920px` 下 1280/1366/1440/1536/1600/1920 六档屏**全部无横向滚动条**（1366 屏商品栏 1079px = 表格需要 1079px，`scrollWidth===clientWidth`）。功能上对，但 96→98% 在 1366 只多 27px、128→112px 多 32px，**合计 59px 肉眼无感**。
   - 真因在垂直：默认 `--el-dialog-margin-top:15vh` 把整窗顶到中上部、下方留大片空白；`.cat-picker` 又写死 `height:46vh`（800 高窗口仅 368px）。两处叠加让表格区永远撑不满屏幕。
   - 改法：`el-dialog` 加 `top="2vh"` + `.sales-order-dialog{margin-bottom:2vh}` 顶掉 15vh 上边距和 50px 下边距；`el-dialog__body` 改 `display:flex column + overflow:hidden`，`.cat-picker` 从 `height:46vh` 改 `flex:1 1 auto + min-height:0`，高度按剩余空间分配。
   - 实测收益：1366×800 三栏区 **368px→738px（多一倍可视行数）**；1920×800 738→729px；横向仍无滚动条（`h:false`）。
   - 提交 `7c34da7` 直推 `origin main`；Build & Deploy run `35612995112`
   - 教训：「把框放大」这类诉求，先量出改动像素差——59px 在 1366 屏是 4% 视口，用户当然看不出。垂直方向的空白比水平方向的 59px 值钱得多。

   ⚠️⚠️ **7c34da7 那条「实测收益」是错的——用户「没变化」是对的。已回滚思路、真修（commit `524bf0b`）**
   - 7c34da7 用的复现页是**无 scoped 的裸 HTML**，把组件 CSS 抄过去量，量出来「368→738px」就算成功并部署了。真实组件里那些选择器是 **scoped** 的，行为完全不同。
   - 真因：**Vue scoped CSS 的 hash 加在「最后一个选择器」上，不是锚点上**。`el-dialog` 的根节点由 Element Plus 拥有并 teleport 到 `body`，拿不到本组件的 `data-v` hash，于是
     - `.sales-order-dialog { margin-bottom: 2vh }` → 编译成 `.sales-order-dialog[data-v-x]{…}` → **永不匹配**（实测 `margin-bottom` 一直 `50px`）
     - `.sales-order-dialog :deep(.el-dialog__body) { display:flex }` → 编译成 `.sales-order-dialog[data-v-x] .el-dialog__body{…}` → **永不匹配**（实测 body 一直 `display:block`）
     - 活体证据：`.cat-picker` 有 `data-v-1ec1f9b6` 且生效（cyan），同一条 `<style>` 块里的 `.sales-order-dialog` / `.el-dialog__body` **一个 data-v 属性都没有**。
     - 对照实验：把选择器锚到本地 wrapper `.local-wrap` 上 → 绿框生效；锚在 `.outer-only`（直接挂 el-dialog）上 → 无效果。
   - 连带后果：对话框**固定 869px（按内容撑高，与视口无关）**，不是「顶到中上部」。1280/1366/1440/1536 六档屏量出来全是 869px，上一轮所有屏幕的「撑满」数据都是假的。
   - 正确改法：模板里包一层本组件自己渲染的 `<div class="so-dialog">` 作 scoped 锚点，两条 `:deep` 规则挂上去；并给对话框与正文**显式** `height: calc(96vh)` / `calc(96vh - 4vh - 56px)`——不给明确高度时 body 仍按内容撑高，`flex:1` 的子项永远拿不到剩余空间。
   - 改后实测（真实组件经 Vite dev 编译 + 真 Element Plus，60 行订单）：
     - 1280×800：body 680px、表格可视 **530px**、横向滚动条无
     - 1366×768：body 651px、表格可视 **501px**、横向滚动条无
     - 1920×1080：对话框 **1037px**（= 96vh，修前固定 869px）、表格可视 **788px**
   - 提交 `524bf0b` 直推 `origin main`；`npm run build ✓`（25s），新产物 `sales-order-dialog-CNd9OuYX.js` / `sales-order-dialog-BdIU-ajg.css`（含 `.so-dialog[data-v-48460b5d]` 两条规则）已落 `public/admin/`。
   - **教训（本轮最重要）**：验证 scoped 组件时，**复现页必须走真实编译链（Vite dev + 真实组件）**，抄 CSS 到裸 HTML 会静默丢掉 scoping，量出来的数字全是假的——这轮连错两轮就是因为这么量。另外凡是作用在「第三方组件根节点」上的 `:deep` 规则，先确认那条链上有一个自己渲染的元素。

3. **销售单弹窗加载/分类/库存/状态机对齐收尾（PR #5–#10）** — 2026-09-21
   - 背景：#4 的三单位换算 + 批量多选虽已部署，但线上开弹窗后**主分类列空白「无分类」**，三单位/多选实际无法操作；此轮 #5–#10 逐个排障收尾，全部已 squash 合并入 laradmin `main`。
   - **#5 弹窗打开不加载分类/库存（+2/−1，`sales-order-dialog.vue`）**：父 `sales-order/index.vue` 用 `v-if="dialog.order"` 挂载弹窗，挂载时 `visible` 已 true；dialog 初始化 watch 非 immediate，`v-if` 每次全新挂载永远看不到 false→true 变化 → `loadCategories`/`loadStock` 永不自动跑（`onMounted` import 了但从未调用，无兜底）。修：watch 加 `{ immediate: true }`。不含 `fix/sales-order-dialog-unit-conversion` 分支 `2e8b5ba` 的回滚膨胀口径改动（独立发布决定）。
   - **#6 回填 is_main + 加 external_id（+88/−0，3 个迁移）**：`2026_09_03 add_category_levels` 给 `product_categories.is_main` 加 `default(false)` 但**没回填**，迁移首次跑把所有顶级分类刷成非主分类 → 分类接口 `where is_main=true` 返空 → 三栏「无分类」真因。`000003` 回填 `is_main=true`（`parent_id IS NULL AND is_main=false`，幂等）。`000001/000002` 给 products(联凯 cpid)/product_categories(联凯 qtbm) 加 `external_id` + 索引。**部署待核实**：deploy.yml 是否含 `php artisan migrate`。
   - **#7 000002 幂等化，修生产 Duplicate column（+22/−8，1 个迁移）**：#6 合并后部署失败（run `35489758621` `conclusion=failure`），「无分类」仍未修。根因：`artisan migrate --force` 生产库跑到 `000002` 报 `SQLSTATE[42S21] Column already exists: 1060 Duplicate column name 'external_id'`——**生产库 `product_categories` 已有 `external_id` 列**（CI fresh 库没有 → #6 CI 全绿假象），重复加列 → migrate 中断 → `000003` 没跑 → is_main 未回填。修：`000002` 改 `hasColumn`/`hasIndex` 判断，列已存在则只补索引。**教训：CI fresh 库 ≠ 生产库 schema，加列迁移必须幂等。** 修后 migrate 跑通 → `000003` 执行 → 顶级分类 `is_main=true` 回填 → 三栏恢复分类。
   - **#8 immediate watch TDZ 崩溃（+13/−13，`sales-order-dialog.vue`）**：#5 加 immediate 后弹窗打开即崩 `ReferenceError: Cannot access 'He' before initialization`（minified TDZ）。根因：immediate 让回调在 setup 执行到 `watch()` 那行时**同步触发**，但回调引用的 `loadSalesmen()`/`salesmen` 声明在 watch **之后**（源码 746 watch / 795 salesmen / 797 loadSalesmen）→ TDZ。修：把 `const salesmen` 与 `const loadSalesmen` 移到 watch 之前，watch 位置不动。**教训：immediate watch 的回调依赖必须在 watch 之前声明。** `public/admin/` 为 gitignore 构建产物，服务器侧需重新构建。
   - **#9 下单即冻结库存对齐 + 操作日志 + 库存同步补缺（+509/−127，6 文件）**：
     - 后端对齐旧系统：下单即 `pending` + 即冻结库存 + approve 作废。
     - 补缺①`products.stock_qty` 同步：`StockService` 的 `stockIn/stockOut/freeze/unfreeze` 四处写操作后统一重算 `products.stock_qty = SUM(stocks.quantity)`（该列 `create_business_tables:56` 就在但运行时无人维护，僵尸字段）。
     - 补缺②`order_operation_logs` 操作日志：新建 migration（对齐旧系统字段，补全旧系统漏建的 6 列）+ `logOperation()`，store/update/cancel/destroy 写入，show 带出操作历史；新系统此前只有请求级 `system_log`，缺业务级单据操作流水。
     - 前端：三栏分类按商品数降序。
     - 测试：136 tests / 771 assertions 绿（+5 +26，无回归）。
   - **#10 第三栏改纯商品输入框（+48/−39，`sales-order-dialog.vue`）**：三栏只保留 主分类/子分类/商品输入框，删第三栏下方商品结果列表。第三栏换 `el-autocomplete`：输入名/编码/规格 → 下拉匹配（名称/规格/单价）→ 选中填入表格空行并清空。删 `pickerProducts`/`filterPickerProducts` 等，新增 `queryPickerProducts`/`onPickSuggestion`。
   - **遗留/未做项**：① #4 既有的 `requiredSmall`/后端 `itemQuantity` 三单位膨胀口径 `c*mc`（对比物理库存会 mc× 误拦）仍未改，独立既有问题，单独立项；② #9 的状态机后续流程——旧系统完整链 `pending→picking→transferred→shipped→delivered→completed` + 完整撤销链跨 5 个 Controller（SalesOrder/Dispatch/Delivery/SalesReturn/Payment），新系统 schema 状态值 `draft/pending/approved/completed/cancelled` 与旧 `transferred/shipped/delivered` 对不上，是状态模型重设计而非补缺；半截状态机（只做 picking 不到 delivered）会让冻结库存转不出实扣、卡在库存不一致态，比没有更危险，单独排期；③ 前端价格/换算逻辑仍无单测（#4 已建议），未补。
