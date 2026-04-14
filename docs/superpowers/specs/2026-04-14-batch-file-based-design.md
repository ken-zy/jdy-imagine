# Batch File-Based Input/Output Design

## Problem

当前 `batchFetch()` 使用 inline 模式：直接 GET batch endpoint，期望在 `response.inlinedResponses` 中内联返回所有结果。当 batch 包含多张 2K 图片时，base64 响应体达 12-15MB，Google 服务端主动断开 socket 连接。重试循环（503 → retry → 断开 → 503）最终超时。

根因：inline 模式下，结果内嵌在 batch job 的 JSON 响应中，不适合大体积二进制数据。

## Solution

全面切换到 file-based 模式：input 通过 Files API 上传 JSONL，output 通过 Files API 下载 JSONL 结果文件。

Google Batch API 的结果返回格式由 input 格式决定：
- inline input (`input_config.requests`) → `response.inlinedResponses`
- file input (`input_config.file_name`) → `response.responsesFile`

因此必须同时改 input 和 output。

## Architecture

### 新增：`scripts/lib/files.ts`

封装 Google Files API 的上传和下载，独立于现有 `http.ts`。

**不复用 `http.ts` 的原因**：Files API 的 resumable 上传需要读取响应头，流式下载需要 ReadableStream，这两者与现有 `httpGet/httpPost` 的 `res.text() → JSON.parse()` 模式不兼容。强行改造会污染已有接口。

#### 接口

```typescript
/**
 * 上传 JSONL 数据到 Google Files API（resumable 两步协议）
 * @returns file name, e.g. "files/abc123"
 */
export async function uploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string>

/**
 * 流式下载 JSONL 结果文件，逐行回调
 * fetch 路径：ReadableStream → TextDecoderStream → 逐行 split
 * curl 路径：execFileSync → stdout 按 \n split
 */
export async function downloadJsonl(
  fileName: string,
  apiKey: string,
  baseUrl: string,
  onLine: (line: string) => void,
): Promise<void>
```

#### 上传协议

```
Step 1: POST {baseUrl}/upload/v1beta/files
  Headers:
    x-goog-api-key: {apiKey}
    X-Goog-Upload-Protocol: resumable
    X-Goog-Upload-Command: start
    X-Goog-Upload-Header-Content-Length: {byteLength}
    X-Goog-Upload-Header-Content-Type: application/jsonl
    Content-Type: application/json
  Body: { "file": { "display_name": "{displayName}" } }
  → 响应头 x-goog-upload-url → uploadUrl

Step 2: PUT {uploadUrl}
  Headers:
    Content-Length: {byteLength}
    X-Goog-Upload-Offset: 0
    X-Goog-Upload-Command: upload, finalize
  Body: raw JSONL bytes
  → 响应体 { "file": { "name": "files/xxx", "uri": "...", ... } }
  → 返回 file.name
```

#### 下载协议

```
GET {baseUrl}/download/v1beta/{fileName}:download?alt=media
  Headers:
    x-goog-api-key: {apiKey}
  → 返回原始 JSONL 字节（非 JSON 包装）
```

#### Proxy 支持

复用 `http.ts` 的 `detectProxy()`。检测到 proxy 时回退 curl：
- 上传：两次 `execFileSync`，Step 1 用 `-D` dump headers
- 下载：`execFileSync` 拿 stdout → 按 `\n` split → 回调

**已知限制**：proxy 路径使用 `execFileSync` 全量缓冲 stdout，受 Node/Bun 的 `maxBuffer`（当前 50MB）限制。对于包含 40+ 个 2K 图片 task 的超大 batch，proxy 路径的结果文件可能超过此限制。当前实际使用场景（4-20 个 task）不会触发。如未来需支持更大 batch，需将 proxy 下载改为 `spawn` + 流式读取。

#### 超时

- 上传：300s（与现有 TOTAL_TIMEOUT 一致）
- 下载：600s（结果文件含大量 base64，传输时间更长）

#### 重试

复用 `RETRY_DELAYS_HTTP = [1000, 2000, 4000]` 策略。上传和下载均支持重试。

