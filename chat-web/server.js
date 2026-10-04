process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (err) => console.error('REJECTION:', err));
const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const {
  readFileSync,
  appendFileSync,
  readdirSync,
  renameSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require('fs');
const { join } = require('path');

const WORKDIR = '/workspace';
const CLAUDE_BIN = '/usr/local/bin/claude';
const PORT = 8317;
const TIMEOUT_MS = 30 * 60 * 1000;
const JOB_TTL_MS = 45 * 60 * 60 * 1000;
const MAX_RETRIES = 12;
const MAX_SESSION_CHARS = 800000;
// Retry-storm watchdog: claude CLI retries 5xx/429 errors up to 10 times with
// exponential backoff (~180s total). We cap the inner retry budget via
// ANTHROPIC_MAX_RETRIES=1 in the spawn env, so normally at most 1 api_retry
// fires. The watchdog is a backstop for the case where that cap is ignored.
// The timer starts on the first api_retry event, not on process start, so
// legitimate long requests without retries are never killed by it.
const RETRY_STORM_ATTEMPT = 2;          // abort after this many api_retry events
const RETRY_STORM_MAX_MS = 15000;       // hard ceiling after first api_retry
const DATA_DIR = '/root/.chat-web/sessions';
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_PATH = join(__dirname, 'index.html');

// ===== 模型与 token 池配置 =====
// 主模型固定 glm-5.2，每次请求轮换 token（round-robin，4 个账号 5h 窗口对齐）。
// 429 时先同模型换下一个 token，全部 token 耗尽才沿降级链切换模型。
const MODEL_CHAIN = ['glm-5.2', 'deepseek-v4-pro', 'sensenova-6.8-flash-lite'];
const MODEL_QUOTA = { 'glm-5.2': 500, 'deepseek-v4-pro': 500, 'sensenova-6.8-flash-lite': 1500 };
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5h 限流窗口
const SHORT_COOLDOWN_MS = 30 * 1000;   // empty_stream 等服务故障用 30s 短冷却
const ROTATE_DELAY_MS = 3000;         // 换 token / 降级模型重试前的小延迟

const TOKEN_POOL = (process.env.SENSENOVA_TOKENS ? process.env.SENSENOVA_TOKENS.split(',') : [
  'sk-rjSWwNOueqYfSxFUEu7fEi1mTjYjvvdQ',
  'sk-P4l1zSAGwLif4LnOzAtKhorVej5L1uT4',
  'sk-zXAlbixlfWXxXjUWRso9qC1m3DYB4ajk',
  'sk-6HqcznSf6agPXoGkh8dRvbFBWuesMxHT',
  'sk-IExrpMRrKsXBxxRCo6X62t7oviAWEeIH',
]).map(s => s.trim()).filter(Boolean);

const SENSENOVA_BASE_URL = 'https://token.sensenova.cn';
const USAGE_PATH = '/root/.chat-web/token-usage.json';

// 日志里只用掩码，避免泄露完整 key
const tokenTag = (i) => `tok#${i}(${TOKEN_POOL[i].slice(3, 7)})`;

// 每个 (token×模型) 的用量：固定 5h 窗口计数 + 429 冷却截止时间 + 连续429计数
// key: `${tokenIdx}:${model}` -> { windowStart, used, limitedUntil, consecutive429, last429At }
const usageState = new Map();
// 全局最近一次429时间，用于检测多token同时被限流的RPM尖峰
let globalLast429At = 0;
const RPM_SPIKE_WINDOW_MS = 10000;  // 10s内多个token同时429视为RPM尖峰
const RPM_SPIKE_COOLDOWN_MS = 60000; // RPM尖峰只冷却60s

function loadUsage() {
  try {
    const raw = JSON.parse(readFileSync(USAGE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) usageState.set(k, v);
    console.log(`[token] loaded usage state: ${usageState.size} entries`);
  } catch {}
}
function saveUsage() {
  try {
    ensureDataDir();
    writeFileSync(USAGE_PATH, JSON.stringify(Object.fromEntries(usageState)), 'utf8');
  } catch (e) { console.log('[token] saveUsage failed:', e.message); }
}
function usageOf(tokenIdx, model) {
  const key = tokenIdx + ':' + model;
  let st = usageState.get(key);
  const now = Date.now();
  if (!st) { st = { windowStart: now, used: 0, limitedUntil: 0, consecutive429: 0, last429At: 0 }; usageState.set(key, st); }
  if (now - st.windowStart >= WINDOW_MS) { st.windowStart = now; st.used = 0; st.limitedUntil = 0; st.consecutive429 = 0; st.last429At = 0; }
  return st;
}

let tokenCursor = 0;
// 轮换选择一个可用 token，返回索引；全部不可用返回 -1
// 注意：used 不在这里递增，只在请求成功后递增（失败不消耗额度）
function pickToken(model) {
  for (let i = 0; i < TOKEN_POOL.length; i++) {
    const idx = (tokenCursor + i) % TOKEN_POOL.length;
    const st = usageOf(idx, model);
    if (Date.now() < st.limitedUntil) continue;
    tokenCursor = (idx + 1) % TOKEN_POOL.length;
    saveUsage();
    return idx;
  }
  return -1;
}

// 收到 429：标记冷却
// 真实限流（inference exceeds / rate_limit_error）→ 根据情况决定冷却时长
//   - RPM尖峰（10s内多token同时429 或 使用量不足配额50%）→ 60s短冷却
//   - 真正配额耗尽（使用量已达配额）→ 5h长冷却 + 立即DEGRADE
// 服务故障（empty_stream / auth_unavailable）→ 30s短冷却 + 继续轮换
function markRateLimited(tokenIdx, model, text) {
  const st = usageOf(tokenIdx, model);
  const isRealRateLimit = /inference exceeds|rate_limit_error/i.test(text || '');
  const now = Date.now();
  let cooldown, reason;

  if (!isRealRateLimit) {
    cooldown = SHORT_COOLDOWN_MS;
    reason = '30s(service)';
  } else if (st.used < ((MODEL_QUOTA[model] || 500) * 0.5)) {
    // 使用量不足配额一半 → 几乎肯定是RPM瞬时超限，不是配额耗尽
    cooldown = RPM_SPIKE_COOLDOWN_MS;
    reason = '60s(rpm-spike)';
  } else if (now - globalLast429At < RPM_SPIKE_WINDOW_MS) {
    // 10s内已有其他token被429 → 全局RPM尖峰
    cooldown = RPM_SPIKE_COOLDOWN_MS;
    reason = '60s(rpm-spike-burst)';
  } else {
    // 真正的配额耗尽
    cooldown = WINDOW_MS;
    reason = '5h(quota)';
  }

  globalLast429At = now;
  st.consecutive429 = (st.consecutive429 || 0) + 1;
  st.last429At = now;
  st.limitedUntil = now + cooldown;
  if (reason.startsWith('5h')) {
    st.used = MODEL_QUOTA[model] || 500;
  }
  saveUsage();
  console.log(`[token] ${tokenTag(tokenIdx)} ${model} rate-limited, cooldown=${reason} until ${new Date(st.limitedUntil).toISOString()}`);
}

function recordModelResult(model, latencyMs, success) {
  console.log(`[model] ${model}: latency=${latencyMs}ms, success=${success}`);
}

loadUsage();

function readIndex() {
  try { return readFileSync(INDEX_PATH, 'utf8'); }
  catch (e) { return '<h1 style="padding:20px;font-family:sans-serif">index.html 读取失败: ' + e.message + '</h1>'; }
}

const jobs = new Map();
let jobCounter = 0;
let queue = Promise.resolve();

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function pathFor(key) {
  return join(DATA_DIR, key + '.jsonl');
}

function appendMessage(key, msg) {
  ensureDataDir();
  try {
    appendFileSync(pathFor(key), JSON.stringify({ ts: Date.now(), ...msg }) + '\n', 'utf8');
  } catch (e) {
    console.log('appendMessage failed', key, e.message);
  }
}

function readMessages(key) {
  const p = pathFor(key);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out;
}

function listSessions() {
  ensureDataDir();
  const res = [];
  for (const f of readdirSync(DATA_DIR)) {
    if (!f.endsWith('.jsonl') || f.startsWith('tmp-')) continue;
    const key = f.slice(0, -6);
    if (!SID_RE.test(key)) continue;
    const msgs = readMessages(key);
    if (!msgs.length) continue;
    const firstUser = msgs.find((m) => m.role === 'user');
    res.push({
      sessionId: key,
      title: ((firstUser && firstUser.text) || '(空会话)').slice(0, 40),
      updatedAt: msgs[msgs.length - 1].ts || 0,
      count: msgs.length,
    });
  }
  res.sort((a, b) => b.updatedAt - a.updatedAt);
  return res;
}

function mergeSession(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const a = pathFor(oldKey);
  const b = pathFor(newKey);
  if (!existsSync(a)) return;
  try {
    if (existsSync(b)) appendFileSync(b, readFileSync(a, 'utf8'), 'utf8');
    else renameSync(a, b);
  } catch (e) {
    console.log('mergeSession failed', oldKey, newKey, e.message);
  }
}

function isRateLimitError(text) {
  return /tpm\/rpm limit|rate.?limit|429|too.?many.?requests|inference exceeds|auth_unavailable|no auth available|model_cooldown|cooling down/i.test(text);
}

function isContextOverflowError(text) {
  // Do NOT match generic "400 ... inference" here: sensenova rate-limit errors
  // (400 ... "inference exceeds tpm/rpm limit") also contain that substring and
  // must not be treated as context overflow, otherwise the session gets wiped.
  return /prompt.*too long|context.*exceed|compaction failed|session.*already in use|no conversation found/i.test(text);
}

function compressSession(key, maxChars) {
  // 同时压缩 chat-web 和 claude 两个 session 文件
  const paths = [pathFor(key), claudeSessionPath(key)];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const size = readFileSync(p, 'utf8').length;
    if (size <= maxChars) continue;

    const lines = readFileSync(p, 'utf8').split('\n').filter(l => l.trim());

    // 智能压缩：识别 user/assistant 对话轮次，只保留最近的 N 轮
    const compressed = smartCompressLines(lines, p.endsWith('workspace'), maxChars);

    try {
      writeFileSync(p, compressed.join('\n') + '\n', 'utf8');
      console.log(`chat-web compressed ${p.slice(-30)}, ${lines.length} -> ${compressed.length} lines`);
    } catch (e) {
      console.error(`chat-web compress failed ${p}: ${e.message}`);
    }
  }
}

// 智能压缩：保留最近 N 轮完整对话，删除早期内容
function smartCompressLines(lines, isClaudeSession, maxChars) {
  // 解析消息轮次
  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // claude session 格式：{message: {role, content, ...}}
      // chat-web session 格式：{role, text, ...}
      const role = obj.message?.role || obj.role;
      const content = obj.message?.content || obj.text;

      if (role === 'user' || role === 'assistant') {
        if (currentTurn && (role === 'user' || turns.length === 0)) {
          // 开始新的一轮（user 消息或第一轮）
          turns.push(currentTurn);
        }
        currentTurn = { role, content, raw: line, time: obj.ts || obj.message?.created_at || Date.now() };
      } else if (currentTurn && currentTurn.role === 'user') {
        // assistant 的后续内容（tool_use, thinking 等）
        currentTurn.parts = currentTurn.parts || [];
        currentTurn.parts.push({ role, content, raw: line });
      }
    } catch (e) {
      // 忽略无法解析的行
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // 计算保留的轮次数（根据文件大小调整）
  const targetLines = Math.min(lines.length, Math.floor(maxChars / 10)); // 预留空间
  const turnsToKeep = Math.max(5, Math.floor(targetLines / 10)); // 至少保留 5 轮

  // 只保留最近的 turnsToKeep 轮
  const kept = turns.slice(-turnsToKeep);

  // 重组为行
  const result = [];
  for (const turn of kept) {
    result.push(turn.raw);
    if (turn.parts) {
      for (const part of turn.parts) {
        result.push(part.raw);
      }
    }
  }

  return result;
}

function claudeSessionPath(key) {
  return join('/root/.claude/projects/-workspace', key + '.jsonl');
}

function cleanClaudeSession(key) {
  const p = claudeSessionPath(key);
  if (existsSync(p)) {
    try { writeFileSync(p, '', 'utf8'); } catch {}
    console.log(`chat-web cleaned claude session ${key.slice(0,8)}`);
  }
}

function startJob(message, sessionId) {
  const jobId = ++jobCounter;
  const isExisting = SID_RE.test(sessionId || '');
  const sessionKey = isExisting ? sessionId : randomUUID();
  const job = {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    steps: [],
    current: '提交中',
    text: '',
    sessionKey,
    isError: false,
    subtype: null,
  };
  jobs.set(jobId, job);
  appendMessage(sessionKey, { role: 'user', text: message });

    let forceNew = false;
    let currentSessionKey = sessionKey;
    const argsBase = ['-p', message, '--output-format', 'stream-json', '--verbose', '--autocompact', 'auto'];
    const runClaude = (modelToUse, tokenIdx) => new Promise((resolve) => {
      const useResume = isExisting && !forceNew;
      const args = [...argsBase, ...(useResume ? ['--resume', sessionId] : ['--session-id', currentSessionKey])];
      const child = spawn(CLAUDE_BIN, args, {
        cwd: WORKDIR,
        env: {
          ...process.env,
          IS_SANDBOX: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          ANTHROPIC_MODEL: modelToUse,
          ANTHROPIC_BASE_URL: SENSENOVA_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: TOKEN_POOL[tokenIdx],
          ANTHROPIC_MAX_RETRIES: '1',
          CLAUDE_CODE_MAX_RETRIES: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    job.child = child;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Retry-storm watchdog. The ceiling clock starts on the FIRST api_retry
    // event, not on spawn, so a legitimate slow generation that never retries
    // is never killed by it. abortRetryStorm synthesises a rate-limit-like
    // result so the caller routes into the degradation chain instead of hard
    // failing the job.
    let retryEvents = 0;
    let retryStormResolved = false;
    let retryStormTimer = null;
    const abortRetryStorm = () => {
      if (retryStormResolved) return;
      retryStormResolved = true;
      if (retryStormTimer) { clearTimeout(retryStormTimer); retryStormTimer = null; }
      clearTimeout(timer);
      killChild(child);
      job.status = 'error';
      job.error = 'CLIProxyAPI 上游全部候选失败且拒绝停止重试（retry storm）';
      resolve({ code: -1, stderr, is_error: true, result_text: 'rate limit: retry storm detected' });
    };
    const armRetryStormTimer = () => {
      if (retryStormTimer) return;
      retryStormTimer = setTimeout(abortRetryStorm, RETRY_STORM_MAX_MS);
      retryStormTimer.unref?.();
    };

    const timer = setTimeout(() => {
      if (retryStormResolved) return;
      clearTimeout(retryStormTimer);
      if (job.status === 'running') {
        job.status = 'error';
        job.error = `Claude timed out after ${TIMEOUT_MS / 60000} min`;
        killChild(child);
        resolve({ code: -1, stderr });
      }
    }, TIMEOUT_MS);

    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let o;
        try { o = JSON.parse(trimmed); } catch { continue; }
        if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
          for (const x of o.message.content) {
            if (!x || typeof x !== 'object') continue;
            if (x.type === 'tool_use') {
              job.steps.push(x.name);
              job.current = `调用 ${x.name}`;
            } else if (x.type === 'text' && typeof x.text === 'string') {
              job.text += x.text;
              job.current = '生成回复中';
            }
          }
        } else if (o.type === 'system') {
          if (o.subtype === 'init') {
            job.current = '初始化';
            if (o.session_id && SID_RE.test(o.session_id) && job.sessionKey !== o.session_id) {
              job.sessionId = o.session_id;
              mergeSession(job.sessionKey, o.session_id);
              job.sessionKey = o.session_id;
            }
          } else if (o.subtype === 'thinking_tokens') job.current = '思考中';
          else if (o.subtype === 'api_retry') {
            job.current = '上游重试中';
            retryEvents++;
            armRetryStormTimer();
            if (retryEvents >= RETRY_STORM_ATTEMPT && job.status === 'running') {
              abortRetryStorm();
            }
          }
          else job.current = (o.subtype || '处理中').replace(/_/g, ' ');
        } else if (o.type === 'result') {
          job.sessionId = o.session_id ?? null;
          if (typeof o.result === 'string') job.text = o.result;
          job.isError = !!o.is_error;
          job.subtype = o.subtype ?? null;
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(retryStormTimer);
      if (retryStormResolved) return;
      resolve({ code, stderr, is_error: job.isError, result_text: job.text });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(retryStormTimer);
      if (retryStormResolved) return;
      resolve({ code: -1, stderr, error: err.message });
    });
  });

  const enqueue = () => new Promise(async (resolve) => {
    await queue;
    const run = queue.then(() => runClaude());
    queue = run.then(() => {}, () => {});
    const result = await run;
    resolve(result);
  });

  let chainIdx = 0;
  (async () => {
    try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
       const model = MODEL_CHAIN[chainIdx];
       if (!model) {
         job.status = 'error';
          job.error = 'glm/deepseek/flash-lite 全部 token 额度耗尽（5h 窗口），请稍后重试';
         console.log(`chat-web all models exhausted for ${sessionKey.slice(0,8)}`);
         break;
       }
       const tokenIdx = pickToken(model);
       if (tokenIdx === -1) {
         // 当前模型全部 token 不可用（冷却中或计数打满）→ 降级下一模型
         console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=ALL_BLOCKED | status=DEGRADE | chainIdx=${chainIdx}`);
         chainIdx++;
         continue;
       }
       if (attempt > 0) {
         job.current = `限流轮换重试 ${attempt}/${MAX_RETRIES}`;
         console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=RETRY | attempt=${attempt}`);
         await new Promise(r => setTimeout(r, ROTATE_DELAY_MS));
       } else {
         console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=START | attempt=${attempt}`);
       }
       job.status = 'running';
       job.createdAt = Date.now();
       compressSession(currentSessionKey, MAX_SESSION_CHARS);
       job.current = `${model} · ${tokenTag(tokenIdx)}`;

       const startedAt = Date.now();
       const result = await runClaude(model, tokenIdx);
       const elapsed = Date.now() - startedAt;
       const errorText = (result.result_text || '').trim()
         || (result.stderr || '').trim().split('\n').filter(l => !/^(Warning:|\[claude-code:unrecognized_model\])/i.test(l)).join('\n').trim();

        if (result.code === 0 && !result.is_error) {
          // 成功：递增已用次数
          const st = usageOf(tokenIdx, model);
          st.used++;
          st.consecutive429 = 0;
          saveUsage();
          recordModelResult(model, elapsed, true);
          console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=SUCCESS | elapsed=${elapsed}ms | used=${st.used}`);
          // 空回复视为失败，触发降级链
          if (!job.text || !job.text.trim()) {
            console.log(`chat-web ${model}: empty response, degrade to next model`);
            chainIdx++;
            continue;
          }
          break;
        }

       const isRateLimit = isRateLimitError(errorText);
       const isContextOverflow = isContextOverflowError(errorText);
       const httpCode = isRateLimit ? 429 : (isContextOverflow ? 500 : result.code || 500);

         if (isRateLimit) {
           markRateLimited(tokenIdx, model, errorText);
           // auth_unavailable / inference exceeds 等都属于不可恢复错误，立即降级
           // 只有纯粹的 empty_stream（瞬时网络中断）才重试同一模型
           const isTransient = /^empty_stream$/i.test(errorText || '');
           if (!isTransient) {
             console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=RATE_LIMIT_429 | elapsed=${elapsed}ms | action=DEGRADE | error="${(errorText||'').slice(0,80)}"`);
             console.log(`chat-web ${model}: ${isTransient ? 'transient' : 'auth/rate-limit'} error, degrade model`);
             chainIdx++;
           } else {
             console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=RATE_LIMIT_429 | elapsed=${elapsed}ms | action=RETRY_NEXT_TOKEN (transient empty_stream, 30s cooldown)`);
           }
           continue;
         }
       if (isContextOverflowError(errorText)) {
         console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=CONTEXT_OVERFLOW | elapsed=${elapsed}ms | new_session=true`);
         console.log(`chat-web context overflow for ${sessionKey.slice(0,8)}, switching to fresh session`);
        const oldFile = pathFor(sessionKey);
        if (existsSync(oldFile)) {
          try { writeFileSync(oldFile, '', 'utf8'); } catch {}
        }
        cleanClaudeSession(sessionKey);
        killChild(job.child);
        forceNew = true;
        currentSessionKey = randomUUID();
        job.sessionKey = currentSessionKey;
        appendMessage(currentSessionKey, { role: 'user', text: message });
        console.log(`chat-web context overflow: new session ${currentSessionKey.slice(0,8)}`);
        if (attempt < MAX_RETRIES) continue;
      }
       if (result.code !== 0) {
         job.status = 'error';
         job.error = (result.result_text || '').slice(0, 300)
             || errorText.slice(0, 300)
             || 'Claude 退出码 ' + result.code;
         console.log(`[REQUEST] ${new Date().toISOString()} | model=${model} | token=${tokenIdx} | status=ERROR | code=${result.code} | elapsed=${elapsed}ms`);
       }
      break;
    }

    if (job.status === 'running') {
      job.status = 'done';
      job.finishedAt = Date.now();
      job.current = '完成';
      if (job.sessionId) {
        appendMessage(job.sessionId, {
          role: 'assistant',
          text: job.text,
          isError: job.isError,
          subtype: job.subtype,
        });
      }
      console.log(`job ${jobId} done steps=${job.steps.length} ${Math.round((Date.now() - job.createdAt) / 1000)}s`);
    }
    } catch(e) { console.error("job async error:", e); }
  })();

  setTimeout(() => {
    if (job.status === 'running') jobs.delete(jobId);
  }, JOB_TTL_MS);

  return jobId;
}

function killChild(child) {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Connection': 'close',
  });
  res.end(JSON.stringify(obj));
}

function jobView(job) {
  const view = {
    id: job.id,
    status: job.status,
    elapsed: Date.now() - job.createdAt,
    steps: job.steps,
    current: job.current,
  };
  if (job.status === 'done') {
    view.result = {
      text: job.text,
      sessionId: job.sessionId,
      isError: job.isError,
      subtype: job.subtype,
    };
  } else if (job.status === 'error') {
    view.error = job.error;
  }
  // 运行中时返回已生成的部分文本
  if (job.text && job.status === 'running') {
    view.partialText = job.text;
  }
  return view;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
      const message = (parsed.message || '').trim();
      if (!message) return sendJSON(res, 400, { error: 'empty message' });
      const sessionId = parsed.sessionId || null;
      const jobId = startJob(message, sessionId);
      return sendJSON(res, 202, { jobId });
    });
    return;
  }

  const jobPath = url.pathname.match(/^\/api\/job\/(\d+)$/);
  if (jobPath) {
    const id = Number(jobPath[1]);
    const job = jobs.get(id);
    if (!job) return sendJSON(res, 404, { error: 'job not found' });
    if (req.method === 'DELETE') {
      if (job.status === 'running') {
        job.status = 'cancelled';
        job.current = '已取消';
        job.finishedAt = Date.now();
        killChild(job.child);
        console.log(`job ${id} cancelled`);
        return sendJSON(res, 200, { status: 'cancelled' });
      }
      return sendJSON(res, 200, jobView(job));
    }
    return sendJSON(res, 200, jobView(job));
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return sendJSON(res, 200, listSessions());
  }

  const sessPath = url.pathname.match(/^\/api\/session\/([0-9a-f-]+)$/i);
  if (sessPath && SID_RE.test(sessPath[1])) {
    return sendJSON(res, 200, {
      sessionId: sessPath[1],
      messages: readMessages(sessPath[1]),
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readIndex());
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`chat web listening on :${PORT}`);
});
