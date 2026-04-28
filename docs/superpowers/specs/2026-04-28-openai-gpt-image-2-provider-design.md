# OpenAI gpt-image-2 Provider 接入设计

## Problem

jdy-imagine 当前只支持 Google Gemini 一个 provider（`scripts/main.ts:7` 的 `PROVIDERS` 注册表只挂了 `google`）。需要新增 OpenAI gpt-image-2 provider，至少对齐 codex 内置 imagegen skill 的显式 CLI fallback `scripts/image_gen.py` 的基本功能：

- `generate`：文生图 + 图生图（refs）
- `edit`：含 mask 的图像编辑
- `generate-batch`：批量生成

接入过程中暴露了现有抽象层的几处别扭：mask 字段缺位、`finishReason` 含 LLM-only 的 `MAX_TOKENS`、`safetyInfo.category` 强 Gemini 化、provider 切换不联动 model 默认值、`refs` 在两家语义错位（Google 是参考图，OpenAI 走 `/edits` 是编辑目标）。本设计一并修正。

## Scope

**in-scope**：
- 新建 `scripts/providers/openai.ts`：generate（路由 generations / edits）、服务端 batch（Files API + `/v1/batches`）
- HTTP 层重构：headers map 化、新增 multipart 支持
- Provider factory 接口升级：`(apiKey, baseUrl) => Provider` → `(ProviderConfig) => Provider`
- 现有抽象修正：新增 `mask?` / `editTarget?`、`finishReason` 删 `MAX_TOKENS` 加 `ERROR`、`safetyInfo.category` 改 optional、provider 切换联动 default model
- 新增 CLI flag：`--edit <path>` / `--mask <path>`
- 文档：能力矩阵 + 双 provider 配置说明

**out-of-scope**：
- prompt augmentation 全家桶（`--use-case` `--style` `--composition` 等本地 prompt 模板字段）
- 本地工具：`--dry-run` / `--downscale-*` / `--prompt-file` / `--moderation` / `--output-compression`
- `gpt-image-1.5` / 真透明背景 `--background transparent`
- OpenAI 的 4K / 任意尺寸（按尺寸映射方案 A 已 acknowledge 砍掉）
- AuthStrategy 抽象（等接第 3 个 provider 时再视情况引入）
- chain mode 在 OpenAI 上的支持（OpenAI image API 无状态）

## 关键决策汇总

| 维度 | 决定 | 理由 |
|---|---|---|
| 接入范围 | generate + edit + 服务端 batch + mask | 对齐 image_gen.py 三大子命令 |
| 最小 API 字段 | model, prompt, size, quality, n=1, output_format=png, mask, input_fidelity | 跳过 prompt 模板 / dry-run 等本地工具 |
| 尺寸映射 | (quality + ar) → 静态 SIZE_TABLE → OpenAI WIDTHxHEIGHT，不暴露 `--size` | 保持 jdy-imagine 抽象层 UX 一致；4K 是边缘需求 |
| HTTP/Provider 重构 | 中间档：headers map + Provider factory 接 ProviderConfig，不抽 AuthStrategy | 留扩展空间但不为虚构未来设计 |
| `refs` 多义性 | 保留参考图语义；新增 `--edit` 显式表达"待编辑" | 用户可在抽象层表达意图；Google 端 `--edit` fallback 当 ref[0] |
| Provider 切换 联动 model | `resolveConfig` 不再写死 default；未传 `--model` 时取 `provider.defaultModel` | 修复隐含耦合 |
| `mask` 在 Google | provider 收到时 throw | 不静默丢弃 |
| `chain` 在 OpenAI | provider 不实现 `generateChained`，generate.ts 现有逻辑自动 throw | OpenAI image API 无状态 |
| 服务端 batch + edit | OpenAI batch 不支持 multipart endpoint，含 `editTarget` 任务 → throw | 不做降级 |
| 错误映射 | OpenAI 400 + `moderation_blocked` → `finishReason="SAFETY"`；其他 400 → `"ERROR"` | 跟 Gemini 抽象层统一 |
| Env 变量 | `OPENAI_API_KEY` / `OPENAI_BASE_URL`（默认 `https://api.openai.com`）/ `OPENAI_IMAGE_MODEL`（默认 `gpt-image-2`） | 标准命名 |

---

## §1 Architecture

### 数据流