#### 共享 transport 常量

`http.ts` 需导出以下常量供 `files.ts` import，避免 transport policy 分叉：
- `CONNECT_TIMEOUT`（30s）
- `TOTAL_TIMEOUT`（300s）
- `RETRY_DELAYS_HTTP`
- `RETRYABLE_HTTP`（Set<number>）

`files.ts` import 这些常量，下载超时单独定义为 `DOWNLOAD_TIMEOUT = 600_000`（覆盖 `TOTAL_TIMEOUT`）。

### 改造：`scripts/providers/google.ts`

#### `buildBatchJsonl()` — 替代 `buildBatchRequestBody()`

```typescript
export function buildBatchJsonl(
  model: string,
  tasks: GenerateRequest[],
  displayName: string,
): { data: Uint8Array; keys: string[] }
```

输出 JSONL 格式（每行）：
```json
{"key":"001-sunset","request":{"contents":[{"parts":[...]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"imageSize":"2K"}}}}
```

每个 task 的序列化逻辑（base64 refs + prompt text + generationConfig）与现有 `buildBatchRequestBody()` 内部逻辑完全相同，只是输出格式从嵌套 object 变为 JSONL 行。

`buildBatchRequestBody()` 保留但不再被 `batchCreate()` 调用，供单元测试参考，后续清理。

#### `batchCreate()` — 新流程

```
buildBatchJsonl(model, tasks, displayName)
  ↓ { data, keys }
uploadJsonl(data, displayName, apiKey, baseUrl)
  ↓ "files/abc123"
POST /v1beta/models/{model}:batchGenerateContent
  body: {
    batch: {
      display_name: displayName,
      input_config: { file_name: "files/abc123" }
    }
  }
  ↓
解析响应 → BatchJob { id, state, createTime }
```

Payload 校验：移除原有 20MB 硬限制（那是 inline request 的限制，file input 上限 2GB）。改为 soft warning：JSONL 超过 50MB 时提示"Large payload ({size}MB), upload may take a while"。命令层 `batch.ts` 的估算检查同步调高阈值至 100MB。

#### `batchGet()` — 扩展

新增提取 `response.responsesFile` 字段，存入 `BatchJob.responsesFile`。

Batch job GET 响应的真实 JSON 结构（file-based 模式）：
```json
{
  "name": "batches/abc123",
  "metadata": {
    "state": "JOB_STATE_SUCCEEDED",
    "createTime": "2026-04-14T10:00:00Z",
    "totalCount": 4,
    "succeededCount": 4,
    "failedCount": 0
  },
  "response": {
    "responsesFile": "files/output456"
  }
}
```

对比 inline 模式的响应：
```json
{
  "name": "batches/abc123",
  "metadata": { "state": "JOB_STATE_SUCCEEDED", ... },
  "response": {
    "inlinedResponses": [ ... ]
  }
}
```

字段路径以 REST API 为准（`response.responsesFile`），不是 Python SDK 的 `dest.file_name`。

#### `batchFetch()` — 新流程

```
Step 1: GET /v1beta/{jobId} → 完整 batch job 响应

Step 2: 检查响应结构
  if response.responsesFile 存在:
    downloadJsonl(responsesFile, ..., onLine)
    逐行 parse → BatchResult[]
  else if response.inlinedResponses 存在:
    parseBatchResponse(response) → BatchResult[]  // fallback for old inline jobs
  else:
    throw "Batch job has no result file. Job state: {state}"
```

注意：fallback 路径直接从 Step 1 的响应中提取 `inlinedResponses`，不需要额外请求。新的 file-based job 不会进入 fallback。

#### JSONL 结果行解析

每行 JSON 包含 `key` + `response`（GenerateContentResponse）或 error：
- 有 `response.candidates` → 调用现有 `parseGenerateResponse()` → `BatchResult { key, result }`
- 有 `error` → `BatchResult { key, error: message }`
- 解析失败 → warning log，跳过该行，不中断整体流程

#### 结果完整性校验

