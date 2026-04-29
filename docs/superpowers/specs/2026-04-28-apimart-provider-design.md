# apimart gpt-image-2 Provider 接入设计

> **Corrigendum (post-PR #5)：** 落地实现的 `RETRYABLE_STATUS` 实际为 `{0, 429, 500, 502, 503}`，比本文各处出现的 `{429, 500, 502, 503}` 多一个 `0`。原因：`httpGetBytes` 在网络失败时返回 `status=0`（而 `httpPost` / `httpGet` 用 `503` 作为同类哨兵），下载路径要在重试集合里覆盖 `0` 才能复用同一套 `callWithApimartRetry`。本文档下方所有 `{429,500,502,503}` 引用均按 `{0,429,500,502,503}` 解读。

## Problem

jdy-imagine 当前支持两个 provider：Google Gemini（本地参考图 + Files API batch）和 OpenAI gpt-image-2 直连（multipart + 服务端 batch）。用户在中国大陆使用 OpenAI 直连时受跨境网络制约（multipart 上传不走 HTTPS_PROXY，详见 README 能力矩阵），且无 4K / 扩展 aspect ratio 支持。

apimart（`https://api.apimart.ai`）是国内的 gpt-image-2 网关，覆盖以下能力差：

- 国内免代理直访
- 4K 输出（仅 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六种 ar）
- 扩展 aspect ratio：5:4 / 4:5 / 2:1 / 1:2 / 21:9 / 9:21（共 13 种）
- API 形态完全异步：submit → poll → 结果 URL，与现有同步 provider 完全不同

接入 apimart 的过程同时要解决两笔抽象债：

1. **`quality` 字段语义二义性**：现有 `quality: "normal" | "2k"` 同时承担"分辨率档位"和"清晰度档位"两个独立维度。Gemini 端实际无效；OpenAI 端 `mapToOpenAIQuality` 把 normal/2k 映射到 medium/high（清晰度），同时 SIZE_TABLE 把 normal/2k 映射到 1024/2048（分辨率）。apimart 直接区分 `resolution: 1k|2k|4k`（分辨率）和 `quality: auto|low|medium|high`（清晰度），是两个独立维度。本次拆开 `--quality` 还掉这笔债。
2. **provider 收到不支持的 `ar` 时静默兜底 vs 显式 throw**：现有 `--ar` 只有 7 种值，扩展到 13 种后 Google / OpenAI 收到非自家支持的 ar 必须 throw（不静默映射），保持能力矩阵真实。

## Scope

**in-scope**：

- 新建 `scripts/providers/apimart.ts`：异步 generate（apimart 上传 / 提交 / 轮询 / 下载）；batch 方法不实现（命令层 throw）
- 新建 `lib/http.ts` 的 `httpGetBytes` raw helper（无内置 retry）：下载 PNG/JPEG 二进制，不走 JSON.parse；retry 由各 provider 自管（apimart 在 callWithApimartRetry 内统一处理）
- 新增 Provider 接口可选方法 `validateRequest?(req): void`：让命令层在主循环前对所有 GenerateRequest 做 fail-fast 预检
- 抽象债重构：`GenerateRequest` 删 `quality` / `imageSize`，新增 `resolution` + `detail`；CLI 删 `--quality`，新增 `--resolution` + `--detail`
- AR 枚举从 7 种扩到 13 种；各 provider 在自家不支持的 ar 上 throw
- 新增 `--provider apimart` 路径；`PROVIDERS` 注册
- env 新增 `APIMART_API_KEY` / `APIMART_BASE_URL`（默认 `https://api.apimart.ai`）/ `APIMART_IMAGE_MODEL`（默认 `gpt-image-2-official`）
- 文档：能力矩阵新增 apimart 列；migration 章节（quality → resolution+detail，覆盖 CLI flag、EXTEND.md、prompts.json 三处）

**out-of-scope**：

- apimart 的 `n>1`（多图并发）：写死 `n=1`，与其他 provider 一致
- apimart 的 `output_format` 选择（jpeg/webp）：写死 `png`
- apimart 的 `output_compression`：不暴露
- apimart 的 `background` 透明背景：API 文档明示不支持，沿用 default `auto`
- apimart 的 `moderation: low`：不暴露 CLI flag，写死 `auto`
- apimart batch（无成本优势的"批量轮询"端点）：命令层 throw "use generate --prompts"
- apimart chain mode：API 异步无状态，无法实现，throw（与 OpenAI 一致）
- Cloudflare R2 / wrangler / 自建图床：apimart 自身的 `/v1/uploads/images` 已返回 72h 有效公开 URL，**不再需要外部图床**。R2 路径的 wrangler login、bucket setup、lifecycle 配置、cleanup 逻辑全部删除（详见 Architecture / Risks）
- task `cancelled` 之外的取消子命令：apimart 文档列出 `cancelled` 状态但本 spec 不实现 `--cancel` flag
- `--resume <task_id>`：timeout 时打印 task_id 让用户在 apimart 控制台手动跟进；不实现持久化恢复（详见 Risks）

## 关键决策汇总

| 维度 | 决定 | 理由 |
|---|---|---|
| Provider 装配 | 独立 `apimart.ts`，与 `openai.ts` 并列 | API 契约（async vs sync、URL refs vs multipart、URL 输出 vs base64）跨界差异太大 |
| 本地图传递 | 自动调 apimart `POST /v1/uploads/images` 上传，得到 72h URL 直传给生成接口 | apimart 自身有上传端点，URL 自动 72h 过期；零外部依赖；零 setup |
| 上传 cache | 按文件内容 sha256 在 run-scoped Map 缓存 URL；同一 run 内重复上传命中 cache | character profile 注入的 refs 会在每个 prompt 重复出现，避免重复上传 |
| 异步执行模型 | provider 内部完成"上传→提交→轮询→下载"全流程，对 commands/ 呈现同步 `generate()` 接口 | 隔离异步细节；Provider 接口不变形 |
| Cleanup | 不主动清理；apimart 上传 URL 72h 自动过期 | 零状态管理；进程异常 / timeout 都安全（72h 内任务通常已完成或被遗弃） |
| `quality` 抽象债 | 一次拆成 `--resolution` + `--detail`，无 alias | 抽象正确性优先；不积"alias 半遗忘"债 |
| Migration 默认值 | `default_resolution=2k` + `default_detail=high`（保持现有 `--quality 2k` 等价行为） | OpenAI provider 现有 `quality=2k` 映射 high；不能默认 `auto` 改变行为 |
| AR 扩展 | 13 种全暴露；非自家支持的 ar 各 provider throw | 能力矩阵真实；不静默兜底 |
| 4K 暴露 | apimart 接受 `resolution=4k`；google/openai throw | 单维度精确扩展；其他 provider 不污染 |
| Fail-fast 预检 | Provider 接口加可选 `validateRequest(req)`；命令层主循环前对所有 task 调用 | 避免 prompts.json 第 N 个 task 才 throw、前 N-1 个已计费 |
| apimart batch | 命令层 throw | 无成本优势；fan-out 假装支持会污染抽象 |
| apimart chain | 不实现 `generateChained`，命令层现有逻辑自动 throw | 异步无状态 |
| apimart `n` / `output_format` / `moderation` / `background` | 全部写死 | YAGNI；CLI 公开面最小化 |
| 异步轮询参数 | 初始 12s + 间隔 3s + 超时 180s；timeout 时打印 task_id | 文档建议范围中位数；timeout 给用户控制台跟进线索 |
| 错误映射 | task `error.{code,message,type}`（含别名 `fail_reason`），关键词含 `moderation`/`policy`/`unsafe` → SAFETY；其他 fail → ERROR；HTTP 401/402/403 → throw；HTTP 429/500/502 → retry | 与现有抽象层统一 |
| Task 状态 union | `submitted\|pending` → pending；`in_progress\|processing` → running；`completed`、`failed`、`cancelled` 直传；未知状态 default → pending（保守） | apimart 两套文档（GPT-Image-2 vs 通用 tasks/status）状态名不一致，必须接受别名 |

---

## §1 Architecture

### 数据流

```
CLI args
  ├─ --provider apimart
  ├─ --resolution 1k|2k|4k
  ├─ --detail auto|low|medium|high
  ├─ --ar (13 values)
  ├─ --ref / --edit / --mask <local_path>
  ↓
parseArgs → resolveConfig (provider="apimart" → 选 APIMART_* env)
  ↓
PROVIDERS["apimart"](ProviderConfig) → apimartProvider
  ↓
runGenerate (commands/generate.ts)：
  ├─ validateGenerateArgs (existing)
  ├─ validateProviderCapabilities (existing；不在此处做 16-image 检查):
  │     - flags.mask && !flags.edit && !flags.ref → throw（CLI 互斥）
  │     - flags.chain && !provider.generateChained → throw
  ├─ loadCharacter / loadPrompts (existing)
  ├─ build all GenerateRequest[]  ← character + prompts.json refs 已合并
  ├─ NEW: 一次性 fail-fast 预检（在主循环和首次上传/提交之前）：
  │     for each req:
  │       - req.refs.length + (req.editTarget?1:0) > 16 → throw  ← 移到这里：作用于合并后 final refs
  │       - provider.validateRequest?(req)（apimart 检 ar/4k 子集；google/openai 自管）
  ├─ for each task:
  └─ provider.generate(req) → apimart.generate:
        ├─ 路径 A (refs/editTarget/mask 任一非空):
        │   ├─ uploadAllToApimart(paths) → urls[]
        │   │     - 内部按 sha256 cache（pending Promise 形式）命中 / 否则 multipart 上传
        │   │     - 上传途中失败：catch 清 cache 让重试可达；外层 throw（已上传由 apimart 72h 过期）
        │   ├─ buildPayload({...req, image_urls, mask_url})
        │   ├─ POST /v1/images/generations → { task_id }   (apimart-local retry loop)
        │   ├─ pollTask(task_id, initial=12s, interval=3s, timeout=180s)   (apimart-local retry loop)
        │   │     - 状态映射接受两套别名（pending/submitted、processing/in_progress）
        │   │     - timeout：throw 时打印 task_id，方便用户控制台跟进
        │   ├─ download images[].url[0] → Uint8Array   (apimart-local retry loop with httpGetBytes)
        │   └─ return GenerateResult
        └─ 路径 B (text-only)：跳过上传，直传 prompt
                                    ↓
                       commands/generate.ts → writeImage(outdir)
```

### 文件改动表

| 文件 | 状态 | 改动要点 |
|---|---|---|
| `scripts/providers/types.ts` | 改造 | 删 `quality` / `imageSize` / `mapQualityToImageSize`（包括 `google.ts:19` 的 re-export）；`GenerateRequest` 新增 `resolution: "1k"\|"2k"\|"4k"` + `detail: "auto"\|"low"\|"medium"\|"high"`；`Provider` 接口新增可选 `validateRequest?(req: GenerateRequest): void` |
| `scripts/lib/http.ts` | 改造 | 新增 `httpGetBytes(url, headers?): Promise<{status, bytes}>`：raw helper（不带 retry），不走 JSON.parse，直接读 ArrayBuffer 转 Uint8Array；proxy/curl 路径与现有 helper 一致。**不**新增 `httpGetBytesWithRetry`——apimart 全部 4 条路径（upload/submit/poll/download）都走 provider 内部 attempt loop（与 openai.ts 一致），retry set 走 apimart-local `RETRYABLE_STATUS={429,500,502,503}`，不复用共享 `*WithRetry` 帮手（共享 set 仅 `{429,500,503}`） |
| `scripts/lib/args.ts` | 改造 | 删 `--quality`（遇到 → throw migration）；新增 `--resolution` / `--detail`；`--ar` 接受 13 种值 |
| `scripts/lib/config.ts` | 改造 | 删 `quality`；新增 `resolution`（默认 `"2k"`）/ `detail`（默认 `"high"`）；新增 `APIMART_*` env 组；EXTEND.md `default_quality` → throw migration；EXTEND.md `default_resolution` / `default_detail` 解析 |
| `scripts/providers/google.ts` | 改造 | 适配新字段：内部从 `resolution` 派生 Gemini 需要的大写 `imageSize`（`"1k"→"1K"`、`"2k"→"2K"`，`"4k"`→throw）；`detail` 忽略（Gemini 不暴露）；新增 6 种 ar throw；删除 `google.ts:19` 的 `mapQualityToImageSize` re-export；可选实现 `validateRequest`（同步预检 ar/resolution） |
| `scripts/providers/openai.ts` | 改造 | `detail` → OpenAI `quality` 字段直传（删 `mapToOpenAIQuality`）；`resolution=4k` throw；新增 6 种 ar throw；SIZE_TABLE 索引由 `quality` 改为 `resolution`；可选实现 `validateRequest` |
| `scripts/providers/apimart.ts` | **新建** | factory + 异步 generate（apimart upload / 提交 / 轮询 / 下载）；run-scoped sha256 上传 cache；`validateRequest` 实现（13 种 ar、4k+6种 ar 子集）；batch* 不实现 |
| `scripts/main.ts` | 改造 | `PROVIDERS` 注册 `apimart`；缺 API key 时报错文案多 `APIMART_API_KEY` |
| `scripts/commands/generate.ts` | 改造 | `Task` schema / `defaults` 字段从 `quality` 改 `resolution` + `detail`（line 56/62/69/80/88/122）；GenerateRequest build 删 `imageSize: mapQualityToImageSize(...)` (line 159/161)，改透传 `resolution` / `detail`；prompts.json 解析层 `quality` 字段 → throw migration；refs+editTarget > 16 校验；主循环前对所有构造好的 GenerateRequest 调用 `provider.validateRequest?.(req)` |
| `scripts/commands/batch.ts` | 改造 | 同 generate.ts：`Task` schema 字段重命名 + `imageSize` 移除（line 21/130/149/151/199）；prompts.json `quality` → throw；apimart provider 无 batchCreate → throw "apimart provider does not support batch; use generate --prompts" |
| `SKILL.md` / `README.md` | 改造 | 三 provider 能力矩阵；--resolution/--detail/扩展 ar 用法；apimart 章节（env 配置、上传 URL 72h 过期说明）；migration 章节 |
| 各 `*.test.ts` | 改/加 | 详见 §4 |

### 模块职责（边界）

```
scripts/main.ts          路由 + provider 装配
scripts/commands/        业务流程，provider-agnostic；主循环前调 provider.validateRequest
scripts/providers/
  types.ts               interfaces + 枚举（含 validateRequest 钩子）
  google.ts
  openai.ts
  apimart.ts             (NEW)
scripts/lib/
  http.ts                通用 HTTP（复用 + 新增 httpGetBytes）
  config.ts              env + EXTEND.md + flags 解析
  args.ts
  files.ts / character.ts / output.ts
```

边界规则：

- `commands/` 不直接调任何 vendor API；
- `providers/apimart.ts` 内部封装上传 cache；不暴露给 commands 层；
- `lib/http.ts` 二进制下载 helper 与现有 JSON / multipart 系列同等地位；
- 上传 cache 是 apimart provider closure 的私有状态；进程结束随进程销毁。

---

## §2 Data Structures

### `scripts/providers/types.ts`

```ts
// 修订：GenerateRequest（删 quality / imageSize；加 resolution / detail）
export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;                          // 13 种值之一（命令层校验）
  resolution: "1k" | "2k" | "4k";             // 分辨率档位（拆自 quality）
  detail: "auto" | "low" | "medium" | "high"; // 清晰度档位（拆自 quality）
  refs: string[];                             // 本地路径
  editTarget?: string;                        // 本地路径
  mask?: string;                              // 本地路径
}

// 修订：Provider 接口（加 validateRequest 钩子）
export interface Provider {
  name: string;
  defaultModel: string;
  validateRequest?(req: GenerateRequest): void;  // NEW: fail-fast 预检
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateAndAnchor?(...): Promise<...>;
  generateChained?(...): Promise<GenerateResult>;
  batchCreate?(...): Promise<BatchJob>;
  batchGet?(...): Promise<BatchJob>;
  batchFetch?(...): Promise<BatchResult[]>;
  batchList?(...): Promise<BatchJob[]>;
  batchCancel?(...): Promise<void>;
}

// GenerateResult / ProviderConfig 不变
```

**删除项**：

- `imageSize: "1K"|"2K"|"4K"` —— 被 `resolution` 取代；Google provider 内部从 `resolution` 派生大写形式
- `mapQualityToImageSize()` —— 不再需要
- `GenerateRequest.quality` —— 拆成 resolution + detail
- `google.ts:19` 的 `mapQualityToImageSize` re-export

### `scripts/lib/config.ts`

```ts
export interface Config {
  provider: string;                       // "google" | "openai" | "apimart"
  model: string;
  resolution: "1k" | "2k" | "4k";         // 替代 quality（默认 "2k"）
  detail: "auto" | "low" | "medium" | "high"; // 新增（默认 "high"，对齐当前 --quality 2k 行为）
  ar: string;
  apiKey: string;
  baseUrl: string;
}

const PROVIDER_DEFAULTS = {
  google:  { baseUrl: "https://generativelanguage.googleapis.com",
             defaultModel: "gemini-3.1-flash-image-preview" },
  openai:  { baseUrl: "https://api.openai.com",
             defaultModel: "gpt-image-2" },
  apimart: { baseUrl: "https://api.apimart.ai",
             defaultModel: "gpt-image-2-official" },
};

// env 解析：
// google  → GOOGLE_API_KEY|GEMINI_API_KEY + GOOGLE_BASE_URL + GOOGLE_IMAGE_MODEL
// openai  → OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_IMAGE_MODEL
// apimart → APIMART_API_KEY + APIMART_BASE_URL + APIMART_IMAGE_MODEL
//
// CLI 解析顺序：
//   1. provider := flags / extendMd / "google"
//   2. resolution := flags.resolution / extendMd.default_resolution / "2k"
//   3. detail     := flags.detail / extendMd.default_detail / "high"
//   4. EXTEND.md 含 default_quality → throw migration

// Migration 错误信息（lib/config.ts 导出，args.ts、prompts.json 解析层共享）：
export const QUALITY_REMOVED_MSG =
  "--quality / default_quality / prompts.json 'quality' field has been removed.\n" +
  "Migration:\n" +
  "  --quality normal → --resolution 1k --detail medium\n" +
  "  --quality 2k     → --resolution 2k --detail high\n" +
  "EXTEND.md default_quality:\n" +
  "  default_quality: normal → default_resolution: 1k + default_detail: medium\n" +
  "  default_quality: 2k     → default_resolution: 2k + default_detail: high";
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
    resolution?: string;          // NEW
    detail?: string;              // NEW
    ref?: string[];
    edit?: string;
    mask?: string;
    outdir: string;
    json: boolean;
    async: boolean;
    chain: boolean;
    character?: string;
  };
}

// --quality 出现时 → throw QUALITY_REMOVED_MSG
// --ar 校验值集 ∈ {1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3,
//                   5:4, 4:5, 2:1, 1:2, 21:9, 9:21}（命令层）
// --resolution 校验 ∈ {1k, 2k, 4k}
// --detail 校验 ∈ {auto, low, medium, high}
```

### prompts.json schema（新）

```json
[
  { "prompt": "A sunset", "ar": "16:9", "resolution": "2k", "detail": "high" },
  { "prompt": "A cat", "resolution": "4k", "detail": "auto" },
  { "prompt": "Edit this", "ref": ["base.png"] }
]
```

字段变化：

- 删除 `quality`（遇到 → throw `QUALITY_REMOVED_MSG`）
- 新增 `resolution`、`detail`（每条任务可单独覆盖全局 CLI flag）
- `ref` / `edit` / `mask` / `ar` / `prompt` / `model` 字段不变

`commands/generate.ts` 和 `commands/batch.ts` 的 `Task` interface（现有 line 80/130 附近）必须同步删除 `quality?: "normal"\|"2k"`，新增 `resolution?: "1k"\|"2k"\|"4k"` 和 `detail?: "auto"\|"low"\|"medium"\|"high"`。

### `scripts/providers/apimart.ts` 内部数据结构

```ts
// === AR / Resolution 校验集 ===
const APIMART_ALLOWED_AR = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "2:1", "1:2", "21:9", "9:21",
]);
const APIMART_4K_ALLOWED_AR = new Set([
  "16:9", "9:16", "2:1", "1:2", "21:9", "9:21",
]);

// === 生成请求 payload ===
type ApimartGeneratePayload = {
  model: string;
  prompt: string;
  size: string;                                // ar 字符串直传
  resolution: "1k" | "2k" | "4k";
  quality: "auto" | "low" | "medium" | "high"; // jdy-imagine 的 detail
  n: 1;
  output_format: "png";
  moderation: "auto";
  image_urls?: string[];                       // apimart 上传后 URL（editTarget 在首位）
  mask_url?: string;                           // apimart 上传后 URL
};

// === 上传响应 ===
type ApimartUploadResponse = {
  url: string;          // 72h 有效公开 URL
  filename: string;
  content_type: string;
  bytes: number;
  created_at: number;
};

// === 提交响应 ===
type ApimartSubmitResponse = {
  code: 200;
  data: Array<{ status: string; task_id: string }>;
};

// === 任务查询响应（兼容两套 schema） ===
// 状态字符串 union：apimart 文档存在两套别名
type ApimartTaskStatusRaw =
  | "submitted" | "pending"
  | "in_progress" | "processing"
  | "completed"
  | "failed"
  | "cancelled";

type ApimartTaskResponse = {
  code: 200;
  data: {
    id: string;
    status: ApimartTaskStatusRaw;
    progress?: number;
    actual_time?: number;
    estimated_time?: number;
    fail_reason?: string;                      // 旧 schema 别名
    error?: { code?: number; message?: string; type?: string }; // 新 schema
    result?: {
      images: Array<{
        url: string[];
        expires_at: number;
      }>;
    };
  };
};

// === 状态机映射（apimart raw → 内部 normalized） ===
type NormalizedStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
function normalizeApimartStatus(raw: string): NormalizedStatus {
  switch (raw) {
    case "submitted":
    case "pending":     return "pending";
    case "in_progress":
    case "processing":  return "running";
    case "completed":   return "completed";
    case "failed":      return "failed";
    case "cancelled":   return "cancelled";
    default:            return "pending";  // 保守：未知 → 继续轮询
  }
}

// === 失败原因提取（兼容 error 与 fail_reason） ===
function extractFailReason(data: ApimartTaskResponse["data"]): string {
  if (data.error?.message) {
    const t = data.error.type ? `[${data.error.type}] ` : "";
    return `${t}${data.error.message}`;
  }
  return data.fail_reason ?? "unknown";
}

// === Safety 关键词 ===
const SAFETY_KEYWORDS = ["moderation", "policy", "unsafe", "safety", "block"];
function isSafetyFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return SAFETY_KEYWORDS.some(k => lower.includes(k));
}

// === 轮询参数 ===
const POLL_INITIAL_WAIT_MS = 12_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 180_000;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
// 落地版加了 0：httpGetBytes 用 status=0 作为网络失败哨兵（与 httpPost/httpGet 用 503 不同）。
const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503]);

// === 上传 cache ===
// run-scoped；同一进程内重复上传同一文件命中 cache。
// key = sha256(file content)；value = **pending Promise** of upload URL，避免并发同 hash 多次上传。
// 72h 过期足够覆盖一次 run。
type UploadCache = Map<string, Promise<string>>;
async function fileSha256(localPath: string): Promise<string> {
  const data = await Bun.file(localPath).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(data);
  return hash.digest("hex");
}
```

### 关键映射表

| jdy-imagine | apimart | 备注 |
|---|---|---|
| `resolution: "1k"` | `resolution: "1k"` | 直传 |
| `resolution: "2k"` | `resolution: "2k"` | 直传 |
| `resolution: "4k"` | `resolution: "4k"` | 仅 6 种 ar 接受 |
| `detail: "auto"` | `quality: "auto"` | 直传 |
| `detail: "low"` | `quality: "low"` | 直传 |
| `detail: "medium"` | `quality: "medium"` | 直传 |
| `detail: "high"` | `quality: "high"` | 直传 |
| `ar: "16:9"` | `size: "16:9"` | 直传 ar 字符串 |
| `editTarget` (path) | `image_urls[0]` | 经 apimart 上传后填 URL |
| `refs[]` (paths) | `image_urls[1..]` | 经 apimart 上传后填 URL（editTarget 在首位） |
| `mask` (path) | `mask_url` | 经 apimart 上传后填 URL |
| `result.images[0].url[0]` | `GenerateResult.images[0].data` | httpGetBytes 下载后转 Uint8Array |

---

## §3 Business Flow

### 3.1 generate 命令（apimart 路径）

```
runGenerate (commands/generate.ts):
├─ validateGenerateArgs (existing)
├─ validateProviderCapabilities (NEW updates):
│   ├─ flags.mask && !flags.edit && (!flags.ref || refs.length === 0) → throw
│   └─ flags.chain && !provider.generateChained → throw  (含 apimart)
│   注意：refs+editTarget > 16 校验不在这里——CLI flags.ref 此时还没合并 character refs 和 prompts.json per-task refs。
├─ loadCharacter / loadPrompts (existing)
├─ build all GenerateRequest[]                    // 主循环前一次性构造，character + prompts.json refs 已合并
├─ NEW 一次性 fail-fast 预检（在主循环和首次上传/提交之前）：
│   for each req:
│     ├─ refs.length + (editTarget?1:0) > 16 → throw  // 移到这里：作用于合并后的 final refs
│     └─ if provider.validateRequest: provider.validateRequest(req)
├─ for each task:
│     await provider.generate(req) → apimart.generate:
│        ├─ 路径 A (refs/editTarget/mask 任一非空):
│        │   ├─ paths := [editTarget?, ...refs, mask?] (按序，单独追踪 mask 索引)
│        │   ├─ urls := await Promise.all(paths.map(p => uploadToApimartCached(p)))
│        │   │     - 内部按 sha256 cache 命中 → 直接返回缓存 URL
│        │   │     - cache miss → multipart POST /v1/uploads/images → 缓存 URL
│        │   │     - 上传途中失败：直接 throw（已上传由 apimart 72h 过期）
│        │   ├─ image_urls := urls 去掉 mask 那一项（按记录的索引）
│        │   ├─ mask_url := urls[mask_idx] (如有)
│        │   ├─ payload := buildPayload(req, image_urls, mask_url)
│        │   └─ 进入提交流程
│        ├─ 路径 B (text-only)：
│        │   └─ payload := buildPayload(req)，进入提交流程
│        ├─ submit: POST /v1/images/generations { payload }
│        │     ├─ 200 + data[0].task_id → 进入 poll
│        │     ├─ 400 → return errorResult (ERROR)
│        │     ├─ 401/403 → throw auth
│        │     ├─ 402 → throw "insufficient balance"
│        │     ├─ 429/500/502 → retry RETRY_DELAYS
│        │     └─ exhaust retries → throw
│        ├─ pollTask(task_id):
│        │     sleep POLL_INITIAL_WAIT_MS
│        │     loop:
│        │       res := GET /v1/tasks/{id}
│        │       switch normalizeApimartStatus(res.data.status):
│        │         "completed" → return res.data.result
│        │         "failed":
│        │             reason := extractFailReason(res.data)
│        │             return mapToErrorResult(reason)  (SAFETY or ERROR)
│        │         "cancelled":
│        │             return mapToErrorResult("task cancelled")  (ERROR)
│        │         "pending" / "running" → continue
│        │       elapsed >= POLL_TIMEOUT_MS:
│        │         throw `apimart task polling timeout (>${180}s); task_id=${task_id} ` +
│        │               `(check apimart console; result may still complete and be retrievable manually)`
│        │       sleep POLL_INTERVAL_MS
│        ├─ images := await Promise.all(result.images.map(i =>
│        │     downloadWithApimartRetry(i.url[0])))   // apimart-local attempt loop
│        │       内部：httpGetBytes raw helper + RETRYABLE_STATUS={429,500,502,503} + RETRY_DELAYS
│        └─ return GenerateResult { images, finishReason: "STOP" }
                                  ↓
              writeImage(outdir, ...) (existing)
```

**关键设计点**：

- **上传 cache**：`uploadToApimartCached(path)` 是 apimart provider closure 内部方法，持有 `cache: Map<sha256, url>`。同一 run 内 character profile 注入的 5 张参考图 × 10 个 prompt = 50 次调用，但实际只上传 5 次。
- **mask 索引追踪**：因为 mask 不放在 `image_urls`，需要在并发上传后单独取出 mask 对应的 URL。实现时用 `paths: Array<{path: string, role: "image" | "mask"}>`。
- **partial upload 失败**：直接 throw，已上传图由 apimart 服务端 72h 过期。无主动 cleanup（与 R2 路径不同——这是 apimart 上传方案的天然优势）。
- **预检**：apimart provider 的 `validateRequest` 检查 `ar ∈ APIMART_ALLOWED_AR`、`resolution=4k → ar ∈ APIMART_4K_ALLOWED_AR`。命令层主循环前对所有 task 调用，避免第 N 个 task 才 throw。

### 3.2 batch 命令（apimart 路径）

```
runBatch (commands/batch.ts):
├─ if subcommand=submit:
│   ├─ provider.batchCreate ?? throw
│       "apimart provider does not support batch (no cost benefit).
│        Use 'generate --prompts <file>' for multi-prompt sequential generation."
└─ 其他 subcommand (status/fetch/list/cancel)：
    └─ 同样：provider.<method> ?? throw 同上
```

apimart 不在 Provider 接口实现 batch* 方法。命令层通过 `?? throw` 给出友好错误。

### 3.3 chain 命令（apimart 路径）

apimart 不实现 `generateAndAnchor` / `generateChained`。`runGenerate` 已有逻辑：`flags.chain && !provider.generateChained → throw`，自动覆盖。错误信息提示用户切 google provider。

### 3.4 错误映射

| 阶段 | apimart 真实响应 | jdy-imagine 抽象层 |
|---|---|---|
| upload | 200 + `url` | 缓存 URL；继续主流程 |
| upload | 401/403 | throw "apimart auth failed: {reason}" |
| upload | 413 / 415 | throw "apimart upload rejected: {file size > 20MB / unsupported type}" |
| upload | 429 / 500 / 502 | retry RETRY_DELAYS；exhaust → throw |
| submit | 200 + `data[0].task_id` | 进入 poll |
| submit | 400 + `error.message` | `{images:[], finishReason:"ERROR", safetyInfo:{reason}}` |
| submit | 401 / 403 | throw "apimart auth failed: {reason}" |
| submit | 402 | throw "apimart insufficient balance" |
| submit | 429 / 500 / 502 | retry RETRY_DELAYS；exhaust → throw |
| poll | `status="completed"` + `result.images` | `{images, finishReason:"STOP"}` |
| poll | `status="failed"` + reason 含 safety 关键词 | `{images:[], finishReason:"SAFETY", safetyInfo:{reason}}` |
| poll | `status="failed"` 其他 | `{images:[], finishReason:"ERROR", safetyInfo:{reason}}` |
| poll | `status="cancelled"` | `{images:[], finishReason:"ERROR", safetyInfo:{reason:"cancelled"}}` |
| poll | elapsed > 180s | throw "apimart task polling timeout (>180s); task_id=..." |
| download | URL 200 | bytes → Uint8Array |
| download | URL 4xx/5xx | retry；exhaust → throw |

### 3.5 校验顺序（fail-fast）

`runGenerate` 主循环前预检查（按顺序）：

```
1. validateGenerateArgs() — 现有：prompt/prompts 互斥
2. validateProviderCapabilities() — 更新：
   - flags.mask && !flags.edit && (!flags.ref || refs.length === 0) → throw（CLI 层互斥；character/per-task refs 在后续合并）
   - flags.chain && !provider.generateChained → throw  (含 apimart)
   - 删除旧逻辑 `flags.mask && provider.name !== "openai" → throw`（mask 是 capability 而非 provider 名特性；apimart 也支持）
3. build GenerateRequest[]（character + prompts.json refs 合并后的 final form）
4. NEW: 主循环 / 首次 API 调用前一次性 fail-fast 预检：
        for each req:
          - req.refs.length + (req.editTarget?1:0) > 16 → throw  // 移到这里，作用于合并后的 final refs
          - if provider.validateRequest: provider.validateRequest(req)
            - apimart: ar ∈ 13 种？resolution=4k 时 ar ∈ 6 种？否则 throw
            - openai:  ar ∈ 7 种？resolution=4k → throw？否则 throw
            - google:  ar ∈ 7 种？resolution=4k → throw？否则 throw
   → 如果是 prompts.json 多 task，第 N 个 task 不合规也在第 1 个生成前 throw
```

### 3.6 apimart 上传流程详细

**上传**（uploadToApimartCached）：

```
uploadToApimartCached(localPath, cache):
  hash := await fileSha256(localPath)
  cached := cache.get(hash)
  if cached:
    # cached 是 Promise<string>；await 后得到 URL（无论是已完成还是还在 in-flight）
    return await cached
  # 关键：先把 Promise 放进 cache，再 await。这样并发同 hash 不同 path 的调用全部命中 in-flight Promise，只发起一次实际上传。
  # 拒绝时 catch + cache.delete，避免 rejected Promise 永久占据 cache 让后续重试也立即 throw。
  promise := doUpload(localPath).catch(err => {
    cache.delete(hash);
    throw err;
  })
  cache.set(hash, promise)
  return await promise

doUpload(localPath):
  fd := new FormData()
  fd.append("file", new Blob([await Bun.file(localPath).arrayBuffer()],
            {type: inferMimeType(localPath)}), basename(localPath))
  for attempt in 0..RETRY_DELAYS.length:
    res := await httpPostMultipart(`${baseUrl}/v1/uploads/images`, fd, headers)
    if res.status === 200: return res.data.url
    if res.status ∈ {401, 403}: throw "apimart auth failed"
    if res.status ∈ {413, 415}: throw "apimart upload rejected (size/type)"
    if res.status ∉ RETRYABLE_STATUS or attempt === last: throw `apimart upload failed (${res.status})`
    sleep RETRY_DELAYS[attempt]
```

**重要 — 全 4 条路径用同一套 apimart-local retry**：apimart provider 在上传 / 提交 / 轮询 / 下载 路径上**不复用** `lib/http.ts` 的 `*WithRetry` 帮手（共享集只含 `{429, 500, 503}`），而是在 provider 内部手写 attempt 循环，使用 apimart 自己的 `RETRYABLE_STATUS = {429, 500, 502, 503}`。这与 `openai.ts` 的现有写法一致（参考 openai.ts 的 generateOnce attempt 循环）。

落地为 4 个 provider-内部小 helper（共享同一组常量）：

```
async function callWithApimartRetry<T>(
  doCall: () => Promise<{status: number, data?: any, error?: any, bytes?: Uint8Array}>,
  context: string,                           // "submit" | "poll" | "upload" | "download"
  opts: { allow400Result?: boolean } = {},   // submit opt-in：把 400 当 result 返回让 caller 映射 ERROR/SAFETY
): Promise<T> {
  for attempt in 0..RETRY_DELAYS.length:
    res := await doCall()
    if res.status === 200: return res            // 调用方读 .data / .bytes
    if res.status ∈ {401, 403}: throw `apimart ${context} auth failed`
    if res.status === 402: throw "apimart insufficient balance"
    if res.status ∈ {413, 415} && context === "upload": throw "apimart upload rejected (size/type)"
    if res.status === 400:
      if opts.allow400Result: return res         // 仅 submit 显式 opt-in，由 caller 区分 ERROR/SAFETY
      throw `apimart ${context} bad request: ${extractErrMsg(res)}`  // 其他路径 400 直 throw
    if res.status ∉ RETRYABLE_STATUS or attempt === last:
      throw `apimart ${context} failed (HTTP ${res.status})`
    sleep RETRY_DELAYS[attempt]
}
```

四个调用点：
- **upload**：`callWithApimartRetry(() => httpPostMultipart(uploadUrl, fd, headers), "upload")` — 400 throw（不接受 opt-in）
- **submit**：`callWithApimartRetry(() => httpPost(submitUrl, payload, headers), "submit", { allow400Result: true })` — 400 返回 res，caller 通过 `mapApimartError` 映射 `ERROR` / `SAFETY`
- **poll**：`callWithApimartRetry(() => httpGet(taskUrl, headers), "poll")` — 400 throw（task_id 错误是 fatal）；每次 poll 间还有 POLL_INTERVAL_MS sleep（外层循环）
- **download**：`callWithApimartRetry(() => httpGetBytes(url), "download")` — 400 throw（apimart 给的 URL 自己服务不动是 fatal）

**Cache invariant — `cache.set` 先于 `await`**：必须按上面伪代码顺序，把 pending Promise 立即放进 Map，再 await。如果反序（先 await 拿到 URL 再 set），同一批 `Promise.all` 中两个不同路径但相同内容的 task 会同时 cache miss 各发一次上传，违反"每 run 单次上传"的约束。


**Cache 设计要点**：

- key 用文件内容 sha256（不用 path + size + mtime），用户可能从不同路径引用同一图片
- 进程级 cache：apimart provider factory 调用一次创建 closure-scoped Map；进程结束随进程销毁
- 不需要持久化：apimart URL 72h 过期，下次 run 重新上传
- 不需要 LRU：单 run 上传规模小（<100 张），简单 Map 即可

**Multipart 与 HTTPS_PROXY**：

apimart 上传走 multipart。现有 `lib/http.ts` 的 `httpPostMultipart` 通过 HTTPS_PROXY 路径有限制（`detectProxy`），与 OpenAI provider 同样的约束。但 apimart 设计就是国内直连场景，HTTPS_PROXY 通常不需要。implementation 可参考 `openai.ts` 的 `rejectMultipartUnderProxy` 给出友好错误：

```
function rejectMultipartUnderProxy(operation: string): void {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    throw new Error(
      `apimart ${operation} uses multipart upload which is not supported through HTTP proxy ` +
      `(detected: ${proxy}). Disable the proxy environment variable for this command, ` +
      `or use --provider openai/google for proxy-friendly workflows.`,
    );
  }
}
```

仅在有 image input 时调用（text-only 路径完全 JSON，proxy 友好）。

### 3.7 能力矩阵（更新后）

| Flag / 能力 | Google | OpenAI | apimart | 备注 |
|---|---|---|---|---|
| `--prompt` | ✓ | ✓ | ✓ | |
| `--ref <path>` | ✓ | ✓ | ✓（apimart 自动上传） | |
| `--edit <path>` | ✓ fallback | ✓ | ✓（apimart 自动上传） | |
| `--mask <path>` | ✗ throw | ✓ | ✓（apimart 自动上传） | mask 必须配 ref/edit |
| `--ar` 7 种基础 | ✓ | ✓ | ✓ | |
| `--ar` 5:4/4:5/2:1/1:2/21:9/9:21 | ✗ throw | ✗ throw | ✓ | |
| `--resolution 1k\|2k` | ✓ | ✓ | ✓ | |
| `--resolution 4k` | ✗ throw | ✗ throw | ✓（仅 6 种 ar） | |
| `--detail auto\|low\|medium\|high` | 忽略 | ✓ 直传 | ✓ 直传 | Gemini 不暴露 |
| `--chain` | ✓ | ✗ throw | ✗ throw | apimart 异步无状态 |
| `--character` | ✓ | ✓ realtime / ✗ batch | ✓ realtime | apimart 上传 cache 自动去重相同 refs |
| `batch submit` | ✓ | ✓ text-only | ✗ throw | apimart 无成本优惠 batch |
| HTTPS_PROXY 友好 | ✓ | text-only | text-only | apimart 上传走 multipart，与 openai 同限 |
| 真透明背景 | ✗ | ✗ | ✗ | gpt-image-2 全家不支持 |

---

## §4 Testing Strategy

### 测试基线

现有套件全部保持绿灯。被本次重构波及的现有测试需要适配（quality 拆分），非波及的不动。

### 新增 / 修改清单

| 文件 | 状态 | 关键测试 |
|---|---|---|
| `scripts/providers/types.test.ts` | 改造 | 删 `mapQualityToImageSize` 测试；新增 GenerateRequest 字段形态测试（resolution/detail 枚举）；Provider 接口含 `validateRequest?` |
| `scripts/lib/http.test.ts` | 改造 | 新增 `httpGetBytes` raw helper：验证返回 ArrayBuffer/Uint8Array、不走 JSON.parse、proxy/curl 路径与现有 helper 行为一致；不测试 retry（apimart-local retry 测试在 apimart.test.ts 的 callWithApimartRetry 上） |
| `scripts/lib/args.test.ts` | 改造 | 新增 `--resolution` / `--detail` 解析；`--quality` 出现 → throw migration；`--ar` 13 种值全覆盖；旧测试中 `--quality 2k` 替换为 `--resolution 2k --detail high` |
| `scripts/lib/config.test.ts` | 改造 | provider="apimart" 读 APIMART_*；EXTEND.md `default_quality` → throw；新增 `default_resolution` / `default_detail` 解析；defaults 校验 `resolution=2k` + `detail=high` |
| `scripts/providers/google.test.ts` | 改造 | 适配 resolution/detail；新 6 种 ar throw；resolution=4k throw；validateRequest 实现测试 |
| `scripts/providers/openai.test.ts` | 改造 | `detail` → OpenAI quality 字段直传（删 medium/high 硬编测试）；新 6 种 ar throw；resolution=4k throw；validateRequest 实现测试 |
| `scripts/providers/apimart.test.ts` | **新建** | 上传 payload 构建（multipart fields）；`uploadToApimartCached` cache 命中（同一 sha256 只上传一次）；submit payload（含 image_urls 顺序、mask_url）；`pollTask` 状态机（completed / failed-safety / failed-other / cancelled / timeout / 网络重试 / 状态别名 union）；`extractFailReason`（含 error.message 和 fail_reason 两套）；`mapApimartError`（401/402/403/429/safety/error）；ar/resolution 校验（13 种、4k+6种）；URL 下载转 Uint8Array；rejectMultipartUnderProxy 触发 |
| `scripts/commands/generate.test.ts` | 改造 | resolution/detail 透传；refs+editTarget > 16 throw；apimart + chain throw；NEW: `provider.validateRequest` 主循环前对所有 GenerateRequest 调用，第 N 个不合规 → 主循环不执行 |
| `scripts/commands/batch.test.ts` | 改造 | apimart + batch 任意子命令 → throw 友好提示 |
| `scripts/integration.test.ts` | 加路径 | mock apimart server：text-to-image / image-to-image（含上传 cache 命中验证：character profile + 多 prompt 只上传一次）/ failed-safety / timeout / cancelled |

### Mock 策略

- 不调真实 apimart API：apimart.test.ts 通过依赖注入 mock `httpPost` / `httpPostMultipart` / `httpGet` / `httpGetBytes`
- integration.test.ts 用 Bun mock fetch 拦截 apimart endpoint，模拟 task 生命周期（pending → running × 2 → completed），同时模拟上传端点返回 URL
- 上传 cache 测试 — 必须包括三种情形：
  - 顺序命中：同一文件路径调两次 `uploadToApimartCached`，第二次命中 cache
  - **并发同 hash 不同 path**：`Promise.all([upload(a.png), upload(copy-of-a.png)])` 应只触发 1 次实际 multipart fetch（验证 R2-3 的 pending Promise 缓存语义）
  - 上传失败：cache 命中 throw 时，下次同 hash 调用应**重新尝试**而非永久卡死（reject Promise 不应留在 cache 中，或 cache 在 reject 时清理）
- 命令层 mask + apimart 测试：`--provider apimart --mask m.png --ref a.png` 不被 R2-2 旧 guard 拦截，能进入 provider 走 mask_url 路径
- apimart upload + 502 retry：mock httpPostMultipart 返回 502 一次后 200，验证 apimart provider 内部 attempt 循环按 RETRYABLE_STATUS={429,500,502,503} retry（不复用 lib/http.ts 共享 retry set）

### 覆盖度门槛

不强制覆盖率数字。底线：

- apimart.ts 每个公开方法至少 1 条 happy path + 1 条 error path
- pollTask 状态机：completed / failed-safety / failed-error / cancelled / timeout / submit-error 至少各一条；状态别名 union 覆盖
- 上传 cache：cache 命中、cache miss、上传失败各 1 条
- migration 校验（`--quality` / `default_quality` / prompts.json `quality`）至少各 1 条 throw
- `validateRequest` 预检：apimart 第 N 个 task ar 不合规 → 主循环不执行任何 generate

---

## §5 Implementation Plan (Commit Order)

按两个 PR 分组，每个 PR 内按 step 拆 commit。

### PR 1 — `--quality` 抽象债拆分（纯重构，无功能变更）

分支：`refactor/quality-to-resolution-detail`

**Step 1.1 — types.ts 字段拆分 + Provider 接口扩展**

- `providers/types.ts`：
  - 删 `quality` / `imageSize` / `mapQualityToImageSize`
  - 加 `resolution` / `detail`
  - 加 `Provider.validateRequest?` 钩子
- `providers/types.test.ts` 适配
- 验收：types 测试绿灯

**Step 1.2 — args.ts 增删 flags**

- `lib/args.ts`：删 `--quality`（遇到 → throw migration），加 `--resolution` / `--detail`，`--ar` 接受 13 种值
- `lib/args.test.ts` 适配 + 新增 13 种 ar 解析
- 验收：args 测试绿灯

**Step 1.3 — config.ts 字段 + EXTEND.md migration**

- `lib/config.ts`：
  - 删 `quality`，加 `resolution`（默认 `"2k"`） / `detail`（默认 `"high"`）
  - 导出 `QUALITY_REMOVED_MSG` 常量给 args.ts、commands/* 共享
  - EXTEND.md `default_quality` → throw
- `lib/config.test.ts` 适配
- 验收：config 测试绿灯

**Step 1.4 — google provider 适配**

- `providers/google.ts`：
  - 用 `resolution` 替代 `quality` 路径；内部派生大写 `imageSize`
  - `detail` 忽略
  - 新 6 种 ar throw；resolution=4k throw
  - 实现 `validateRequest` 做预检
  - 删 `google.ts:19` 的 `mapQualityToImageSize` re-export
- `providers/google.test.ts` 适配
- 验收：google 全部测试绿灯，端到端用法不变（除 quality flag 已删）

**Step 1.5 — openai provider 适配**

- `providers/openai.ts`：
  - `detail` 直传到 OpenAI quality 字段（删 `mapToOpenAIQuality`）
  - SIZE_TABLE 索引由 `quality` 改为 `resolution`
  - `resolution=4k` throw；新 6 种 ar throw
  - 实现 `validateRequest` 做预检
- `providers/openai.test.ts` 适配
- 验收：openai 全部测试绿灯

**Step 1.6 — commands 字段重构 + prompts.json schema 迁移**

- `commands/generate.ts`：
  - `Task` interface 删 `quality?`、加 `resolution?` + `detail?`（line 80 附近）
  - `defaults` 参数对象删 `quality`、加 `resolution` + `detail`（line 62 附近）
  - GenerateRequest build 删 `imageSize: mapQualityToImageSize(...)` 那一行（line 161）
  - prompts.json 解析时遇 `quality` 字段 → throw `QUALITY_REMOVED_MSG`
  - 主循环前对所有构造好的 GenerateRequest 调用 `provider.validateRequest?.(req)`
- `commands/batch.ts`：同上（line 21/130/149/151/199）
- `commands/generate.test.ts` / `commands/batch.test.ts`：所有 fixtures 中 `quality: "2k"` → `resolution: "2k", detail: "high"`；新增 prompts.json `quality` → throw migration 测试；新增 `validateRequest` 预检测试
- `README.md`：加 migration 章节（CLI flag、EXTEND.md、prompts.json schema 三方迁移示例）
- `SKILL.md`：同步 examples
- `EXTEND.md.example`：`default_quality: 2k` → `default_resolution: 2k` + `default_detail: high`
- 验收：integration.test.ts 全绿（用新 flag 重写现有用例）；现有 `prompts.json` fixture 全部更新

PR 1 验收：所有现有测试绿灯，CLI 行为对外仅 flag 名变化。Migration 文档清楚。`--quality 2k` 等价于 `--resolution 2k --detail high`，行为零差异。

### PR 2 — apimart provider（新功能）

分支：`feat/apimart-provider`（基于 PR 1 落地后的 main）

**Step 2.1 — `lib/http.ts` 新增 httpGetBytes raw helper**

- `lib/http.ts`：新增 `httpGetBytes(url, headers?): Promise<{status, bytes}>`（raw，无内置 retry）
- `lib/http.test.ts` 加 case：验证不走 JSON.parse、bytes 内容正确、proxy/curl 行为与现有 helper 一致
- 验收：http 测试绿灯。注意：retry 测试不在此处——apimart-local 的 callWithApimartRetry 测试（含 502）在 Step 2.3/2.4 的 apimart.test.ts

**Step 2.2 — config + main 注册 apimart**

- `lib/config.ts`：新增 `APIMART_*` env 组
- `lib/config.test.ts` 加 case
- `main.ts`：`PROVIDERS` 注册 apimart（先放 placeholder factory）
- 验收：`--provider apimart` 不再报"unknown provider"，但 generate 会因 placeholder factory 抛 not-implemented

**Step 2.3 — apimart provider 核心（text-only 路径 + pollTask）**

- 新建 `scripts/providers/apimart.ts`：
  - factory + `validateRequest`（13 种 ar、4k+6 种 ar 子集）
  - buildPayload + submit + pollTask + 错误映射
  - 状态别名 union 处理（normalizeApimartStatus）
  - extractFailReason（兼容 error 和 fail_reason）
  - safety 关键词检测
- 新建 `scripts/providers/apimart.test.ts`：unit case 含 pollTask 全状态分支 + 状态别名 + 失败原因兼容性
- 验收：mock 环境下 `--provider apimart --prompt "..."` 跑通文生图

**Step 2.4 — apimart 图像输入路径（上传 + cache）**

- `apimart.ts`：
  - `uploadToApimartCached` + sha256 hash + run-scoped Map cache
  - generate() 接入：editTarget/refs 上传 → image_urls；mask 上传 → mask_url
  - rejectMultipartUnderProxy 检查
- `apimart.test.ts` 加 case：
  - 含 image input 端到端 mock
  - cache 命中（同一文件 2 次只上传 1 次）
  - character profile + 多 prompt 场景下 cache 行为
  - HTTPS_PROXY 设置时 throw
- 验收：mock 下 `--provider apimart --ref a.png --prompt "..."` 跑通图生图

**Step 2.5 — 命令层 wiring**

- `commands/generate.ts`：
  - **删除现有的 `flags.mask && provider.name !== "openai" → throw` 旧 guard**（line 42 附近，PR 1 之前的写法）。mask 现在是 capability 而非 provider 名特性：apimart 也支持 mask（spec 能力矩阵已确认）。改为只保留 `flags.mask && !flags.edit && !flags.ref → throw`（mask 必须配 image input），其他校验交给 provider 自身（Google 内部 `rejectMask` 已在；OpenAI/apimart 无此限制）
  - 把 refs+editTarget > 16 检查移到 §3.5 描述的位置：build GenerateRequest[] 之后、首次 generate 调用之前，对每个 final req 检查
- `commands/batch.ts`：provider 无 batchCreate → throw 友好提示
- `commands/generate.test.ts`：
  - **新增**：`--provider apimart --mask m.png --ref a.png` 不再被命令层拦截（旧 guard 删除验证）
  - **保留 / 更新**：`--provider google --mask m.png` 仍 throw（但现在通过 provider 内部 `rejectMask` 而非命令层 guard）
- `commands/batch.test.ts` 加 case
- 验收：`batch submit ... --provider apimart` 给出友好错误；`--chain` 同理；`--provider apimart --mask` 通过命令层进入 provider 跑通

**Step 2.6 — 文档 + integration test**

- `README.md`：apimart 章节（env 配置、能力矩阵、上传 URL 72h 过期说明、HTTPS_PROXY 限制、timeout 时 task_id 跟进说明）
- `SKILL.md`：apimart usage examples
- `scripts/integration.test.ts`：mock apimart server 端到端（text-to-image / image-to-image / failed-safety / timeout / cancelled / 上传 cache）
- 验收：CI 全绿

每步对应一个原子 commit。PR 2 落地后能力矩阵 apimart 列稳定。

---

## Risks & Known Limitations

1. **apimart 上传 multipart 与 HTTPS_PROXY 不兼容**：与现有 OpenAI provider 同样的约束。检测到 proxy 时 fail-fast。apimart 设计场景是国内直连，HTTPS_PROXY 通常不存在；用户撞上时切 google provider。
2. **task 轮询超时 180s 后无 resume 路径**：apimart 4K + high quality 偶尔可能超过 180s。timeout 时打印 task_id，用户可去 apimart 控制台手动查询；spec 不实现 `--resume <task_id>` 子命令（YAGNI；如有用户反馈再做）。需 README 说明。
3. **`fail_reason` 与 `error` 字段并存**：apimart 文档存在两套 schema（GPT-Image-2 页面用 `fail_reason`；通用 tasks/status 页面用 `error.{code,message,type}`）。本 spec 同时读两个字段，向前兼容；运行时撞到第三种 schema 需在 `extractFailReason` 加 case。
4. **task 状态别名 union**：同样的两套文档不一致（`submitted/in_progress` vs `pending/processing`）。`normalizeApimartStatus` 兜底"未知 → pending"以避免误触 fetch。如果 apimart 上线新状态名，需要更新 union。
5. **safety 关键词 fail_reason 检测是启发式**：基于子串匹配 (`moderation/policy/unsafe/safety/block`)。如果实际 reason 用了其他词（例如 `nsfw`），会被误判为 ERROR。低成本改：扩 `SAFETY_KEYWORDS`。
6. **上传 URL 72h 过期窗口**：理论上单次 run 远小于 72h，URL 不会过期。但若用户脚本里把 jdy-imagine 嵌入长期 daemon 进程并复用 cache，URL 可能过期。本 spec 不做过期检测（cache miss 重新上传是正确兜底——但当前实现 cache 只按 sha256 hit/miss 不做时间检查，过期 URL 命中 cache 后会被 apimart 服务端拒绝）。如确认有此场景，cache 可加 TTL（例如 60h）；当前 YAGNI。
7. **下载 URL 过期**：apimart 返回的结果 URL 有 `expires_at`。jdy-imagine 在 task completed 后立即下载，正常流程不会遇过期；网络抖动重试期间偶发可能（<10s 量级）。
8. **跨境网络**：apimart 设计目标是国内访问，海外用户用 apimart 可能反而慢于 OpenAI 直连。能力矩阵 README 说明 apimart 的设计场景。
9. **`--quality` 删除是 break change**：所有现存 `.env` / `EXTEND.md` / `prompts.json` 含 `quality` 字段会失败。Migration 文档 + throw 信息要清晰；release notes 需突出。`QUALITY_REMOVED_MSG` 在 config.ts 单点定义，三方共享。
10. **AR 13 种枚举跨 provider 校验**：每个 provider 自管 ar 校验集，重复但隔离。如未来 ar 集合再扩，三个 provider 都要更新。可接受。
11. **n=1 限制**：apimart 支持 n=4 但本次写死 1。如需多图，未来开 `--n` flag 同步扩到 google/openai（OpenAI gpt-image-2 也支持 n=4）。
12. **上传文件 ≤ 20MB 限制**：apimart 文档明示。上传前不做本地检查（避免依赖 `fs.statSync` 的 race condition），让 apimart 服务端报错由错误映射兜底。

---

## References

- [apimart gpt-image-2 official API](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official)
- [apimart uploads/images API](https://docs.apimart.ai/cn/api-reference/uploads/images)
- [apimart tasks/status API](https://docs.apimart.ai/cn/api-reference/tasks/status)
- 历史 spec：
  - `docs/superpowers/specs/2026-04-13-jdy-imagine-design.md`
  - `docs/superpowers/specs/2026-04-14-batch-file-based-design.md`
  - `docs/superpowers/specs/2026-04-14-character-consistency-design.md`
  - `docs/superpowers/specs/2026-04-28-openai-gpt-image-2-provider-design.md`
