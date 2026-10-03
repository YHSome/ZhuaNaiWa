# 抓奶蛙 🐸

**堆叠三消小游戏 · 双击 `index.html` 就能玩 · 手机/平板/桌面都适配**

在线版：**https://yhsome.github.io/zhuanaiwa/**  （GitHub Pages，直接用浏览器打开）
排行榜：无尽模式成绩实时同步（TinyWebDB），榜上展示最近 20 条提交

---

## 这是什么

把一摞互相压住的麻将牌一层层抓进底部的木槽，凑齐 **3 张相同** 自动消除；
托盘 **9 格** 满了就失败。玩法思路来自「羊了个羊」这类堆叠三消，
玩法与代码基于开源项目 [chenxch/xlegex](https://github.com/chenxch/xlegex)（MIT）二次创作，
素材、界面、音效、无尽模式、排行榜都是后加的。

## 特点

| | |
|---|---|
| 🀄 **4 关主线 + 无尽模式** | 教程 9 张 → 挑战关 54 张；通关第 4 关解锁无尽模式：清空一座塔马上起下一座，每塔再高一层，**一条命**爬到底 |
| 🎚️ **收窄托盘 = 真难度** | 实测光把塔堆高并不会更难（牌越多越好凑三），真正卡人的是槽位：同一副 81 张的牌，9 格可解率 80%、8 格 40%、7 格 30%。所以第 3 塔起收到 8 格 |
| ⚖️ **发牌公平性校验** | 每关发牌后重建"谁压着谁"的依赖图并跑多种贪心求解，走不通就自动重发（最多 6~8 次），保证每手牌都有解 |
| 🏆 **无尽模式排行榜** | 结束后一键上榜（塔数/清除张数/用时/昵称），榜单展示最近 20 条；TinyWebDB 有 CORS 头，`file://` 双击打开也能读 |
| 📱 **手机适配** | 轻点兜底、触感反馈、全面屏安全区、窄屏 320px、横屏压缩；大牌堆会按可用空间自动缩放，162 张的塔也不挡 HUD |
| 🎵 **自制音效与 BGM** | 5 个音效 + 宣传片 BGM 全部由代码合成（正弦/三角/方波 + 噪声 + 包络），不含任何第三方采样 |
| 🔌 **离线可玩** | `index.html` 里 JS/CSS 全内联，图片音频走相对路径，双击即玩；只有排行榜要联网 |

## 目录

```
index.html          游戏本体（JS/CSS 已内联，约 190KB）
assets/             9 张牌面图
audio/              5 个自制音效（wav）
promo/index.html    30 秒宣传片（HTML 动画 + WebAudio 现场合成的 BGM）
promo/tiles/        宣传片用的牌面图
使用说明.txt         写给玩家的说明（玩法 / 关卡 / 排行榜 / 怎么改）
sheep-candidates/   开发与验证脚本、构建产物（见下）
```

## 开发与验证

```bash
# 1. 给构建产物打补丁（幂等）
node sheep-candidates/patch-dist.mjs

# 2. 打包成单文件 index.html
node sheep-candidates/build-portable.mjs sheep-candidates/xlegex-patched .

# 3. 回归测试（24 项：遮挡/对齐/输入/流转/发牌门槛/自适应缩放…）
node sheep-candidates/regress.mjs

# 4. 无尽模式专项（11 项：清塔 → 过渡页 → 自动开下一塔 → 塞满结束）
node sheep-candidates/endless-check.mjs

# 5. 排行榜端到端（真实写入 + 独立查询校验 + 清理）
node sheep-candidates/leaderboard-check.mjs

# 6. 难度标定 / 提示器一致性诊断 / 宣传片自检
node sheep-candidates/endless-scale.mjs
node sheep-candidates/hint-diag.mjs
node sheep-candidates/promo-shots.mjs
```

这些脚本都靠 CDP 驱动无头浏览器（`--remote-debugging-port=9222`），
脚本头部的注释里有完整命令行。

## 排行榜接口

TinyWebDB 免费实例（`https://tinywebdb.appinventor.space/api`），
变量名 `naiwa-<epoch秒>-<随机>`，值 `塔数|清除张数|用时秒|昵称`；
读取用 `action=search&tag=naiwa&count=100` 后按提交时间排序取 20。
写死在前端是静态站点的必然（没有自己的后端），只上传这四项，不收集任何其他信息。

## 版权

- 玩法与代码基础：[chenxch/xlegex](https://github.com/chenxch/xlegex)（MIT）
- 牌面素材：本项目作者提供
- 音效 / BGM / 界面 / 无尽模式 / 排行榜：本项目新增
- 本项目以 MIT 许可发布，见 [LICENSE](./LICENSE)