```
CLI args → main.ts → resolveConfig → providerFactory(ProviderConfig) → provider
                                                                          ↓
                                  generate.ts / batch.ts ────→ provider.generate() / .batchCreate()
                                                                          ↓
                                                             OpenAI API / Google API
                                                                          ↓
                                                                  GenerateResult
                                                                          ↓
                                                                   写入 outdir
```

### 文件改动

| 文件 | 状态 | 改动 |
|---|---|---|
| `scripts/lib/http.ts` | 重构 | `httpPost/httpGet` 签名 `(url, body, apiKey)` → `(url, body, headers)`；新增 `httpPostMultipart(url, formData, headers)`；retry/proxy/curl 分支同步 |
| `scripts/lib/config.ts` | 改造 | 按 `provider` 字段选 env 组（GOOGLE_* vs OPENAI_*）；移除 `DEFAULTS.model`（改由 provider 兜底） |
| `scripts/lib/args.ts` | 改造 | 新增 `--edit <path>` / `--mask <path>` |
| `scripts/providers/types.ts` | 改造 | 新增 `ProviderConfig` 接口；`ProviderFactory` 改签名；`GenerateRequest` 加 `mask?` / `editTarget?`；`GenerateResult.finishReason` 删 `MAX_TOKENS` 加 `ERROR`；`safetyInfo.category` 改 optional |
| `scripts/providers/google.ts` | 改造 | factory 适配 `ProviderConfig`；headers 自管 `x-goog-api-key`；`editTarget` fallback 当 `refs[0]`；`mask` 非空 throw |
| `scripts/providers/openai.ts` | 新建 | factory + generate（路由）+ batchCreate/Get/Fetch/List/Cancel + mapToOpenAISize 表 + headers 拼接 + 错误映射 |
| `scripts/main.ts` | 改造 | `PROVIDERS` 注册 `openai`；factory 调用改为 `ProviderConfig`；config.model 为空时用 `provider.defaultModel` 兜底 |
| `scripts/commands/generate.ts` | 小改 | flags.edit / flags.mask 透传到 `GenerateRequest`；新增 `validateProviderCapabilities()` |
| `scripts/commands/batch.ts` | 小改 | mask/editTarget 透传；payload 估算考虑 mask；OpenAI batch + editTarget 校验 |
| `SKILL.md` | 改 | 描述提到双 provider；新增 `--provider openai` 用法和 `OPENAI_API_KEY` 配置 |
| `README.md` | 改 | 加能力矩阵表；同步 env 配置说明 |
| 各 `*.test.ts` | 加 case | 见 §4 |

### 模块职责

```
scripts/main.ts        路由 + provider 装配
scripts/commands/      业务流程，provider-agnostic
scripts/providers/     抽象层 + 各家实现
  types.ts             interfaces only
  google.ts            Gemini-specific
  openai.ts            OpenAI-specific (NEW)
scripts/lib/           跨 provider 通用工具
  http.ts              headers map（不绑定特定 auth）
  config.ts            env + flags 解析
  files.ts / args.ts / character.ts / output.ts
```

边界：`commands/` 永不直接调任一家 API；`providers/` 永不直接读 CLI flags。

---

## §2 Data Structures

### `scripts/providers/types.ts`

```ts
// 新增：Provider 配置
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  // 未来 region/orgId/projectId 等扩这里，不动 factory 签名
}

export type ProviderFactory = (config: ProviderConfig) => Provider;

// 修订：GenerateRequest
export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  quality: "normal" | "2k";
  refs: string[];                 // 参考图（风格/构图样板）
  imageSize: "1K" | "2K" | "4K";
  editTarget?: string;            // NEW: 待编辑目标图
                                  //   OpenAI: 路由到 /v1/images/edits
                                  //   Google: fallback 当 refs[0]
  mask?: string;                  // NEW: 仅 OpenAI edit 生效
                                  //   Google: provider 收到时 throw
}

// 修订：GenerateResult
export interface GenerateResult {
  images: Array<{ data: Uint8Array; mimeType: string }>;
  finishReason: "STOP" | "SAFETY" | "ERROR" | "OTHER";  // 删 MAX_TOKENS，加 ERROR
  safetyInfo?: {
    category?: string;            // 改 optional（OpenAI 不填）
    reason: string;
  };
  textParts?: string[];           // OpenAI 永远 undefined
}

// Provider 接口（不变，chain/batch 仍 optional）
export interface Provider {
  name: string;
  defaultModel: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateAndAnchor?(req: GenerateRequest): Promise<{ result: GenerateResult; anchor: ChainAnchor }>;
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}
```

