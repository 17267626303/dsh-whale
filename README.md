# 大肥鱼 · DeepSeek Harness 桌宠

第一版只有四件事：**拖动、喂食、摸头、跟随任务状态做出反应**。

![大肥鱼桌宠预览](artifacts/fatfish-idle-preview.png)

本地动画，不需要 API Key，也不会额外调用模型。

## 安装和启动（Windows x64）

1. 从 [v0.1.1 Release](https://github.com/17267626303/dsh-whale/releases/tag/v0.1.1) 下载 `fatfish-desktop-windows-x64.zip` 并解压，保留整个文件夹。
2. 打开 **DeepSeek Harness 桌面客户端 → 设置 → 插件 → 添加插件**。
3. 在“包名或地址”中填入解压文件夹内 `dsh-whale-companion-0.1.1.tgz` 的完整路径。旧版用户先在插件管理中卸载同名插件，再导入新版；计数会保留。
4. 安装后点击 **立即启用**。如客户端提示需要重启，退出并重新打开 DSH。
5. 双击同一文件夹内的 **WhaleCompanion.exe**。

桌宠会出现在 Windows 桌面的右下角，保持透明、置顶；DSH 最小化后也能看见。客户端内同时提供悬浮版本，独立桌宠运行时自动隐藏客户端内的角色。启动后自动发现 DSH 动态端口，无需手填端口。

仅安装插件、不启动独立小窗时，会在 DSH 界面内显示大肥鱼。退出桌宠可用角色菜单或系统托盘右键菜单；关闭 DSH 后桌宠仍可拖动、喂食、摸头，任务联动将在 DSH 启动后自动恢复。

## 怎么玩

| 操作 | 效果 |
| --- | --- |
| 按住角色拖动 | 移动桌宠，松手后保留位置 |
| 点击“喂食” | 大肥鱼吃饭并开心回应 |
| 点击“摸头”，或长按角色约 0.65 秒 | 摸头、摇头和爱心动画 |
| 单击角色 | 轻轻摸摸头 |
| 任务开始 | 思考或工作动画 |
| 任务完成 | 跳跃庆祝 |
| 任务失败 | 失落反应 |
| 等待审批 | 等待提示；在 DSH 中处理审批 |

## 从源代码运行

插件宿主和网页动画不需要额外 npm 依赖，要求 Node.js 22 或更新版本。

在 DSH 的插件添加页面，直接填入本仓库目录的绝对路径，也可安装 `npm pack` 生成的 `.tgz`。

独立桌宠使用 Electron：

```powershell
npm --prefix desktop install
npm --prefix desktop start
```

如需要指定独立 DSH 实例：

```powershell
npm --prefix desktop start -- --url http://127.0.0.1:3080
# 或使用该实例的 DSH_HOME，自动读取端口发现文件
npm --prefix desktop start -- --home C:\path\to\dsh-home
```

只接受本机 HTTP(S) 地址。`DSH_PET_URL` 也可指定地址；优先级为 `--url`、环境变量、端口发现文件、默认 `127.0.0.1:3080`。

CLI Web 版可这样安装：

```powershell
dsh plugin --profile web add "C:\absolute\path\to\deepseek-whale-companion"
```

桌面客户端的 `desktop` 配置由客户端管理，请通过上面的插件页面安装。

## 预览、验证与打包

```powershell
npm run preview         # http://127.0.0.1:4318，任务状态按钮为演示
npm test
node --test desktop/test/*.test.cjs
npm run check
node scripts/host-smoke.mjs  # 使用本机已安装 DSH 所带的真实 Cordis
node scripts/ui-smoke.mjs    # 先启动 preview；实际启动 Electron 后自动退出
npm pack
npm run desktop:pack
```

Electron 打包产物在 `dist/FatWhaleCompanion-win32-x64/`，需要保留整个文件夹，不能仅复制 `.exe`。下载运行时较慢时，可为构建进程设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；下载按 Electron 包内的校验和验证。

插件计数保存在 `<DSH_HOME>/data/dsh-whale-companion/state.json`，端口记录为同目录 `connection.json`。桌宠位置保存在 Electron 用户数据目录。卸载插件不会删除计数；退出桌宠会释放桌面占用标记，异常退出后标记最多 15 秒自动过期。

## 验证范围

依据本机 DSH Desktop **0.2.0-rc.2** 的源码确认了插件安装、模块加载、路由及事件接口；用真实 Cordis 完成隔离加载测试，并在 Electron 中验证交互和模拟宿主任务事件。没有改动现有 DSH 配置，尚未在用户当前会话中执行端到端任务测试。其他版本需要核对其插件接口。

## 参考

插件代码 MIT 许可。非官方 DSH 插件。