`batchFetch()` 返回 `BatchResult[]` 后，调用方（或 `batchFetch` 内部）需校验结果完整性：
- 对比 `batch stats.total`（从 `batchGet` 获取）与实际解析的结果数
- 如果 `解析结果数 < stats.total`，输出 warning："Expected {total} results, got {actual}. {diff} results may be missing."
- 不 exit 非零（可能部分结果仍有价值），但确保用户明确知道有数据缺失
- 如果 `stats` 不可用（旧 inline job fallback），跳过此校验

### 类型变更：`scripts/providers/types.ts`

```typescript
export interface BatchJob {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
  responsesFile?: string;  // NEW: e.g. "files/abc123"
}
```

纯增量，不破坏现有消费方。

### 不变的部分

- **Provider 接口**：`batchCreate()`, `batchGet()`, `batchFetch()` 签名和返回类型不变
- **命令层**：`batch.ts` 的 `batchSubmit()`, `pollAndFetch()`, `writeResults()` 基本不变（仅调高 payload 估算阈值至 100MB）
- **Manifest 格式**：不变

### 小幅变更

- **`http.ts`**：导出 `CONNECT_TIMEOUT`、`TOTAL_TIMEOUT`、`RETRY_DELAYS_HTTP`、`RETRYABLE_HTTP` 常量（加 `export` 关键字，不改值）

### 向后兼容

已存在的旧 manifest（inline 模式创建的 job）：`batchFetch` 时如果 `responsesFile` 为空且 `inlinedResponses` 存在，走原有解析路径。不会 break 正在进行的 batch job。

## Error Handling

| 场景 | 处理 |
|------|------|
| Files API 上传失败 | 重试 3 次后抛错，包含 HTTP status 和错误消息 |
| responsesFile 为空 | 抛明确错误："Batch job has no result file. Job state: {state}" |
| 结果文件下载失败 | 重试 3 次后抛错，错误消息包含 file name |
| File ID 超 40 字符 ([#1759](https://github.com/googleapis/python-genai/issues/1759)) | 下载重试失败后抛错，消息提示 file ID 可能超限 |
| JSONL 单行解析失败 | warning log 跳过该行，不中断整体流程 |

## Testing

1. **`buildBatchJsonl()` 单元测试**：验证 JSONL 格式正确，每行可独立 `JSON.parse()`，key 格式 `{seq}-{slug}`，generationConfig 正确
2. **JSONL 行解析单元测试**：构造 success / error / malformed 行，验证 `BatchResult[]` 输出
3. **`uploadJsonl` / `downloadJsonl` 集成测试**：mock fetch，验证 resumable 两步协议 header 交互和流式读取
4. **端到端回归**：用 1 个简单文本 prompt 跑真实 batch，验证 file-based 全链路

不测：Google 服务端行为、curl proxy 路径（手动验证）。

## Data Flow Summary

```
User: bun batch submit prompts.json --outdir ./images

batchSubmit()
  ├─ Load & transform tasks → GenerateRequest[]
  ├─ buildBatchJsonl(model, tasks, displayName)
  │   └─ JSONL bytes + keys[]
  ├─ uploadJsonl(data, displayName, apiKey, baseUrl)
  │   ├─ POST /upload/v1beta/files (resumable start)
  │   ├─ PUT {uploadUrl} (upload finalize)
  │   └─ → "files/input123"
  ├─ POST /v1beta/models/{model}:batchGenerateContent
  │   body: { batch: { input_config: { file_name: "files/input123" } } }
  │   └─ → BatchJob { id: "batches/xyz", state: "pending" }
  ├─ saveManifest()
  └─ pollAndFetch()
        ├─ batchGet(jobId) → state: "succeeded", responsesFile: "files/output456"
        ├─ batchFetch(jobId)
        │   ├─ downloadJsonl("files/output456", ..., onLine)
        │   │   └─ GET /download/v1beta/files/output456:download?alt=media
        │   │       → stream JSONL lines → parse each → BatchResult[]
        │   └─ return BatchResult[]
        └─ writeResults(results, outdir, manifest)
            └─ 001-sunset.png, 002-mountain.png, ...
```