### `scripts/lib/config.ts`

```ts
export interface Config {
  provider: string;          // "google" | "openai"
  model: string;             // 未传时为空字符串，main.ts 用 provider.defaultModel 兜底
  quality: "normal" | "2k";
  ar: string;
  apiKey: string;
  baseUrl: string;
}

// 解析顺序：
// 1. provider := cliFlags / extendMd / "google"
// 2. 按 provider 选 env：
//    google → GOOGLE_API_KEY|GEMINI_API_KEY + GOOGLE_BASE_URL + GOOGLE_IMAGE_MODEL
//    openai → OPENAI_API_KEY + OPENAI_BASE_URL(默认 https://api.openai.com) + OPENAI_IMAGE_MODEL
// 3. model := cliFlags.model > extendMd.default_model > env.<PROVIDER>_IMAGE_MODEL > ""
// 4. apiKey 不能为空（否则 main.ts 报错）
```

### `scripts/lib/args.ts`

```ts
export interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional?: string;
  flags: {
    prompt?: string;
    prompts?: string;
    model?: string;
    provider?: string;
    ar?: string;
    quality?: string;
    ref?: string[];
    edit?: string;          // NEW
    mask?: string;          // NEW
    outdir: string;
    json: boolean;
    async: boolean;
    chain: boolean;
    character?: string;
  };
}
```

### OpenAI provider 内部（不进 types.ts）

```ts
// SIZE_TABLE: (quality, ar) → OpenAI WIDTHxHEIGHT
const SIZE_TABLE: Record<"normal" | "2k", Record<string, string>> = {
  normal: {
    "1:1":  "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "3:2":  "1536x1024",
    "2:3":  "1024x1536",
    "4:3":  "1280x960",   // 16 倍数最近邻
    "3:4":  "960x1280",
  },
  "2k": {
    "1:1":  "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2":  "2304x1536",
    "2:3":  "1536x2304",
    "4:3":  "2048x1536",
    "3:4":  "1536x2048",
  },
};

// Quality 映射
//   normal → "medium"
//   2k     → "high"
//   不暴露 low / auto

// Generations payload (无 editTarget 时)
type OpenAIGenerationsPayload = {
  model: string;
  prompt: string;
  n: 1;                     // 锁 1
  size: string;
  quality: "low" | "medium" | "high" | "auto";
  output_format: "png";
};

// Edits multipart fields (editTarget 非空时)
//   image: editTarget 在首位 + refs 跟随
//   mask: 可选
//   不传 input_fidelity（gpt-image-2 强制 high）

// Batch JSONL 行
type OpenAIBatchLine = {
  custom_id: string;        // 复用 jdy-imagine "001-slug"
  method: "POST";
  url: "/v1/images/generations";   // batch 仅支持 generations，不支持 edits
  body: OpenAIGenerationsPayload;
};
```

### 关键映射表

| jdy-imagine | OpenAI | 备注 |
|---|---|---|
| `quality: "normal"` | `quality: "medium"` | 跳过 low |
| `quality: "2k"` | `quality: "high"` | |
| `(quality, ar)` | `size: "WxH"` | 查 SIZE_TABLE |
| `editTarget + refs[]` | `image[]`（multipart） | editTarget 首位 |
| `mask` | `mask`（multipart 单文件） | |
| `data[].b64_json` | `images[].data` (Uint8Array) | base64 解码 |

---

## §3 Business Flow

### 3.1 generate 命令

```
parseArgs → resolveConfig → PROVIDERS[provider](ProviderConfig) → provider
                          → if !config.model: config.model = provider.defaultModel
                          ↓
runGenerate:
├─ validateGenerateArgs (existing)
├─ validateProviderCapabilities (NEW):
│   ├─ flags.mask && provider.name !== "openai" → throw
│   ├─ flags.mask && !flags.edit → warn (软警告)
│   └─ flags.chain && !provider.generateChained → throw
├─ loadCharacter / loadPrompts (existing)
├─ for each task:
│   build GenerateRequest{prompt, model, ar, quality, refs, imageSize, editTarget, mask}
└─ provider.generate(req) → ROUTE inside openai.ts:
                            ├─ if editTarget: buildEditFormData → POST /v1/images/edits (multipart)
                            └─ else: buildGenerationsPayload → POST /v1/images/generations (JSON)
                                                              ↓
                                                       response.data[].b64_json
                                                              ↓
                                                       mapToGenerateResult
                                                              ↓
                            handle finishReason → writeImage(outdir, ...)
```

