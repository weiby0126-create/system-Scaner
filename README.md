# Capability Discovery Assistant v0.1

系统扫描结构化生成研发、产品相关文档。

系统能力发现助手是一个本地运行的 Chrome Extension MVP，用于让采集员在正常浏览企业系统时，通过业务页面点击自动保存页面证据并导出 ZIP。

## 核心原则

- 插件只做信息采集，不在插件内生成能力地图。
- 先保存原始 HTML、截图、Network，再做任何派生分析。
- 导出的 ZIP 可交给外部 AI 重跑、回溯、纠错。
- 不保存 Authorization、Cookie、Token、密码等敏感请求信息。
- 不依赖服务端，不修改目标系统，不需要代码或数据库权限。

## 功能范围

- 任务管理：创建、开始、暂停、结束、导出采集任务。
- 点击触发采集：采集员点击业务页面里的菜单、按钮、链接或表格行后，插件自动保存页面证据，并记录点击元素和页面进入路径。
- 手动补采：保留「手动补采当前页」作为兜底，用于页面没有明显点击入口或需要补齐截图时使用。
- 截图采集：对当前活动 Tab 保存 PNG 截图。
- 菜单路径识别：尝试识别 Breadcrumb、Menu、Tree，失败时允许人工补充路径。
- 页面元素分析：提取按钮、输入框、下拉框、表格、标签等派生数据。
- 网络采集：监听 fetch 和 XHR，只保存 URL、method、status、类型和时间。
- ZIP 导出：包含 metadata、summary、pages/page-xxx 下的 HTML、截图、页面元数据和 Network。
- 结构关系还原：保留原始 `click-paths.json`，同时生成去重聚合后的 `structure-relations.json`，用于还原系统结构，避免人为点击顺序直接影响目录。

## 本地开发

```bash
npm install
npm run build
```

然后在 Chrome 打开 `chrome://extensions`，开启开发者模式，选择 `dist` 目录加载未打包扩展。点击扩展图标会打开固定右侧边栏，便于采集时持续查看任务状态。

## 分享给采集员

已整理两份说明：

- [采集员使用说明.md](采集员使用说明.md)：安装插件、开始采集、导出 ZIP。
- [分析人员使用说明.md](分析人员使用说明.md)：基于采集素材快速整理页面功能、抽象系统能力和能力地图草稿，并说明如何用「系统还原」页上传 ZIP 生成功能图。

打包时建议提供：

```text
CapabilityDiscoveryAssistant-v0.1.zip
├ README.md
├ 分析人员使用说明.md
└ extension
  ├ manifest.json
  ├ background.js
  ├ content.js
  ├ injected.js
  └ ...
```

采集员解压后，在 Chrome 扩展管理页选择 `extension` 文件夹加载。

## 导出结构

```text
task.zip
├ metadata.json
├ summary.json
├ page-index.json
├ navigation-map.json
├ relationship-seeds.json
├ structure-relations.json
├ click-paths.json
└ pages
  ├ page-001
  │ ├ screenshot.png
  │ ├ page.html
  │ ├ page.json
  │ └ network.json
  └ page-002
    ├ screenshot.png
    ├ page.html
    ├ page.json
    └ network.json
```

## 外部 AI 分析

见 [docs/ai-analysis.md](docs/ai-analysis.md)。AI 分析必须基于 ZIP 中的原始证据文件执行，分析结果不覆盖原始证据。
