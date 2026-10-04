# Z 项目文档

- [项目说明与使用方法](../README.md)
- [技术参考](technical-reference.md)
- `index.html`：Z 的简洁项目入口，介绍观察者并链接到当前项目文档。
- `assets/z-mark.svg`：Z 图标，与桌面应用使用相同设计。

本目录可作为静态站点发布，页面不依赖构建工具、远程字体或 JavaScript。

在仓库根目录本地预览：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

然后打开 `http://127.0.0.1:4173`。