### 3.2 batch 命令（OpenAI 服务端）

```
batch submit prompts.json
─────────────────────────
batchSubmit (existing):
├─ load tasks, apply character (existing)
├─ validateBatchTasks (NEW):
│   └─ openai && tasks.some(editTarget) → throw "OpenAI 服务端 batch 不支持图像编辑"
├─ provider.batchCreate(req) → openai.batchCreate:
│   ├─ buildOpenAIBatchJsonl(tasks):
│   │   每行 {custom_id, method:"POST", url:"/v1/images/generations", body: payload}
│   ├─ uploadFile(jsonl, "batch") → POST /v1/files (multipart) → fileId
│   ├─ POST /v1/batches:
│   │   {input_file_id: fileId,
│   │    endpoint: "/v1/images/generations",
│   │    completion_window: "24h"}
│   └─ return BatchJob{id: "batch_xxx", state, createTime}
├─ saveManifest (existing)
└─ if !async: pollAndFetch (existing)

batch fetch <jobId>
───────────────────
provider.batchFetch(jobId) → openai.batchFetch:
├─ GET /v1/batches/{id} → output_file_id
├─ GET /v1/files/{output_file_id}/content → JSONL
└─ for each line: parse → BatchResult[]
```

**关键限制**：OpenAI 服务端 batch 只支持 `/v1/images/generations`（JSON body），**不支持 `/v1/images/edits`（multipart）**。含 `editTarget` 的任务在 batch 路径上 throw，不做降级。

### 3.3 错误映射

| OpenAI 真实响应 | jdy-imagine 抽象层 |
|---|---|
| 200 + `data[]` | `{images, finishReason: "STOP"}` |
| 400 + `error.code = "moderation_blocked"` | `{images: [], finishReason: "SAFETY", safetyInfo: {reason: error.message}}` |
| 400 + `error.code = "content_policy_violation"` | 同上 |
| 400 其他 | `{images: [], finishReason: "ERROR", safetyInfo: {reason: error.message}}` |
| 401 / 403 | `throw new Error("OpenAI auth failed: ...")` |
| 429 / 500 / 503 | `lib/http.ts` 现有 retry → 失败仍 throw |

### 3.4 能力矩阵

| Flag / 能力 | Google | OpenAI | 备注 |
|---|---|---|---|
| `--prompt` | ✓ | ✓ | |
| `--ref <path>` | ✓ | ✓ | 两家都视为参考图 |
| `--edit <path>` | ✓ fallback | ✓ 原生 | Google 当 ref[0]，OpenAI 路由 /edits |
| `--mask <path>` | × throw | ✓（需 --edit） | |
| `--ar` | ✓ | ✓ | OpenAI 经 SIZE_TABLE |
| `--quality normal\|2k` | ✓ | ✓ | OpenAI 映射 medium/high |
| `--chain` | ✓ | × throw | OpenAI image API 无状态 |
| `--character` | ✓ | ✓ | provider-agnostic |
| `batch submit` | ✓ | ✓ | OpenAI 用服务端 /v1/batches |
| `batch submit --async` | ✓ | ✓ | |
| Batch 含 editTarget | ✓ | × throw | OpenAI batch 不支持 multipart |
| 4K / 任意尺寸 | × | × | 按方案 A 砍掉 |
| 真透明背景 | × | × | gpt-image-2 不支持 |

### 3.5 校验顺序（fail-fast）

`runGenerate` 主循环前预检查：

```
1. validateGenerateArgs() — 现有：prompt/prompts 互斥
2. validateProviderCapabilities() — NEW：
   - flags.mask && provider.name !== "openai" → throw
   - flags.mask && !flags.edit → warn
   - flags.chain && !provider.generateChained → throw
3. (batch 路径) validateBatchTasks() — NEW：
   - provider.name === "openai" && tasks.some(t => t.editTarget) → throw
```

---

## §4 Testing Strategy

