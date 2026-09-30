# 多语言字幕与配音脚本对齐工作台

一个基于浏览器本地数据的字幕与配音脚本校对工作台。支持导入 SRT 或“角色：台词”格式的剧本文本，从时间轴和逐条列表两个视角维护双语台词。

## 功能

- 导入 SRT / 剧本、编辑原文与译文、修改角色、语速、关联术语和校对状态。
- 按时间码拆分、与下一条合并、上下移动及删除台词。
- 时间轴缩放、角色筛选、全文搜索，以及键盘逐条校对。
- 快捷键：`J` / `K` 切换台词，`A` 或 `S` 确认，`X` 标记疑问，`L` 锁定；`Ctrl/⌘ + Z` 撤销，`Ctrl/⌘ + Y` 或 `Ctrl/⌘ + Shift + Z` 重做。
- 自动检查前后语气、称呼和角色切换；本地术语表检查漏译或术语偏差。
- 完整撤销重做、版本快照与恢复、SRT 导出。
- 简体中文、英文、日文界面切换，菜单、快捷键提示和错误信息同步变化。
- 数据保存在 IndexedDB。使用版本号、BroadcastChannel 和乐观锁检测多标签页写入；发生冲突时默认保留双方内容，由用户决定加载新版本或强制另存新版本。
- 离线仍可编辑，刷新后自动恢复。

## 技术栈

- Vue 3 + Vite + TypeScript
- Pinia
- Element Plus
- IndexedDB + BroadcastChannel

## 本地开发

```bash
npm install
npm run dev
```

开发服务器端口由 Vite 输出。宿主端口映射仅由根目录端口表和 Docker 命令负责，源码不硬编码宿主端口。

## 生产构建

```bash
npm install
npm run build
npm run preview
```

## Docker

```bash
docker build -t sologsb-1001 .
docker run --rm -p 10001:80 sologsb-1001
```

容器内的 nginx 监听 `80`。访问 `http://localhost:10001`。

## 数据说明

文档、版本快照和修改历史保存在浏览器 IndexedDB（数据库 `sologsb-1001`）。运行时不依赖后端，首次打开会写入可交互示例数据。
