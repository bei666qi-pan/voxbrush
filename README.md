<p align="center">
  <img src="client/public/logo.svg" alt="声笔 VoxBrush" width="320"/>
</p>

<p align="center">
  <b>纯语音控制的 AI 绘图工具</b> —— 不碰鼠标，不碰键盘，开口即画。<br/>
  七牛云校招挑战作品 · 在线体验：<a href="https://qiniu.versecraft.cn">qiniu.versecraft.cn</a>
</p>

---

## 它能做什么

- 🎙️ **开口即画**：「在左上角画一个大的红色圆形」「写上"七牛云"，字号四十」
- 🧠 **复杂指令拆解**：「画一座房子，旁边一棵树，天上一个太阳」—— 大模型自动拆解为多步原语并构图
- 👁️ **视觉指代消解**：「把左边那个东西改成蓝色」—— 画布快照 + 多模态理解
- 🔄 **智能连续创作**：「再来一棵」「一样的颜色」—— 有记忆、能对话、代词接力（v1.3 新增）
- 📦 **语音宏**：「记住这个叫小屋」→「在右边画两个小屋」—— 对象组合快照，一键复用（v1.3 新增）
- 🎨 **AI 评画与美化**：「评价一下我的画」「帮我美化构图」—— AI 逐笔修改，可撤销（v1.3 新增）
- 🖌️ **AI 风格化渲染**：「把我的画渲染成水彩风」「来点吉卜力风格」—— 矢量画布经 Seedream img2img 输出风格皮肤，**矢量对象仍可继续修改**；「去掉风格」一键还原（v1.4 新增）
- 🔧 **领域语音纠错**：「申屠成水彩风」「记不力风格」等 ASR 误识别自动纠回正确指令词，HUD 展示「原文 → 纠错后」（v1.4 新增）
- 🪄 **物体级 AI 重绘**：「把我的画渲染成水彩风」「来点吉卜力风格」—— 矢量画布经 Seedream img2img 输出风格皮肤，**矢量对象仍可继续修改**；「去掉风格」一键还原（v1.4 新增）
- 🪄 **物体级 AI 重绘**：「把那棵树变成真实的樺花树」—— 因为对象可寻址，AI 只重绘你指名的那一个，在原位原尺寸替换（v1.5 新增）
- ✨ **产品级界面焕新**：深色科技质感 + 玻璃拟态 + 渐变光景{纯色破陶；状态文案随交互动态变化（授权前/授权中/聆听中），技术指标默认折叠为「查看技术细节」，普通用户也能轻松上手（v1.6 新增）
- ↩️ **全语音工作流**：选择 / 修改 / 移动 / 旋转 / 撤销 / 重做 / 清空 / 换背景 / 保存图片
- 🗣️ **即时反馈**：每条指令都有屏幕字幕确认与错误引导（已弃用机器音 TTS，杜绝回声自激）
- 📊 **延迟可观测**：HUD 实时显示 ASR / 理解 / 执行 各阶段耗时

## 风格渲染：场景图当骨架，生成模型当皮肤

<p align="center">
  <img src="docs/screenshots/watercolor-before-after.jpg" alt="水彩风格渲染前后对比" width="900"/>
</p>

纯语音摆好的矢量画布（左）→ 一句「把我的画渲染成水彩风」→ Seedream img2img 输出整幅水彩质感（右），
**构图、物体位置完全保留，矢量对象渲染后仍可继续「把房子改成蓝色」「撤销」**。
这正是相对「纯生图」路线的核心优势：既要生成观感，又不丢可控性。

## 架构亮点（详见 [docs/DESIGN.md](docs/DESIGN.md) · [业内调研](docs/INDUSTRY-RESEARCH.md)）

1. **自托管流式 ASR**：sherpa-onnx 流式 Zipformer（中英双语 int8）与业务同机部署，
   部分结果 <150ms，零跨境依赖，专为国内网络环境设计；
2. **三级指令理解流水线**：本地语法解析器（<5ms，覆盖 ~85% 高频指令）→ 豆包 Seed-1.6-flash
   Function 拆解 → 多模态画布理解，**简单指令绝不付出 LLM 延迟**；
3. **统一绘图 DSL**：三层输出收敛为同一套受 Schema 校验的操作原语，杜绝幻觉破坏画布；
4. **AK/SK 动态铸钥**：火山 SigV4 签名 `GetApiKey` 动态铸造临时 Ark API Key，自动续期，仓库零凭证；
5. **降级链路**：LLM 不可用 → 本地解析器兜底；服务端 ASR 异常 → Web Speech 引擎热切换。

## 本地运行

```bash
# 服务端（需先下载 ASR 模型到 server/models/asr，见 Dockerfile 阶段 3）
cd server && npm i && VOLC_AK=xxx VOLC_SK=xxx npm start
# 前端
cd client && npm i && npm run dev   # http://localhost:5173
```

Docker 一键构建（自动拉取 ASR 模型，国内镜像源）：

```bash
docker build -t voxbrush . && docker run -p 8080:8080 -e VOLC_AK=xxx -e VOLC_SK=xxx voxbrush
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `VOLC_AK` / `VOLC_SK` | 火山引擎访问密钥（用于动态铸造 Ark API Key） |
| `ARK_API_KEY` | （可选）直接指定方舟 API Key，跳过铸钥 |
| `ARK_MODEL` / `ARK_VISION_MODEL` | （可选）覆盖默认模型候选 |
| `ASR_TRAILING_SILENCE` | 端点检测尾静音秒数，默认 0.8 |

## 部署拓扑

GitHub（主仓库，PR 迭代）→ Gitee（国内镜像同步）→ Coolify（火山引擎 ECS 拉取构建）→ <https://qiniu.versecraft.cn>

## License

MIT