### 测试基线
现有套件全部保持绿灯：`args.test.ts` / `batch.test.ts` / `character.test.ts` / `config.test.ts` / `files.test.ts` / `generate.test.ts` / `http.test.ts` / `output.test.ts` / `types.test.ts` / `google.test.ts` / `integration.test.ts`。

### 新增 / 修改清单

| 文件 | 状态 | 关键测试 |
|---|---|---|
| `scripts/providers/openai.test.ts` | 新建 | SIZE_TABLE 表驱动（quality × ar 全覆盖）；`mapToOpenAIQuality()`；`buildGenerationsPayload(req)`；`buildEditFormData(req)`（含 mask）；`parseOpenAIResponse()`（b64 解码）；`mapOpenAIError()`（moderation_blocked → SAFETY；invalid_size → ERROR；401 → throw）；`buildOpenAIBatchJsonl(tasks)`；5 个 batch 方法 mock 测试；editTarget 在 batch tasks → throw |
| `scripts/lib/http.test.ts` | 改造 | 新签名 `(url, body, headers)`；`httpPostMultipart` 新增；retry/proxy/curl 分支适配 headers map |
| `scripts/lib/config.test.ts` | 改造 | provider="openai" 读 OPENAI_*；provider="google" 读 GOOGLE_/GEMINI_*（回归）；model 未指定时为空 |
| `scripts/lib/args.test.ts` | 改造 | `--edit` / `--mask` 解析 |
| `scripts/providers/google.test.ts` | 改造 | factory 接 `ProviderConfig`；headers 自管 `x-goog-api-key`；editTarget fallback 当 ref[0]；mask 非空 throw |
| `scripts/providers/types.test.ts` | 改造 | finishReason 不再有 MAX_TOKENS；safetyInfo.category optional |
| `scripts/commands/generate.test.ts` | 改造 | `validateProviderCapabilities()`；mask + 非 openai → throw；chain + 无 generateChained → throw；flags.mask / flags.edit 透传 |
| `scripts/commands/batch.test.ts` | 改造 | OpenAI batch + editTarget → throw；payload 估算考虑 mask |
| `scripts/integration.test.ts` | 加路径 | mock OpenAI server（拦截 fetch）；generate text-to-image / edit with mask / batch submit-status-fetch 端到端 |

### Mock 策略

- 不调真实 OpenAI API：openai.test.ts 通过依赖注入或 mock 覆盖 `httpPost`/`httpPostMultipart`/`httpGet`
- integration.test.ts 用 Bun mock API 拦截 fetch，模拟 OpenAI 响应（200 + b64 / 400 + moderation_blocked / 429 retry）
- Files API + `/v1/batches` mock 完整生命周期：upload → create batch → poll → fetch output file

### 测试覆盖度门槛

不强制覆盖率数字。底线：
- openai.ts 每个公开方法至少 1 条 happy path + 1 条 error path
- SIZE_TABLE 表驱动覆盖所有 (quality × ar) 组合
- 错误映射表里每个 OpenAI error.code 至少 1 条 case

---

## §5 Implementation Plan (Commit Order)

按依赖顺序，每步独立绿灯：

### Step 1 — HTTP 层 headers map 化（无功能改动，纯重构）
- `lib/http.ts`：`httpPost/httpGet` 签名 `(url, body, apiKey) → (url, body, headers)`；新增 `httpPostMultipart`
- `lib/http.test.ts` 适配
- `providers/google.ts`：调用方传 `googleHeaders(apiKey)`
- `providers/google.test.ts` 适配
- 验收：所有现有 Google 测试绿灯，无功能变更

### Step 2 — Provider factory + 类型重构
- `providers/types.ts`：新增 `ProviderConfig` / `ProviderFactory`；`GenerateRequest` 加 `mask?` / `editTarget?`；`GenerateResult.finishReason` 删 `MAX_TOKENS` 加 `ERROR`；`safetyInfo.category` optional
- `providers/google.ts`：factory 改为 `(ProviderConfig) => Provider`；editTarget fallback 当 ref[0]；mask throw
- 把 `mapQualityToImageSize` 从 `providers/google.ts` 移到 `providers/types.ts`（这是 provider-agnostic 的枚举映射，generate.ts / batch.ts 不应依赖 google.ts）
- `providers/google.test.ts` / `providers/types.test.ts` 适配
- `main.ts`：factory 调用方式改
- 验收：Google 全部绿灯，新字段对 Google 工作正常

