#!/usr/bin/env bash
#
# DeepSeek 搜索 · 一键启动脚本
#
# 功能：
#   1. 优先使用 DEEPSEEK_API_KEY 环境变量；
#   2. 否则自动读取 ~/keys（可用 KEY_FILE 指定其它路径）；
#   3. 端口被占用时自动顺延到下一个空闲端口；
#   4. 密钥只进入子进程环境变量，不会回显，也不会写入项目。
#
# 用法：
#   ./run.sh                         # 使用 ~/keys（如存在），默认从 8787 开始找空闲端口
#   PORT=8899 ./run.sh               # 指定起始端口（被占用则自动顺延）
#   KEY_FILE=/path/to/key ./run.sh   # 指定密钥文件
#   DEEPSEEK_API_KEY=sk-... ./run.sh # 直接通过环境变量提供
#
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js（建议 >= 20.12）。" >&2
  exit 1
fi

# 仅提示版本，不阻塞启动（低版本缺少个别 API 时由 server.mjs 自行报错）。
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) {
    console.error(`提示：当前 Node.js ${process.versions.node}，建议升级到 >= 20.12。`);
  }
' || true

# ---------- API Key ----------
KEY_VALUE=""
KEY_SOURCE="未配置（启动后可在页面右上角「设置」中填写）"

if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  KEY_VALUE="$DEEPSEEK_API_KEY"
  KEY_SOURCE="环境变量 DEEPSEEK_API_KEY"
else
  KEY_FILE="${KEY_FILE:-$HOME/keys}"
  if [ -f "$KEY_FILE" ]; then
    CANDIDATE="$(tr -d '\r\n' < "$KEY_FILE")"
    # 只做最小格式检查；无论是否通过，都不回显内容。
    if [ "${#CANDIDATE}" -ge 8 ] && [ "${#CANDIDATE}" -le 256 ] && [[ "$CANDIDATE" != *[[:space:]]* ]]; then
      KEY_VALUE="$CANDIDATE"
      KEY_SOURCE="${KEY_FILE}（内容不显示）"
    else
      echo "提示：$KEY_FILE 存在，但内容不像有效的 API Key，已忽略。" >&2
    fi
  elif [ -f .env ]; then
    KEY_SOURCE=".env（若其中已填写 DEEPSEEK_API_KEY）"
  else
    echo "提示：未找到 ${KEY_FILE}，启动后可在页面「设置」中填写 API Key。"
  fi
fi

# ---------- 端口 ----------
REQUESTED_PORT="${PORT:-8787}"
if ! [[ "$REQUESTED_PORT" =~ ^[0-9]+$ ]] || [ "$REQUESTED_PORT" -lt 1 ] || [ "$REQUESTED_PORT" -gt 65535 ]; then
  echo "错误：PORT 必须是 1–65535 之间的数字（当前：$REQUESTED_PORT）。" >&2
  exit 1
fi

# 让 Node 找一个可用端口；从起始端口开始，最多尝试 50 个。
PORT="$(REQUESTED_PORT="$REQUESTED_PORT" node -e '
  const net = require("node:net");
  const start = Number(process.env.REQUESTED_PORT);
  let port = start;
  let tries = 0;

  function attempt() {
    if (tries++ >= 50) {
      console.error("错误：连续 50 个端口都不可用，请通过 PORT 指定一个空闲端口。");
      process.exit(1);
    }
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      try { server.close(); } catch { /* 忽略 */ }
      port += 1;
      attempt();
    });
    server.listen(port, "127.0.0.1", () => {
      const chosen = server.address().port;
      server.close(() => console.log(chosen));
    });
  }

  attempt();
')"

if [ "$PORT" != "$REQUESTED_PORT" ]; then
  PORT_NOTE="（$REQUESTED_PORT 被占用，已自动顺延）"
else
  PORT_NOTE=""
fi

# ---------- 启动 ----------
echo ""
echo "  DeepSeek 搜索 · 本地演示"
echo "  地址：http://127.0.0.1:${PORT}${PORT_NOTE}"
echo "  密钥：${KEY_SOURCE}"
echo "  停止：Ctrl+C"
echo ""

if [ -n "$KEY_VALUE" ]; then
  export DEEPSEEK_API_KEY="$KEY_VALUE"
else
  unset DEEPSEEK_API_KEY 2>/dev/null || true
fi
export PORT

# exec 让 Node 直接接管当前终端，Ctrl+C 会正常触发 server.mjs 的优雅关闭。
exec node server.mjs