### Step 3 — config + args 适配
- `lib/config.ts`：按 provider 选 env；移除 model 默认值
- `lib/args.ts`：新增 `--edit` / `--mask` flag
- 对应测试
- `main.ts`：拿到 config 后用 `provider.defaultModel` 兜底空 model
- 验收：`--provider google` 默认行为不变；`--provider openai` 但无 openai.ts 时报"unknown provider"

### Step 4 — OpenAI provider 核心（generate + edit 路由）
- `providers/openai.ts`：factory + `generate()`（路由 generations/edits）+ `mapToOpenAISize` + `mapOpenAIError`
- `providers/openai.test.ts`：unit case
- `main.ts` PROVIDERS 注册 openai
- 验收：`--provider openai --prompt "..."` 能跑通（mock 环境下）

### Step 5 — OpenAI batch（Files API + /v1/batches）
- `providers/openai.ts`：增加 `batchCreate/Get/Fetch/List/Cancel`
- `providers/openai.test.ts`：batch case
- `commands/batch.ts`：增加 OpenAI batch + editTarget 校验
- 验收：`--provider openai batch submit prompts.json` 能跑通

### Step 6 — 命令层 wiring + 能力校验
- `commands/generate.ts`：flags.edit/mask 透传；增加 `validateProviderCapabilities()`
- `commands/generate.test.ts` 补 case
- 验收：mask + Google → 报错；chain + OpenAI → 报错

### Step 7 — 文档
- `SKILL.md`：双 provider 支持、`OPENAI_API_KEY` 配置、能力矩阵简表
- `README.md`：完整能力矩阵、env 配置、`--edit` / `--mask` 用法示例
- 验收：用户读 README 能找到所有新增能力 + 限制

### Step 8 — Integration test
- `scripts/integration.test.ts`：mock OpenAI server，端到端 generate/edit/batch 三路径
- 验收：CI 全绿，与现有 Google integration 路径并存

每步对应一个原子 commit。Step 1-3 是基础重构（不引入新功能），Step 4-6 是 OpenAI 新能力，Step 7-8 是文档 + 端到端。

---

## Risks & Known Limitations

1. **OpenAI batch 不支持 edits 端点**：multipart endpoint 无法在 batch JSONL 里编码。`editTarget` 任务在 batch 路径必须 throw，不做降级。
2. **OpenAI 4K / 任意尺寸能力被砍**：尺寸映射方案 A 选定后，OpenAI 只能输出 SIZE_TABLE 中的 7 × 2 = 14 种规格。用户拿不到 3840x2160。如未来需求出现，可加 `--size` 旁路（方案 B）。
3. **真透明背景不支持**：gpt-image-2 不支持 `background=transparent`。需要时只能切 codex 内置 `image_gen` + chroma-key 流程，本设计不覆盖。
4. **lib/http.ts 重构破坏面**：所有调用方（google.ts 现有所有方法）签名要同步改。Step 1 必须严格保持 Google 测试绿灯。
5. **错误码列表不完备**：当前只列了 `moderation_blocked` / `content_policy_violation` 两个明确映射到 SAFETY 的 error.code。如有其他需要 SAFETY 语义的 code，运行后再补。
6. **AuthStrategy 留白**：未来接第 3 个 provider 时，如果 header 拼接逻辑高度重复，应抽 AuthStrategy。本次不做。
7. **`--mask` CLI flag 仅 generate 模式生效**：batch 模式下，每任务的 mask 应来自 prompts.json 的字段（本设计不扩 prompts.json schema 加 mask 字段），CLI 顶层的 `--mask` 在 batch 模式下被忽略。如未来要支持 batch + mask，需在 prompts.json 加 `mask` 字段并扩 batch.ts 解析逻辑。

---

## References

- [OpenAI GPT Image 2 Model Docs](https://developers.openai.com/api/docs/models/gpt-image-2)
- [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch)
- [OpenAI Image Generation Guide](https://developers.openai.com/api/docs/guides/image-generation)
- Codex imagegen skill: `/Users/jdy/.codex/skills/.system/imagegen/SKILL.md`
- Codex CLI fallback: `/Users/jdy/.codex/skills/.system/imagegen/scripts/image_gen.py`
- 历史 spec：`docs/superpowers/specs/2026-04-13-jdy-imagine-design.md`、`docs/superpowers/specs/2026-04-14-batch-file-based-design.md`
